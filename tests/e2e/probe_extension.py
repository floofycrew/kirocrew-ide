"""Drive the workbench headlessly and check the KiroCrew bridge extension activates.

Usage: probe_extension.py <workbench-url> [--wait SECONDS] [--shot PATH]
The engine port is reached over an ssh -L tunnel set up by the caller. Passes
when the KiroCrew activity-bar container exists and its Chat webview renders
the composer; prints console lines mentioning kirocrew.
"""

import json
import sys
import time

from playwright.sync_api import sync_playwright


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
    wait = float(sys.argv[sys.argv.index("--wait") + 1]) if "--wait" in sys.argv else 40
    shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else "/tmp/kirocrew-ide-probe.png"
    lines = []
    result = {"container": False, "chatView": False, "composer": False, "statusBar": None}
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("console", lambda m: lines.append("[%s] %s" % (m.type, m.text)))
        page.on("pageerror", lambda e: lines.append("[pageerror] %s" % e))
        page.goto(url, wait_until="domcontentloaded")
        frame = open_kirocrew_view(page, wait)
        result["container"] = page.locator(".activitybar [aria-label^='KiroCrew']").count() > 0
        result["chatView"] = result["composer"] = frame is not None
        status = page.locator(".statusbar-item:has-text('KiroCrew')")
        result["statusBar"] = status.first.inner_text() if status.count() else None
        page.screenshot(path=shot)
        browser.close()
    interesting = ("kirocrew", "pageerror", "service worker", "serviceworker", "webview", "[error]")
    result["console"] = [l for l in lines if any(k in l.lower() for k in interesting)][:15]
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["container"] and result["composer"] else 1)


if __name__ == "__main__":
    main()
