#!/usr/bin/env python3
"""Headless: a Kiro-mode tab end to end against a fake KAS (requirement 10.3, checkpoint A).

    probe_kas_tab.py --engine <openvscode-server binary> [--shots DIR] [--keep]

Self-contained: a scratch engine (its own user-data and extensions dirs, this
checkout's bridge provisioned by the hook's own code) runs behind a local
aiohttp app that is the hook's real `_proxy`, Kas_Link and `kas/*` routes with
`tests/e2e/fake_kas.py` as kiro-cli, plus the handful of `/api/*` routes the
bridge calls at startup (empty rosters, a quiet `/api/ws`). Playwright opens the
workbench THROUGH the proxy (the bridge's origin is the app, as on a dashboard)
and drives the chat view: pick Plan from the Kiro-modes group, send, see the
streamed chunks and the tool row, approve the permission card, answer a
question card, reload the workbench and see the transcript replayed without
duplicates, stop a slow turn, and watch the hook spawn a fresh child after the
first is killed. Zero console errors is part of the verdict.

Needs: Playwright with Chromium, aiohttp (the FloofyCrew venv has both).
"""
import argparse
import asyncio
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # never leave hook/__pycache__ behind (it would be hashed into the manifest)
FAKE = str(HERE / "fake_kas.py")
ENGINE_NOISE = ("/node_modules/vsda/", "[DEP0040] DeprecationWarning: The `punycode`", "open-vsx.org/vscode/gallery/",
                "marketplace.visualstudio.com", "Failed to load resource", "/api/ws", "WebSocket connection to", "the server responded with a status of 404",
                "[Extension Host] ", "vscode-userdata", "Long running operations during shutdown", "net::ERR_", "ResizeObserver")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kide_hook_kas_probe", str(ROOT / "hook" / "__init__.py"))
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


class Ctx:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.config = _Config()
        self.state = {}
        self.log = _Log()


class _Config(dict):
    def get(self, key, default=None):
        return dict.get(self, key, default)

    def set(self, key, value):
        self[key] = value


class _Log:
    def __init__(self):
        self.lines = []

    def __getattr__(self, level):
        return lambda msg, *args, **_k: self.lines.append((level, msg % args if args else msg))


class Gateway:
    """The local stand-in for the dashboard: the hook's proxy + Kas_Link + kas routes, and stub /api/*."""

    def __init__(self, hook, ws, engine_port, kiro_cli):
        self.hook = hook
        self.ws = ws
        self.engine_port = engine_port
        self.kiro_cli = kiro_cli
        self.port = free_port()
        self.calls = []
        self.loop = None
        self.thread = None
        self.runner = None
        self.manager = None

    def start(self):
        ready = threading.Event()

        def run():
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(self._serve(ready))
            self.loop.run_forever()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        if not ready.wait(15):
            raise AssertionError("gateway stand-in did not start")

    async def _serve(self, ready):
        from aiohttp import web
        hook = self.hook
        hook._engine_origin = lambda: "http://127.0.0.1:%d" % self.engine_port
        hook._live_state = lambda: {"pid": os.getpid(), "port": self.engine_port, "folder": self.ws, "workspaces": [self.ws], "proxied": True}
        self.manager = hook._kas_manager()
        self.manager.which = lambda name: self.kiro_cli if name == "kiro-cli" else None
        mod_api = "/api/apps/floofycrew/mods/kirocrew-ide/api/"

        async def api(request):
            path = request.path[len("/api"):]
            body = None
            if request.can_read_body:
                try:
                    body = await request.json()
                except Exception:  # noqa: BLE001
                    body = None
            self.calls.append({"method": request.method, "path": path, "body": body})
            if path.startswith(mod_api[len("/api"):]):
                sub = path[len(mod_api) - len("/api"):]
                if sub == "kas/status":
                    return web.json_response(await asyncio.get_running_loop().run_in_executor(None, self.manager.status))
                if sub == "kas/sessions":
                    return web.json_response(hook.kas.sessions_route(self.manager))
                if sub.startswith("kas/sessions/") and sub.endswith("/transcript"):
                    return web.json_response(hook.kas.transcript_route(self.manager, sub.split("/")[2]))
                if sub == "kas/tasks":
                    out = hook.kas.tasks_route(self.manager, request.query.get("folder", ""), request.query.get("feature", ""))
                    return web.json_response(out[1], status=out[0]) if isinstance(out, tuple) else web.json_response(out)
                if sub == "theme":
                    return web.json_response({"scheme": "dark"})
                return web.json_response({})
            if path == "/ws":
                ws = web.WebSocketResponse()
                await ws.prepare(request)
                async for _ in ws:
                    pass
                return ws
            if request.method == "POST" and path == "/chat/folders":
                return web.json_response({"id": "folder-1", "name": (body or {}).get("name") or "KiroCrew IDE"})
            if request.method == "GET" and path in ("/chat/folders", "/chat/slots", "/agents", "/agents/installed", "/models", "/effort-levels"):
                return web.json_response([])
            return web.json_response({})

        app = web.Application()
        app.router.add_route("*", "/api/{path:.*}", api)
        app.router.add_route("*", hook.PROXY_BASE, hook._proxy_trampoline)
        app.router.add_route("*", hook.PROXY_BASE + "/{path:.*}", hook._proxy_trampoline)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", self.port)
        await site.start()
        ready.set()

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(30)

    def stop(self):
        if self.loop and self.manager:
            try:
                self.run(self.manager.stop_all())
            except Exception:  # noqa: BLE001
                pass
        if self.loop:
            self.loop.call_soon_threadsafe(self.loop.stop)


