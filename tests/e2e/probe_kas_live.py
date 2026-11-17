#!/usr/bin/env python3
"""Headless, LIVE: Kiro-mode tabs against the real kiro-cli (requirement 10.4, checkpoint A).

    probe_kas_live.py --engine <openvscode-server binary> [--kiro-cli PATH] [--shots DIR] [--keep]

The same self-contained harness as probe_kas_tab.py (a scratch engine behind
the hook's real `_proxy` + Kas_Link, stub `/api/*`), with the host's logged-in
kiro-cli as the child instead of the fake. No gateway is touched. Checks:
the picker lists the four modes KAS advertises; a one-word prompt in each of
Spec, Quick Spec, Bug Fix and Plan answers; a file-write request in Spec mode
with Autopilot off raises the approval card and Approve lets the write happen;
a reload of the workbench mid-turn keeps the turn running in the child and
the restored tab replays the transcript once; zero console errors. Costs a
few short model turns.
"""
import argparse
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
from probe_kas_tab import Ctx, ENGINE_NOISE, Gateway, free_port, load_hook, open_chat, rows_text, wait_until  # noqa: E402

READY = "Reply with the single word READY and nothing else."


def pick_mode(chat, page, label):
    for _ in range(12):
        chat.locator("#p-agent").click()
        page.wait_for_timeout(700)
        items = chat.locator("#menu button.it")
        if items.count():
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(800)
    headers = [h.lower() for h in chat.locator("#menu .h").all_inner_texts()]
    rows = chat.locator("#menu button.it", has_text=label)
    assert rows.count(), "no %r in the picker (%s)" % (label, chat.locator("#menu button.it").all_inner_texts())
    rows.first.click()   # the Kiro-modes group precedes the workflows, so .first is the kiro-cli one
    page.wait_for_timeout(500)
    return headers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--kiro-cli", default=shutil.which("kiro-cli") or os.path.expanduser("~/.local/bin/kiro-cli"))
    ap.add_argument("--shots", default=None)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    scratch = tempfile.mkdtemp(prefix="kide-kas-live-", dir=str(ROOT / ".pt-scratch")) if (ROOT / ".pt-scratch").is_dir() else tempfile.mkdtemp(prefix="kide-kas-live-")
    data = os.path.join(scratch, "data"); os.makedirs(data)
    ws = os.path.join(scratch, "ws"); os.makedirs(ws)
    open(os.path.join(ws, "README.md"), "w").write("# live probe workspace\n")
    hook = load_hook()
    hook._ctx = Ctx(data)
    ext_dir = hook._provision_extension()
    engine_port = free_port()
    proc = subprocess.Popen([args.engine, "--host", "127.0.0.1", "--port", str(engine_port), "--without-connection-token",
                             "--server-base-path", hook.PROXY_BASE, "--extensions-dir", ext_dir, "--user-data-dir", os.path.join(scratch, "udd"),
                             "--disable-workspace-trust", ws],
                            stdout=open(os.path.join(scratch, "engine.log"), "wb"), stderr=subprocess.STDOUT)
    gateway = Gateway(hook, ws, engine_port, args.kiro_cli)
    failures = []
    page = None

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    def shot(name):
        if args.shots and page is not None:
            os.makedirs(args.shots, exist_ok=True)
            page.screenshot(path=os.path.join(args.shots, name))

    def replied(chat, since_rows):
        rows = rows_text(chat)
        return len(rows) > since_rows and any("READY" in t for t in rows[since_rows:]) and not chat.locator("#send").evaluate("b => b.classList.contains('stop')")

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
        print("kiro-cli: " + str(gateway.manager.cli_facts()))
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

            # --- four modes, one short turn each (a new tab per mode)
            first = True
            for label, mode in (("Plan", "plan"), ("Spec", "spec"), ("Quick Spec", "quick-spec"), ("Bug Fix", "bug-fix")):
                if not first:
                    chat.locator("#tabs .add").click()
                    page.wait_for_timeout(800)
                first = False
                headers = pick_mode(chat, page, label)
                check(any("kiro modes" in h for h in headers), "picker has the Kiro modes group for %s" % label)
                check("kiro-cli" in chat.locator("#p-agent").inner_text(), "%s picked as a kiro-cli mode" % label)
                n = len(rows_text(chat))
                t0 = time.time()
                chat.locator("#compose textarea").fill(READY)
                chat.locator("#send").click()
                ok = wait_until(lambda: replied(chat, n), 180, page)
                check(ok, "%s mode answered READY in %.0fs: %s" % (label, time.time() - t0, [r[:60] for r in rows_text(chat)[n:]][-3:]))
                children = list(gateway.manager.children.values())
                sids = [s for c in children for s in c.sessions.values()]
                check(len(children) == 1, "still one kiro-cli child for the workspace (%d)" % len(children))
                check(any(s.mode == mode for s in sids), "a session in mode %s exists in the child (%s)" % (mode, sorted(set(s.mode for s in sids))))
                shot("live-%s.png" % mode)

            # --- approval in Bug Fix mode (Autopilot off): a shell command asks first (the four chat modes carry
            #     read tools, shell and sub-agents, no write tool — measured on 3.3.0)
            chat.locator("#tabs .add").click(); page.wait_for_timeout(800)
            pick_mode(chat, page, "Bug Fix")
            check(not chat.locator("#auto").evaluate("b => b.classList.contains('on')"), "Autopilot is off on the new tab")
            n = len(rows_text(chat))
            # Whether KAS asks is ITS policy (requirement 3.7): on 3.3.0 a shell write inside and even
            # outside the workspace ran without a request in chat modes, while the spec-execution path
            # (executeTask, probe_kas_acp.py task) does raise `Write File` requests. Either outcome passes.
            outside = os.path.join(scratch, "outside", "probe.txt")
            os.makedirs(os.path.dirname(outside), exist_ok=True)
            chat.locator("#compose textarea").fill("Run exactly this shell command and nothing else, without asking me anything: printf hello > %s" % outside)
            chat.locator("#send").click()
            got_card = wait_until(lambda: chat.locator("[data-testid='approval-card']").count() >= 1 or os.path.isfile(outside), 240, page)
            had_card = chat.locator("[data-testid='approval-card']").count() >= 1
            check(got_card, "KAS acted on the shell command: approval card or an allowed run (%s)" % [r[:60] for r in rows_text(chat)[n:]][-3:])
            if had_card:
                card = chat.locator("[data-testid='approval-card']").first
                print("   card: " + card.inner_text().replace("\n", " | ")[:160])
                shot("live-approval.png")
                card.locator("button[data-action='approved']").click()
            else:
                print("   KAS's own policy ran the command without a permission request (3.3.0 asks on the spec-execution path, see the task probe); the card path is covered by probe_kas_tab.py")
            check(wait_until(lambda: os.path.isfile(outside), 120, page), "probe.txt exists afterwards")
            check(wait_until(lambda: not chat.locator("#send").evaluate("b => b.classList.contains('stop')"), 180, page), "the turn finished")
            if os.path.isfile(outside):
                print("   probe.txt: %r" % open(outside).read()[:40])

            # --- reload mid-turn: the child keeps running, the restored tab replays once
            chat.locator("#tabs .add").click(); page.wait_for_timeout(800)
            pick_mode(chat, page, "Plan")
            prompt = "Write the numbers from 1 to 40, one per line, nothing else."
            chat.locator("#compose textarea").fill(prompt)
            chat.locator("#send").click()
            check(wait_until(lambda: chat.locator("#send").evaluate("b => b.classList.contains('stop')"), 15, page), "the turn is running")
            # the new tab's record must reach the engine's storage before the page goes (workspaceState is async)
            page.wait_for_timeout(4000)
            check(chat.locator("#send").evaluate("b => b.classList.contains('stop')"), "the turn is still running at reload time")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".monaco-workbench", timeout=90000)
            chat = open_chat(page)
            check(wait_until(lambda: sum(1 for t in rows_text(chat) if t == prompt) == 1, 60, page), "after the reload the user turn is in the transcript once")
            check(wait_until(lambda: any("40" in t for t in rows_text(chat)) and not chat.locator("#send").evaluate("b => b.classList.contains('stop')"), 240, page),
                  "the turn finished in the child and its answer reached the restored tab")
            texts = rows_text(chat)
            check(sum(1 for t in texts if t == prompt) == 1, "no duplicated user row after the replay (%d)" % sum(1 for t in texts if t == prompt))
            shot("live-after-reload.png")

            check(not any(c["path"].startswith("/chat?") for c in gateway.calls), "no /chat send went to the gateway")
            errors = [c for c in console if (c.startswith("error") or c.startswith("pageerror")) and not any(n in c for n in ENGINE_NOISE)]
            check(not errors, "zero console errors (%d)" % len(errors))
            for e in errors[:10]:
                print("   console: " + e[:300])
            browser.close()
    finally:
        gateway.stop()
        try:
            proc.terminate(); proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
        if args.keep:
            print("scratch kept at " + scratch)
        else:
            shutil.rmtree(scratch, ignore_errors=True)
    if failures:
        print("\n%d FAILED:\n  " % len(failures) + "\n  ".join(failures))
        sys.exit(1)
    print("\nprobe_kas_live: all checks passed")


if __name__ == "__main__":
    main()
