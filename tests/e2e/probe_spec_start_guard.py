"""Headless, real engine: one spec chat per click.

    probe_spec_start_guard.py --engine <openvscode-server binary> [--shots DIR]

The harness of probe_review_comments.py: a scratch engine with both extensions, a
scratch workspace with `.kiro/specs/demo`, Playwright routing standing in for the
gateway on `/api/*`. The fake gateway answers POST /chat/slots (the session mint)
only after SLOW_MS, the way a loaded host makes a Specs action feel: nothing
would happen for seconds and a second click used to start a second chat. (The
ASYNC Playwright API: a route handler that sleeps must not stall the driver, or
the "second click" lands after the hold and proves nothing.)

* `KiroCrew Spec: Run all tasks` is run twice 400 ms apart through the command
  palette (the keybinding and the title-bar button reach the same command):
  ONE session is minted, ONE turn posted, ONE user bubble drawn, ONE chat tab
  beyond the empty default;
* the bubble ("Run all tasks") is on screen BEFORE the mint answers (drawn
  ahead of the session), the Specs row spins with "starting: Run all tasks…"
  while the start is held, the progress toast "KiroCrew: starting Run all
  tasks…" is up, and the second click left its status-bar note;
* after the start the row is plain again, the toast gone, and a third run
  mints a second session: the hold ends with the work;
* zero console errors (engine-only noise aside).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
from probe_review_comments import ENGINE_NOISE  # noqa: E402
from probe_spec_editor import DESIGN_MD, free_port, provision  # noqa: E402

SLOW_MS = 3000
PALETTE_TITLE = "KiroCrew Spec: Run all tasks"


def fake_gateway(calls, keys):
    """An async page.route handler: probe_review_comments' gateway with a slow session mint (one key per mint)."""
    async def handle(route, request):
        path = request.url.split("/api", 1)[1]
        body = None
        try:
            body = json.loads(request.post_data) if request.post_data else None
        except ValueError:
            body = {"raw": request.post_data}
        calls.append({"method": request.method, "path": path, "body": body, "at": time.time()})
        if request.method == "POST" and path == "/chat/slots":
            key = "kirocrew-ide-guard-probe-%d" % (len(keys) + 1)
            keys.append(key)
            await asyncio.sleep(SLOW_MS / 1000)
            reply = {"key": key}
        elif request.method == "POST" and path.startswith("/chat?"):
            reply = {"ok": True}
        elif request.method == "GET":
            reply = []
        else:
            reply = {}
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(reply))
    return handle


