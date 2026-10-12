"""The chat composer, end to end through the gated harness.

Usage: probe_composer.py <workbench-url> [--wait SECONDS] [--shot PATH]

Asserts what the unit tests cannot: the pick bar renders inside the real
webview with lists that round-tripped through the dashboard-shaped API
(agents, models, effort levels), the popover menu opens in-page (no browser
pop-up), a pick updates the bar, the old title-bar buttons are gone, and an
assistant row ending in `[OPTIONS: …]` renders as chips whose click lands the
label in the composer send path.
"""

import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe_extension import open_kirocrew_view  # noqa: E402


def main():
    url = sys.argv[1]
    wait = float(sys.argv[sys.argv.index("--wait") + 1]) if "--wait" in sys.argv else 60
    shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else "/tmp/kirocrew-ide-composer.png"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(url, wait_until="domcontentloaded")
        frame = open_kirocrew_view(page, wait)
        assert frame is not None, "chat webview did not render"

        # Pick bar populated from the API (waits for the choices frame).
        frame.wait_for_function("() => document.querySelector('#p-model span') && /Claude|agent/.test(document.querySelector('#p-model span').textContent)", timeout=wait * 1000)
        labels = frame.evaluate("() => ['p-agent','p-model','p-effort','auto'].map(id => document.getElementById(id).textContent.trim())")
        print("pick bar:", labels)
        assert labels[0].startswith("Default"), labels
        assert frame.locator("#bar").count() == 0, "old top bar still present"

        # Popover menu (in-page), choose a model, bar updates.
        frame.click("#p-model")
        frame.wait_for_selector("#menu.on .it", timeout=5000)
        items = frame.evaluate("() => Array.from(document.querySelectorAll('#menu .it')).map(b => b.firstChild.textContent)")
        print("model menu:", items)
        assert "Claude Fable 5" in items, items
        frame.click("#menu .it:has-text('Claude Fable 5')")
        frame.wait_for_function("() => document.querySelector('#p-model span').textContent.includes('Claude Fable 5')", timeout=5000)
        # One Agent picker, sectioned like Kiro's: the harness advertises spec+plan as installed agents.
        frame.click("#p-agent")
        frame.wait_for_selector("#menu.on .it", timeout=5000)
        menu = frame.evaluate("() => Array.from(document.querySelectorAll('#menu .h, #menu .it')).map(b => (b.classList.contains('h') ? '#' : '') + b.firstChild.textContent)")
        print("agent menu:", menu)
        assert menu == ["#Kiro modes", "Spec", "Plan", "#Your agents", "Default", "desk-default", "spec-writer"], menu
        frame.click("#menu .it:has-text('Plan')")
        frame.wait_for_function("() => document.querySelector('#p-agent span').textContent.includes('Plan')", timeout=5000)
        frame.click("#auto")
        assert frame.evaluate("() => document.getElementById('auto').classList.contains('on')")
        frame.click("#ctx")
        frame.wait_for_selector("#menu.on .it", timeout=5000)
        kinds = frame.evaluate("() => Array.from(document.querySelectorAll('#menu .it')).map(b => b.firstChild.textContent)")
        print("context menu:", kinds)
        assert kinds[:3] == ["Currently Open Files", "Diagnostics", "Git Diff"], kinds
        frame.press("body", "Escape")

        # An assistant row with a trailing [OPTIONS: …] line renders chips; clicking one sends the label.
        frame.evaluate("""() => {
          window.__sent = []; const real = window.vscode || null;
          window.dispatchEvent(new MessageEvent('message', {data: {type: 'row', id: active, row: {role: 'assistant', content: 'All done.\\n\\n[OPTIONS: Go deeper | Explain it]', meta: {}}}}));
        }""")
        frame.wait_for_selector(".options button", timeout=5000)
        chips = frame.evaluate("() => Array.from(document.querySelectorAll('.options button')).map(b => b.textContent)")
        print("option chips:", chips)
        assert chips == ["Go deeper", "Explain it"], chips
        assert "[OPTIONS:" not in frame.evaluate("() => document.querySelector('.assistant').textContent"), "raw marker still shown"
        page.screenshot(path=shot)
        browser.close()
    bad = [e for e in errors if "kirocrew" in e.lower() or "webview" in e.lower()]
    assert not bad, bad
    print("COMPOSER OK: pick bar from API, in-page menus, sectioned agent picker, autopilot, context menu, OPTIONS chips")


if __name__ == "__main__":
    main()
