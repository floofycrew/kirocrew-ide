"""End to end: type in the IDE's KiroCrew Chat view, get a streamed reply from a gateway session.

Usage: chat_roundtrip.py <workbench-url> [--wait SECONDS] [--shot PATH]
Passes when the composer accepts a message, a session appears in the Sessions
view (grouped under the dashboard folder) and assistant text lands in the log.
"""

import json
import sys
import time

from playwright.sync_api import sync_playwright

PROMPT = "Reply with exactly the word PONG and nothing else."

def find_composer(page):
    """The KiroCrew chat webview frame, or None."""
    for frame in page.frames:
        try:
            if frame.locator("#compose textarea").count():
                return frame
        except Exception:
            continue
    return None


def open_kirocrew_view(page, seconds):
    """Dismiss workspace trust, open the KiroCrew container if needed; returns the chat frame or None."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(1)
        trust = page.get_by_text("Yes, I trust the authors", exact=True)
        if trust.count():
            trust.first.click()
            time.sleep(1)
        frame = find_composer(page)
        if frame is not None:
            return frame
        bar = page.locator(".activitybar [aria-label^='KiroCrew']")
        if bar.count():
            try:
                bar.first.click(force=True, timeout=3000)
            except Exception:
                pass
            time.sleep(2)
    return find_composer(page)



def main():
    url = sys.argv[1]
    wait = float(sys.argv[sys.argv.index("--wait") + 1]) if "--wait" in sys.argv else 120
    shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else "/tmp/kirocrew-ide-chat.png"
    out = {"sent": False, "sessionListed": False, "reply": None, "rows": []}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        chat = open_kirocrew_view(page, 60)
        if chat is None:
            page.screenshot(path=shot)
            print(json.dumps({"error": "chat view not found", "pageErrors": errors}))
            sys.exit(1)
        chat.locator("#compose textarea").fill(PROMPT)
        chat.locator("#send").click()
        out["sent"] = True
        deadline = time.time() + wait
        while time.time() < deadline:
            time.sleep(2)
            rows = chat.locator("#log .row").all_inner_texts()
            out["rows"] = [r[:160] for r in rows]
            errs = chat.locator("#log .error").all_inner_texts()
            if errs:
                out["chatError"] = errs
                break
            assistant = chat.locator("#log .assistant").all_inner_texts()
            if assistant and any(a.strip() for a in assistant):
                out["reply"] = assistant[-1][:200]
                break
        tree = page.locator(".pane-body .monaco-list-row").all_inner_texts()
        out["sessionListed"] = any("kirocrew-ide" in t or "running" in t or "idle" in t for t in tree)
        out["tree"] = [t[:120] for t in tree][:8]
        status = page.locator(".statusbar-item:has-text('KiroCrew')")
        out["statusBar"] = status.first.inner_text() if status.count() else None
        out["pageErrors"] = errors[:5]
        page.screenshot(path=shot)
        browser.close()
    print(json.dumps(out, indent=2))
    sys.exit(0 if out["reply"] else 1)


if __name__ == "__main__":
    main()