async def wait_until(fn, timeout, step=0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if await fn():
                return True
        except Exception:
            pass
        await asyncio.sleep(step)
    return False


async def run_palette(page, title):
    """Run the command titled `title` through the palette: type it, click the row with exactly that label."""
    await page.keyboard.press("F1")
    await page.wait_for_selector(".quick-input-widget input", timeout=10000)
    await page.fill(".quick-input-widget input", ">" + title)
    await page.wait_for_timeout(250)
    row = page.locator(".quick-input-list .monaco-list-row .label-name", has_text=title).filter(has_text=title)
    exact = None
    for i in range(await row.count()):
        if (await row.nth(i).inner_text()).strip() == title:
            exact = row.nth(i); break
    if exact is None:
        raise AssertionError("palette has no row titled %r" % title)
    await exact.click()


async def show_kirocrew(page):
    """The KiroCrew container in the primary side bar (a click on its icon toggles, so look first)."""
    for _ in range(3):
        shown = await page.evaluate("""() => {
          const side = document.querySelector('.part.sidebar');
          if (!side || side.offsetWidth < 50) return false;
          const t = side.querySelector('.title-label, .composite.title h2');
          return !!(t && /kirocrew/i.test(t.textContent || ''));
        }""")
        if shown:
            return True
        bar = page.locator(".activitybar [aria-label^='KiroCrew']")
        if await bar.count():
            await bar.first.click(force=True)
        await page.wait_for_timeout(1500)
    return False


async def main_async(args):
    from playwright.async_api import async_playwright

    scratch = tempfile.mkdtemp(prefix="kide-guard-probe-")
    data = os.path.join(scratch, "data"); os.makedirs(data)
    ws = os.path.join(scratch, "ws"); spec_dir = os.path.join(ws, ".kiro", "specs", "demo"); os.makedirs(spec_dir)
    open(os.path.join(ws, "README.md"), "w").write("# readme\n")
    open(os.path.join(spec_dir, "requirements.md"), "w").write("# Requirements\n\n1. It works.\n")
    open(os.path.join(spec_dir, "design.md"), "w").write(DESIGN_MD)
    open(os.path.join(spec_dir, "tasks.md"), "w").write("# Implementation Plan\n\n- [ ] 1. Open task\n- [ ] 2. Second task\n")
    ext_dir = provision(data, None)
    port = free_port()
    proc = subprocess.Popen([args.engine, "--host", "127.0.0.1", "--port", str(port), "--without-connection-token",
                             "--extensions-dir", ext_dir, "--user-data-dir", os.path.join(scratch, "udd"), "--disable-workspace-trust", ws],
                            stdout=open(os.path.join(scratch, "engine.log"), "wb"), stderr=subprocess.STDOUT)
    failures = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise AssertionError("engine did not open its port")
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page(viewport={"width": 1400, "height": 900})
            console = []
            page.on("console", lambda m: console.append("%s: %s @%s" % (m.type, m.text, (m.location or {}).get("url", ""))))
            page.on("pageerror", lambda e: console.append("pageerror: %s" % e))
            calls, keys = [], []
            await page.route("http://127.0.0.1:%d/api/**" % port, fake_gateway(calls, keys))

            async def shot(name):
                if args.shots:
                    os.makedirs(args.shots, exist_ok=True); await page.screenshot(path=os.path.join(args.shots, name))

            async def find_chat():
                for f in page.frames:
                    try:
                        if await f.locator("#compose").count():
                            return f
                    except Exception:
                        continue
                return None

            async def spec_row_text():
                rows = page.locator(".part.sidebar .monaco-list-row", has_text="demo")
                if not await rows.count():
                    return None
                return await rows.first.inner_text()

            async def spec_row_spins():
                rows = page.locator(".part.sidebar .monaco-list-row", has_text="demo")
                return bool(await rows.count()) and bool(await rows.first.locator(".codicon-loading").count())

            await page.goto("http://127.0.0.1:%d/?folder=%s" % (port, ws), wait_until="domcontentloaded")
            await page.wait_for_selector(".monaco-workbench", timeout=90000)
            await page.wait_for_timeout(6000)
            trust = page.locator(".monaco-dialog-box a.monaco-button", has_text="trust the authors")
            if await trust.count():
                await trust.first.click(); await page.wait_for_timeout(1500)
            check(await show_kirocrew(page), "the KiroCrew container is in the side bar")
            check(await wait_until(lambda: spec_row_text(), 20), "the Specs view lists the demo spec")
            await shot("guard-0-specs.png")

            # --- two Run all tasks 400 ms apart
            t0 = time.time()
            await run_palette(page, PALETTE_TITLE)
            await page.wait_for_timeout(400)
            await run_palette(page, PALETTE_TITLE)
            await page.wait_for_timeout(700)
            elapsed = time.time() - t0
            chat = await find_chat()
            check(chat is not None, "the chat view opened")
            early_bubbles = await chat.locator(".row.user").count() if chat else 0
            minted_early = any(c["method"] == "POST" and c["path"] == "/chat/slots" for c in calls)
            answered = elapsed >= SLOW_MS / 1000
            check(early_bubbles == 1 and not answered, "one user bubble is on screen before the session mint answers (%d bubble(s), %.1fs in)" % (early_bubbles, elapsed))
            check(minted_early, "the mint request is in flight")
            row_text = (await spec_row_text()) or ""
            check("starting" in row_text.lower() and await spec_row_spins(), "the Specs row spins and reads 'starting: …' during the hold (%r)" % row_text)
            toast = page.locator(".notifications-toasts .notification-list-item-message", has_text="starting Run all tasks")
            check(await toast.count() >= 1, "the progress toast 'KiroCrew: starting Run all tasks…' is up")
            status = page.locator(".statusbar-item", has_text="second click was ignored")
            check(await status.count() >= 1, "the second click left the status-bar note")
            await shot("guard-1-during.png")

            # --- after the mint: one session, one turn, one bubble, the hold released
            async def one_turn():
                return any(c["method"] == "POST" and c["path"].startswith("/chat?") for c in calls)
            sent = await wait_until(one_turn, 20)
            await page.wait_for_timeout(800)
            mints = [c for c in calls if c["method"] == "POST" and c["path"] == "/chat/slots"]
            turns = [c for c in calls if c["method"] == "POST" and c["path"].startswith("/chat?")]
            check(sent and len(mints) == 1, "ONE session minted for two clicks (%d)" % len(mints))
            check(len(turns) == 1, "ONE turn posted (%d)" % len(turns))
            bubbles = await chat.locator(".row.user").evaluate_all("els => els.map(e => e.textContent.trim())") if chat else []
            check(len(bubbles) == 1 and bubbles[0].startswith("Run all tasks"), "ONE user bubble, the display text (%s)" % bubbles)
            tabs = await chat.locator("#tabs .tab").count() if chat else -1
            check(tabs == 2, "one chat tab beyond the empty default (%d)" % tabs)
            async def row_plain():
                text = (await spec_row_text()) or ""
                return "starting" not in text.lower()
            check(await wait_until(row_plain, 10), "the Specs row stops spinning once the start is through")
            check(await wait_until(lambda: _gone(page), 10), "the progress toast is gone")
            await shot("guard-2-after.png")

            # --- the spec can start again: a third click mints a second session
            await run_palette(page, PALETTE_TITLE)
            async def two_mints():
                return len([c for c in calls if c["method"] == "POST" and c["path"] == "/chat/slots"]) == 2
            check(await wait_until(two_mints, 15), "a click after the hold starts a new chat (second mint)")
            if len([c for c in calls if c["method"] == "POST" and c["path"] == "/chat/slots"]) != 2:
                notes = await page.locator(".notifications-toasts .notification-list-item-message").all_inner_texts()
                sb = await page.locator(".statusbar-item", has_text="KiroCrew").all_inner_texts()
                print("    (mints: %d; toasts: %s; status bar: %s; calls since: %s)" % (len([c for c in calls if c["method"] == "POST" and c["path"] == "/chat/slots"]), notes, sb, [c["path"] for c in calls[-6:]]))
                await shot("guard-3-third.png")

            noise = [l for l in console if l.startswith("error") or l.startswith("pageerror")]
            noise = [l for l in noise if not any(n in l for n in ENGINE_NOISE)]
            check(not noise, "no console errors (%s)" % noise[:3])
            await browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()
    print("ALL OK" if not failures else "FAILED: %d" % len(failures))
    return 0 if not failures else 1


async def _gone(page):
    return (await page.locator(".notifications-toasts .notification-list-item-message", has_text="starting Run all tasks").count()) == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--shots", default=None)
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
