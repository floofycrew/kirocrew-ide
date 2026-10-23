"""Headless check of the chat webview's transcript rendering, driven the way the
extension drives it: the real ``chatHtml()`` document with ``acquireVsCodeApi``
stubbed, messages posted into it with the same shapes ``ChatView.post`` sends.

Covers the thinking block (KiroCrew's own ThinkingBlock behaviour, mirrored):
``chat_thinking`` deltas accumulate into ONE collapsed block per thinking phase
with a live one-line preview; the header flips from "Thinking" to "Thought
process" once the deltas go quiet; the block sits above the answer streaming
under it; a tool/answer row closes it so later reasoning opens a new block;
clicking the header expands the full text.

Usage: probe_chat_webview.py [--shots <dir>]      (needs Playwright + Chromium)
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent

STUB = """<script>
window.__posted = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => null, setState: () => {} });
</script>"""


def chat_html() -> str:
    """Render the webview document through the extension's own test export (node, stub vscode)."""
    out = subprocess.run(["node", str(HERE / "render_chat_html.mjs"), "fox.svg"], capture_output=True, text=True, check=True)
    html = out.stdout
    # The stub must run before the inline script calls acquireVsCodeApi().
    return html.replace("<head>", "<head>" + STUB, 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=None)
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    failures: list[str] = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg)
        (failures.append(msg) if not cond else None)

    html = chat_html()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 420, "height": 700})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.set_content(html, wait_until="domcontentloaded")
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'ready')")

        def post(m):
            page.evaluate("(m) => window.postMessage(m, '*')", m)

        post({"type": "tabs", "tabs": [{"id": 1, "title": "t", "running": True, "settings": {}}], "active": 1})
        working = "() => { const w = document.querySelector('[data-testid=\"working\"]'); return w ? getComputedStyle(w).display !== 'none' : null; }"
        check(page.evaluate(working) is False, "an empty running tab shows no working foxes (the placeholder has the pane)")
        post({"type": "user", "id": 1, "text": "hello"})
        page.wait_for_function(working)
        foxes = page.evaluate("() => [...document.querySelectorAll('[data-testid=\"working\"] img')].map((i) => getComputedStyle(i).animationDelay)")
        check(len(foxes) == 4 and len(set(foxes)) == 4, f"four foxes hop with staggered delays once the user turn is in ({foxes})")
        below = page.evaluate("() => { const w = document.querySelector('[data-testid=\"working\"]').getBoundingClientRect(); const u = document.querySelector('.row.user').getBoundingClientRect(); return w.top >= u.bottom; }")
        check(below, "the indicator sits under the last row (flex order, whatever the DOM order)")
        bubble = page.evaluate("() => { const u = document.querySelector('.row.user'); const l = u.parentElement; const ur = u.getBoundingClientRect(), lr = l.getBoundingClientRect(); return { right: Math.abs(lr.right - ur.right) < 12, fit: ur.width < lr.width * 0.6, radius: getComputedStyle(u).borderRadius }; }")
        check(bubble["right"] and bubble["fit"] and bubble["radius"] == "6px", f"the user turn is a right-aligned, fit-width bubble with a 6px radius ({bubble})")
        deltas = ["It ", "seems the ", "parser is ", "grabbing the whole line ", "as the id, maybe ", "due to trailing backticks."]
        for d in deltas:
            post({"type": "thinking", "id": 1, "text": d})
        page.wait_for_selector('[data-testid="think-block"]')
        n = page.evaluate("() => document.querySelectorAll('[data-testid=\"think-block\"]').length")
        check(n == 1, f"{len(deltas)} thinking deltas render as ONE block, not one row each ({n})")
        check(page.evaluate("() => document.querySelectorAll('.row.thinking').length") == 0, "no '…'-prefixed per-delta rows")
        body = page.evaluate("() => document.querySelector('[data-testid=\"think-body\"]').textContent")
        check(body == "".join(deltas), f"the block's body is the concatenated reasoning ({body!r})")
        state = page.evaluate("""() => { const b = document.querySelector('[data-testid="think-block"]'); const live = b.querySelector('[data-testid="think-live"]');
          return { live: b.classList.contains('live'), label: b.querySelector('.think-label').textContent, open: b.dataset.open, hidden: b.querySelector('[data-testid="think-body"]').hidden,
                   liveShown: getComputedStyle(live).display !== 'none', liveText: live.textContent }; }""")
        check(state["live"] and state["label"] == "Thinking" and state["open"] == "false" and state["hidden"], f"while deltas arrive: collapsed, labelled 'Thinking', live ({state})")
        check(state["liveShown"] and state["liveText"].endswith("trailing backticks."), f"the live line shows the tail of the reasoning on one line ({state['liveText']!r})")
        if args.shots:
            page.screenshot(path=str(pathlib.Path(args.shots) / "chat-thinking-live.png"))
        page.wait_for_function("() => document.querySelector('[data-testid=\"think-block\"] .think-label').textContent === 'Thought process'", timeout=5000)
        quiet = page.evaluate("""() => { const b = document.querySelector('[data-testid="think-block"]'); return { live: b.classList.contains('live'), liveShown: getComputedStyle(b.querySelector('[data-testid="think-live"]')).display !== 'none' }; }""")
        check(not quiet["live"] and not quiet["liveShown"], f"1.2 s without a delta: 'Thought process', dot still, live line gone ({quiet})")
        # The answer streams under the block; a late delta still lands in the same block, above the answer.
        check(page.evaluate(working) is True, "foxes still hop through the reasoning phase")
        post({"type": "chunk", "id": 1, "text": "The parser ", "seq": 1})
        page.wait_for_function("() => document.querySelector('.row.streaming')")
        check(page.evaluate(working) is False, "the first streamed token replaces the foxes")
        post({"type": "thinking", "id": 1, "text": " Checking the ids."})
        order = page.evaluate("() => [...document.querySelectorAll('.log .row')].map((r) => r.classList.contains('think') ? 'think' : r.classList.contains('streaming') ? 'streaming' : r.className.replace('row ', ''))")
        check(order == ["user", "think", "streaming"], f"the thinking block stays above the streaming answer ({order})")
        check(page.evaluate("() => document.querySelectorAll('[data-testid=\"think-block\"]').length") == 1, "a delta during the answer joins the same block")
        # A tool row closes the phase; reasoning after it opens a new block below the tool row.
        post({"type": "segment", "id": 1})
        post({"type": "row", "id": 1, "row": {"role": "tool", "content": "task_get 3.1", "meta": {}}})
        post({"type": "thinking", "id": 1, "text": "Now the metadata file."})
        page.wait_for_function("() => document.querySelectorAll('[data-testid=\"think-block\"]').length === 2")
        order = page.evaluate("() => [...document.querySelectorAll('.log .row')].map((r) => r.classList.contains('think') ? 'think' : r.classList.contains('assistant') ? 'assistant' : r.className.replace('row ', ''))")
        check(order == ["user", "think", "assistant", "tool", "think"], f"reasoning after a tool call is a new block after the tool row ({order})")
        # Expand: the full text, pre-wrapped, behind the rule.
        page.click('[data-testid="think-block"] .think-head >> nth=0')
        page.wait_for_timeout(350)  # the chevron's 200 ms rotate transition
        opened = page.evaluate("""() => { const b = document.querySelector('[data-testid="think-block"]'); const body = b.querySelector('[data-testid="think-body"]');
          return { open: b.dataset.open, hidden: body.hidden, expanded: b.querySelector('.think-head').getAttribute('aria-expanded'), ws: getComputedStyle(body).whiteSpace, text: body.textContent, chev: getComputedStyle(b.querySelector('.think-chev')).transform }; }""")
        check(opened["open"] == "true" and not opened["hidden"] and opened["expanded"] == "true" and opened["ws"] == "pre-wrap", f"clicking the header expands the body ({opened['open']}, {opened['ws']})")
        check(opened["chev"] == "matrix(0, 1, -1, 0, 0, 0)", f"the chevron turns to point down ({opened['chev']})")
        check(opened["text"] == "".join(deltas) + " Checking the ids.", "the expanded body holds every delta of the phase, untruncated")
        if args.shots:
            page.screenshot(path=str(pathlib.Path(args.shots) / "chat-thinking-open.png"))
        # A persisted thinking row (remote-mirror transcript) renders as a closed block too.
        post({"type": "row", "id": 1, "row": {"role": "thinking", "content": "mirrored reasoning", "meta": {}}})
        page.wait_for_function("() => document.querySelectorAll('[data-testid=\"think-block\"]').length === 3")
        last = page.evaluate("() => { const b = [...document.querySelectorAll('[data-testid=\"think-block\"]')].pop(); return [b.classList.contains('live'), b.querySelector('.think-label').textContent, b.querySelector('[data-testid=\"think-body\"]').textContent]; }")
        check(last == [False, "Thought process", "mirrored reasoning"], f"a transcript row with role thinking is a closed block ({last})")
        check(page.evaluate(working) is True, "after a tool row with no text streaming, the foxes are back")
        # Steering indicator: the count of always files, a menu with Kiro's modes, pick = include / open.
        post({"type": "steering", "items": [
            {"name": "rules", "label": "rules.md", "scope": "workspace", "inclusion": "always", "mode": "always", "description": "", "path": "/w/.kiro/steering/rules.md"},
            {"name": "py", "label": "py.md", "scope": "workspace", "inclusion": "fileMatch", "mode": "fileMatch (**/*.py)", "description": "", "path": "/w/.kiro/steering/py.md"},
            {"name": "deploy", "label": "deploy.md", "scope": "global", "inclusion": "manual", "mode": "manual (#deploy)", "description": "", "path": "/h/.kiro/steering/deploy.md"}]})
        page.wait_for_function("() => document.querySelector('#p-steer .n').textContent === '1'")
        check(True, "the indicator counts the always-included files (1 of 3)")
        page.click("#p-steer")
        rows = page.evaluate("() => [...document.querySelectorAll('#menu .it')].map((r) => [r.querySelector('.mode').textContent, r.querySelector('.open').textContent])")
        heads = page.evaluate("() => [...document.querySelectorAll('#menu .h')].map((h) => h.textContent)")
        check(rows == [["always", "open"], ["fileMatch", "include"], ["manual", "include"]], f"the menu shows each file's Kiro inclusion mode and what a click does ({rows})")
        check(heads == ["Workspace .kiro/steering", "Global ~/.kiro/steering"], f"grouped by tier ({heads})")
        page.click("#menu .it >> nth=2")
        check(page.evaluate("() => document.getElementById('menu').classList.contains('on')") is False, "the menu closes on pick")
        # Resizable input box: auto-grows with text, the grip sets a manual height that is reported for persistence.
        h0 = page.evaluate("() => document.getElementById('text').getBoundingClientRect().height")
        page.fill("#text", "\n".join(["line %d" % i for i in range(8)]))
        page.evaluate("() => document.getElementById('text').dispatchEvent(new Event('input'))")
        h1 = page.evaluate("() => document.getElementById('text').getBoundingClientRect().height")
        check(h1 > h0 + 40, f"the box grows with eight lines of text ({h0:.0f} -> {h1:.0f})")
        grip = page.locator("#grip").bounding_box()
        page.mouse.move(grip["x"] + 40, grip["y"] + 3)
        page.mouse.down()
        page.mouse.move(grip["x"] + 40, grip["y"] - 120, steps=4)
        page.mouse.up()
        h2 = page.evaluate("() => document.getElementById('text').getBoundingClientRect().height")
        check(h2 > h1 + 80 and page.evaluate("() => document.getElementById('text').classList.contains('manual')"), f"dragging the grip up makes the box taller and manual ({h1:.0f} -> {h2:.0f})")
        page.fill("#text", "x")
        page.evaluate("() => document.getElementById('text').dispatchEvent(new Event('input'))")
        check(abs(page.evaluate("() => document.getElementById('text').getBoundingClientRect().height") - h2) < 2, "a manual height does not shrink back when the text does")
        page.dblclick("#grip")
        check(page.evaluate("() => document.getElementById('text').classList.contains('manual')") is False, "double-click on the grip returns to automatic height")
        post({"type": "composerHeight", "px": 200})
        page.wait_for_function("() => Math.abs(document.getElementById('text').getBoundingClientRect().height - 200) < 2")
        check(True, "a remembered height from the extension is applied")
        post({"type": "composerHeight", "px": 0})
        post({"type": "done", "id": 1})
        page.wait_for_function("() => getComputedStyle(document.querySelector('[data-testid=\"working\"]')).display === 'none'")
        check(page.evaluate(working) is False, "done hides the working indicator")
        check(errors == [], f"no page errors ({errors})")
        browser.close()
    print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILURE(S)"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
