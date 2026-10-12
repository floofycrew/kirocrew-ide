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
        post({"type": "user", "id": 1, "text": "hello"})
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
        post({"type": "chunk", "id": 1, "text": "The parser ", "seq": 1})
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
        post({"type": "done", "id": 1})
        check(errors == [], f"no page errors ({errors})")
        browser.close()
    print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILURE(S)"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