def wait_until(fn, timeout, page, step=250):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn():
                return True
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(step)
    return False


def find_chat(page):
    for frame in page.frames:
        try:
            if frame.locator("#compose textarea").count():
                return frame
        except Exception:  # noqa: BLE001
            continue
    return None


def open_chat(page, seconds=90):
    deadline = time.time() + seconds
    while time.time() < deadline:
        page.wait_for_timeout(1000)
        trust = page.locator(".monaco-dialog-box a.monaco-button", has_text="trust the authors")
        if trust.count():
            trust.first.click()
            page.wait_for_timeout(1000)
        frame = find_chat(page)
        if frame is not None:
            return frame
        bar = page.locator(".activitybar [aria-label^='KiroCrew']")
        if bar.count():
            try:
                bar.first.click(force=True, timeout=3000)
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(2000)
    raise AssertionError("the KiroCrew chat view did not appear")


def rows_text(chat):
    """The rows of the ACTIVE tab's pane (one `.log` per tab under #panes; only the shown one is `.on`)."""
    return [t.strip() for t in chat.locator("#panes .log.on .row").all_inner_texts()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--shots", default=None)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    scratch = tempfile.mkdtemp(prefix="kide-kas-probe-", dir=str(ROOT / ".pt-scratch")) if (ROOT / ".pt-scratch").is_dir() else tempfile.mkdtemp(prefix="kide-kas-probe-")
    data = os.path.join(scratch, "data"); os.makedirs(data)
    ws = os.path.join(scratch, "ws"); os.makedirs(ws)
    open(os.path.join(ws, "README.md"), "w").write("# probe workspace\n")
    os.environ["FAKE_KAS_STATE"] = os.path.join(scratch, "fake-state")
    kiro_cli = os.path.join(scratch, "kiro-cli")
    with open(kiro_cli, "w") as fh:
        fh.write("#!/bin/sh\nexec %s %s \"$@\"\n" % (sys.executable, FAKE))
    os.chmod(kiro_cli, os.stat(kiro_cli).st_mode | stat.S_IEXEC)

    hook = load_hook()
    hook._ctx = Ctx(data)
    ext_dir = hook._provision_extension()
    assert ext_dir, "provisioning the bridge failed"
    engine_port = free_port()
    proc = subprocess.Popen([args.engine, "--host", "127.0.0.1", "--port", str(engine_port), "--without-connection-token",
                             "--server-base-path", hook.PROXY_BASE, "--extensions-dir", ext_dir, "--user-data-dir", os.path.join(scratch, "udd"),
                             "--disable-workspace-trust", ws],
                            stdout=open(os.path.join(scratch, "engine.log"), "wb"), stderr=subprocess.STDOUT)
    gateway = Gateway(hook, ws, engine_port, kiro_cli)
    failures = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    page = None

    def shot(name):
        if args.shots and page is not None:
            os.makedirs(args.shots, exist_ok=True)
            page.screenshot(path=os.path.join(args.shots, name))

    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", engine_port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise AssertionError("engine did not open its port")
        gateway.start()
        url = "http://127.0.0.1:%d%s/?folder=%s" % (gateway.port, hook.PROXY_BASE, ws)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            console = []
            page.on("console", lambda m: console.append("%s: %s @%s" % (m.type, m.text, (m.location or {}).get("url", ""))))
            page.on("pageerror", lambda e: console.append("pageerror: %s" % e))
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_selector(".monaco-workbench", timeout=90000)
            chat = open_chat(page)
            page.wait_for_timeout(1500)

            # --- the picker shows the Kiro modes group from kas/status (the first click may only
            #     request the choices; retry until the menu has rows)
            menu_items, headers = [], []
            for _ in range(12):
                chat.locator("#p-agent").click()
                page.wait_for_timeout(700)
                menu_items = chat.locator("#menu button.it").all_inner_texts()
                headers = chat.locator("#menu .h").all_inner_texts()
                if menu_items:
                    break
                page.keyboard.press("Escape")
                page.wait_for_timeout(800)
            check(any("kiro modes" in h.lower() for h in headers), "picker has the Kiro modes group (headers: %s)" % headers)
            check(any(t.startswith("Plan") for t in menu_items) and any(t.startswith("Spec") for t in menu_items), "Plan and Spec listed (%d items)" % len(menu_items))
            kas_rows = chat.locator("#menu button.it", has_text="Plan")
            # The Kiro-modes Plan comes first (the group precedes the workflows); click it.
            kas_rows.first.click()
            page.wait_for_timeout(600)
            check("kiro-cli" in chat.locator("#p-agent").inner_text(), "the agent pick reads Plan · kiro-cli (%s)" % chat.locator("#p-agent").inner_text())
            check("kiro-cli" in chat.locator("#hint").inner_text(), "the hint says the tab will run in kiro-cli")
            shot("kas-01-pick.png")

            # --- first send: new session + prompt; chunks stream; the notice is said once
            chat.locator("#compose textarea").fill("hello from the probe")
            chat.locator("#send").click()
            check(wait_until(lambda: any("Echo (plan): hello from the probe" in t for t in rows_text(chat)), 60, page), "the streamed answer landed: %s" % rows_text(chat)[-3:])
            check(any("Kiro's own engine" in t for t in rows_text(chat)), "the once-per-tab notice is in the transcript")
            check(wait_until(lambda: not chat.locator("#send").evaluate("b => b.classList.contains('stop')"), 15, page), "the pane is released after turnEnd (send button back)")
            texts = rows_text(chat)
            check(texts.count("hello from the probe") == 1, "the user bubble appears once (local draw, KAS echo consumed): %d" % texts.count("hello from the probe"))
            check(len(gateway.manager.children) == 1, "the hook spawned one kiro-cli child")
            child = list(gateway.manager.children.values())[0]
            sid = list(child.sessions)[0]
            check(child.sessions[sid].mode == "plan", "the session runs in plan mode (%s)" % child.sessions[sid].mode)
            check("Kiro-mode session" in chat.locator("#hint").inner_text(), "the hint names the Kiro-mode session")
            shot("kas-02-first-turn.png")

            # --- permission card: approve → tool row completes
            chat.locator("#compose textarea").fill("this needs permission")
            chat.locator("#send").click()
            check(wait_until(lambda: chat.locator("[data-testid='approval-card']").count() == 1, 30, page), "one approval card for the Write File request (bursts collapse)")
            card = chat.locator("[data-testid='approval-card']")
            check("Write File" in card.inner_text(), "the card names the tool: %s" % card.inner_text()[:80])
            card.locator("button[data-action='approved']").click()
            check(wait_until(lambda: any("permission=granted" in t for t in rows_text(chat)), 30, page), "the turn continued after Approve (permission=granted)")
            check(wait_until(lambda: chat.locator("#panes .log.on .row.tool.call").count() >= 1, 10, page), "a tool row was drawn for the call")
            shot("kas-03-approved.png")

            # --- question card (userInput): pick Beta
            chat.locator("#compose textarea").fill("ask me something")
            chat.locator("#send").click()
            check(wait_until(lambda: chat.locator("#panes .log.on .row.question").count() == 1, 30, page), "a question card for _kiro/userInput")
            chat.locator("#panes .log.on .row.question button.opt", has_text="Beta").click()
            check(wait_until(lambda: any("answered=Beta" in t for t in rows_text(chat)), 30, page), "the answer reached KAS (answered=Beta)")
            check(chat.locator("#panes .log.on .row.question").count() == 0, "the question card is gone once answered")

            # --- stop a slow turn → cancelled
            chat.locator("#compose textarea").fill("slow turn please")
            chat.locator("#send").click()
            check(wait_until(lambda: chat.locator("#send").evaluate("b => b.classList.contains('stop')"), 10, page), "Stop is offered while the turn runs")
            page.wait_for_timeout(900)
            chat.locator("#send").click()
            check(wait_until(lambda: any("Turn ended: cancelled" in t for t in rows_text(chat)), 30, page), "Stop → session/cancel → stopReason cancelled")
            before_reload = rows_text(chat)
            n_user_before = sum(1 for t in before_reload if t in ("hello from the probe", "this needs permission", "ask me something", "slow turn please"))
            errors_before = [c for c in console if (c.startswith("error") or c.startswith("pageerror")) and not any(n in c for n in ENGINE_NOISE)]

            # --- reload the workbench: the tab comes back and attaches, replay without duplicates
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".monaco-workbench", timeout=90000)
            chat = open_chat(page)
            check(wait_until(lambda: sum(1 for t in rows_text(chat) if t == "hello from the probe") == 1 and any("Turn ended: cancelled" in t for t in rows_text(chat)), 60, page), "after reload the transcript is replayed from the hook's buffer")
            after = rows_text(chat)
            n_user_after = sum(1 for t in after if t in ("hello from the probe", "this needs permission", "ask me something", "slow turn please"))
            check(n_user_after == n_user_before == 4, "every user turn appears exactly once after the replay (%d before, %d after)" % (n_user_before, n_user_after))
            check(sum(1 for t in after if "Echo (plan): hello from the probe" in t) == 1, "no duplicated assistant rows")
            check(chat.locator("[data-testid='approval-card']").count() == 0, "no stale approval card after the replay (it was answered)")
            check("Kiro-mode session" in chat.locator("#hint").inner_text(), "the restored tab knows its Kiro-mode session")
            shot("kas-04-after-reload.png")

            # --- a prompt after the reload still works (attach kept the link)
            chat.locator("#compose textarea").fill("after reload")
            chat.locator("#send").click()
            check(wait_until(lambda: any("Echo (plan): after reload" in t for t in rows_text(chat)), 60, page), "a turn after the reload streams")

            # --- kill the child: the tab shows the exit and a Reload button; Reload brings a fresh child + session/load
            old_pid = child.client.pid
            os.kill(old_pid, signal.SIGKILL)
            check(wait_until(lambda: chat.locator("[data-testid='run-card']").count() >= 1 and any("kiro-cli exited" in t for t in rows_text(chat)), 30, page), "the child's exit is reported with a Reload card")
            shot("kas-05-exited.png")
            chat.locator("[data-testid='run-card'] button.resume").click()
            check(wait_until(lambda: len(gateway.manager.children) == 1 and list(gateway.manager.children.values())[0].client.pid != old_pid and list(gateway.manager.children.values())[0].ready, 30, page), "Reload spawned a fresh kiro-cli child")
            check(wait_until(lambda: sum(1 for t in rows_text(chat) if t == "hello from the probe") == 1 and any("Echo (plan): after reload" in t for t in rows_text(chat)), 30, page), "session/load replayed the history into the tab (clear first, no duplicates)")
            chat.locator("#compose textarea").fill("after the new child")
            chat.locator("#send").click()
            check(wait_until(lambda: any("Echo (plan): after the new child" in t for t in rows_text(chat)), 60, page), "the loaded session answers prompts again")
            shot("kas-06-reloaded.png")

            # --- nothing was sent to the gateway's chat routes for this tab
            check(not any(c["path"].startswith("/chat?") for c in gateway.calls), "no /chat send went to the gateway (the tab ran in KAS)")
            errors = [c for c in console if (c.startswith("error") or c.startswith("pageerror")) and not any(n in c for n in ENGINE_NOISE)]
            check(not errors, "zero console errors (%d)" % len(errors))
            for e in errors[:10]:
                print("   console: " + e[:300])
            browser.close()
    finally:
        gateway.stop()
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
        if args.keep:
            print("scratch kept at " + scratch)
        else:
            shutil.rmtree(scratch, ignore_errors=True)
    if failures:
        print("\n%d FAILED:\n  " % len(failures) + "\n  ".join(failures))
        sys.exit(1)
    print("\nprobe_kas_tab: all checks passed")


if __name__ == "__main__":
    main()
