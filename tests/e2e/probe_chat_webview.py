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

        # ---- tool calls open on click (the dashboard's tool card)
        post({"type": "tabs", "tabs": [{"id": 2, "title": "tools", "running": True, "settings": {}}], "active": 2})
        post({"type": "user", "id": 2, "text": "look around"})
        post({"type": "row", "id": 2, "row": {"role": "tool", "content": "🔧 List Directory", "meta": {"tool_call_id": "tc-1", "kind": "read", "done": False, "input": "{\"path\": \"/w/src\"}", "mid": "m1"}}})
        post({"type": "row", "id": 2, "row": {"role": "tool", "content": "🔧 run tests", "meta": {"tool_call_id": "tc-2", "kind": "execute", "done": True, "input": "{\"command\": \"node --test\", \"description\": \"tests\"}", "output": "Output:\n# pass 78\n/w/tests/a.test.mjs:3", "mid": "m2"}}})
        post({"type": "row", "id": 2, "row": {"role": "tool", "content": "plain status line", "meta": {}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.tool').length === 3")
        tools = page.evaluate("() => [...document.querySelectorAll('.log.on .row.tool')].map((r) => ({ call: r.classList.contains('call'), live: r.classList.contains('live'), head: r.querySelector('.tool-head') ? r.querySelector('.tool-title').textContent : null, body: !!r.querySelector('.tool-body'), bg: getComputedStyle(r.querySelector('.tool-head') || r).backgroundColor }))")
        check(tools[0]["call"] and tools[0]["live"] and tools[0]["head"] == "List Directory" and not tools[0]["body"], f"an unfinished call is a live header with no body yet ({tools[0]})")
        check(tools[1]["call"] and not tools[1]["live"] and tools[1]["head"] == "run tests", f"a finished call is a quiet header ({tools[1]})")
        check(not tools[2]["call"] and tools[2]["head"] is None, "a tool-class row without call metadata stays a plain line")
        check(tools[0]["bg"] in ("rgba(0, 0, 0, 0)", "transparent"), f"the header is not painted as a button ({tools[0]['bg']})")
        page.click(".log.on .row.tool.call[data-tcid='tc-2'] .tool-head")
        opened = page.evaluate("""() => { const r = document.querySelector('.log.on .row.tool.call[data-tcid="tc-2"]'); const pres = [...r.querySelectorAll('.tool-pre')]; return { open: r.dataset.open, expanded: r.querySelector('.tool-head').getAttribute('aria-expanded'), labels: [...r.querySelectorAll('.tool-k')].map((k) => k.textContent), input: pres[0].textContent, output: pres[1].textContent, link: !!pres[1].querySelector('a.path'), shown: getComputedStyle(r.querySelector('.tool-body')).display !== 'none' }; }""")
        check(opened["open"] == "true" and opened["expanded"] == "true" and opened["shown"], f"clicking the header opens the body ({opened['open']}, {opened['expanded']})")
        check(opened["labels"] == ["Input", "Output"], f"Input then Output sections ({opened['labels']})")
        check(opened["input"] == "node --test", f"a shell call shows its command, not the JSON envelope ({opened['input']!r})")
        check(opened["output"].startswith("Output:\n# pass 78") and opened["link"], f"the output is shown with its paths linked ({opened['output']!r})")
        page.click(".log.on .row.tool.call[data-tcid='tc-1'] .tool-head")
        pending = page.evaluate("() => { const r = document.querySelector('.log.on .row.tool.call[data-tcid=\"tc-1\"]'); const pres = [...r.querySelectorAll('.tool-pre')]; return { input: pres[0].textContent, output: pres[1].textContent, muted: pres[1].classList.contains('muted') }; }")
        check(pending["input"] == "/w/src" and pending["output"] == "running…" and pending["muted"], f"an unfinished call shows its one argument and a running placeholder ({pending})")
        post({"type": "toolResult", "id": 2, "tcid": "tc-1", "output": "a.js\nb.js"})
        page.wait_for_function("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"tc-1\"] .tool-sec:last-child .tool-pre').textContent.startsWith('a.js')")
        done1 = page.evaluate("() => { const r = document.querySelector('.log.on .row.tool.call[data-tcid=\"tc-1\"]'); return { live: r.classList.contains('live'), output: r.querySelector('.tool-sec:last-child .tool-pre').textContent }; }")
        check(not done1["live"] and done1["output"] == "a.js\nb.js", f"tool_result fills the output and stops the live dot ({done1})")
        post({"type": "toolUpdate", "id": 2, "tcid": "tc-1", "title": "🔧 List Directory /w/src", "input": None})
        page.wait_for_function("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"tc-1\"] .tool-title').textContent === 'List Directory /w/src'")
        check(True, "a tool_call update refines the title")
        page.click(".log.on .row.tool.call[data-tcid='tc-2'] .tool-head")
        check(page.evaluate("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"tc-2\"]').dataset.open") == "false", "a second click folds the body")

        # ---- the pinned prompt: the last user turn stays at the top right while scrolled past it
        post({"type": "tabs", "tabs": [{"id": 3, "title": "long", "running": False, "settings": {}}], "active": 3})
        pin_hidden = "() => document.getElementById('pin').hidden"
        check(page.evaluate(pin_hidden), "an empty pane pins nothing")
        long_prompt = "first question about the parser " + "with a long tail of detail " * 12
        post({"type": "user", "id": 3, "text": long_prompt})
        post({"type": "row", "id": 3, "row": {"role": "assistant", "content": "\n".join(f"answer line {i}" for i in range(60)), "meta": {}}})
        post({"type": "user", "id": 3, "text": "second question, short"})
        post({"type": "row", "id": 3, "row": {"role": "assistant", "content": "\n".join(f"more {i}" for i in range(200)), "meta": {}}})  # long enough that the second prompt can scroll past the fold
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.user').length === 2")
        page.evaluate("() => { const l = document.querySelector('.log.on'); l.scrollTop = 0; }")
        page.wait_for_timeout(80)
        check(page.evaluate(pin_hidden), "scrolled to the top, the first prompt is on screen: nothing pinned")
        page.evaluate("() => { const l = document.querySelector('.log.on'); const u = l.querySelectorAll('.row.user')[0]; l.scrollTop = u.offsetTop + u.offsetHeight + 40; }")
        page.wait_for_function("() => !document.getElementById('pin').hidden")
        pinned = page.evaluate("""() => { const pin = document.getElementById('pin'), t = pin.querySelector('.pin-text'), card = pin.querySelector('.pin-card'); const pr = pin.parentElement.getBoundingClientRect(), cr = card.getBoundingClientRect(), tr = t.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(t).lineHeight); return { text: t.textContent, lines: Math.round(tr.height / lh), right: Math.abs(pr.right - 8 - cr.right) < 3, top: cr.top - pr.top, title: t.title.split('\\n')[0], more: pin.classList.contains('more'), chevShown: getComputedStyle(pin.querySelector('.pin-more')).display !== 'none', clampedWidth: tr.width <= cr.width }; }""")
        check(pinned["text"].startswith("first question about the parser") and len(pinned["text"]) > 200, f"the card carries the first prompt's text ({pinned['text'][:50]!r}…)")
        check(pinned["lines"] == 1, f"collapsed to one line ({pinned['lines']})")
        check(pinned["right"] and 0 <= pinned["top"] <= 8, f"the card sits at the top right of the pane ({pinned['right']}, {pinned['top']:.0f})")
        check(pinned["title"] == "Jump to this turn", f"the card says what a click does ({pinned['title']!r})")
        check(pinned["more"] and pinned["chevShown"], "the ⌄ is offered because one line hides most of the prompt")
        page.hover("#pin .pin-text")
        page.wait_for_timeout(60)
        hov = page.evaluate("() => { const t = document.querySelector('#pin .pin-text'); return Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)); }")
        check(hov == 3, f"hovering shows three lines ({hov})")
        page.mouse.move(5, 5)
        page.click("#pin .pin-more")
        page.wait_for_timeout(60)
        full = page.evaluate("() => { const pin = document.getElementById('pin'), t = pin.querySelector('.pin-text'); return { open: pin.classList.contains('open'), lines: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)), expanded: pin.querySelector('.pin-more').getAttribute('aria-expanded') }; }")
        check(full["open"] and full["lines"] >= 4 and full["expanded"] == "true", f"the ⌄ shows the whole prompt ({full})")
        page.click("#pin .pin-more")
        # Approaching the second turn pushes the card up, and past it the second prompt takes over.
        page.evaluate("() => { const l = document.querySelector('.log.on'); const u = l.querySelectorAll('.row.user')[1]; const card = document.querySelector('#pin .pin-card').getBoundingClientRect().height; l.scrollTop = u.offsetTop - 8 - Math.round(card / 2); }")
        page.wait_for_timeout(80)
        pushed = page.evaluate("() => { const pin = document.getElementById('pin'); const m = /translateY\\((-?[\\d.]+)px\\)/.exec(pin.querySelector('.pin-card').style.transform); return { hidden: pin.hidden, push: m ? Number(m[1]) : 0, text: pin.querySelector('.pin-text').textContent.slice(0, 14) }; }")
        check(not pushed["hidden"] and pushed["push"] < -4 and pushed["text"] == "first question", f"the next turn nearing the card pushes it up ({pushed})")
        page.evaluate("() => { const l = document.querySelector('.log.on'); l.scrollTop = l.scrollHeight; }")
        page.wait_for_function("() => !document.getElementById('pin').hidden && document.querySelector('#pin .pin-text').textContent === 'second question, short'")
        second = page.evaluate("() => { const pin = document.getElementById('pin'); return { more: pin.classList.contains('more'), chev: getComputedStyle(pin.querySelector('.pin-more')).display, transform: pin.querySelector('.pin-card').style.transform }; }")
        check(not second["more"] and second["chev"] == "none" and second["transform"] == "", f"at the bottom the second prompt is pinned, whole, no ⌄, not pushed ({second})")
        page.click("#pin .pin-text")
        page.wait_for_function("() => { const l = document.querySelector('.log.on'); const u = l.querySelectorAll('.row.user')[1]; return Math.abs(l.scrollTop - (u.offsetTop - 8)) < 2; }")
        page.wait_for_timeout(80)
        check(page.evaluate(pin_hidden), "clicking the card scrolls back to where that turn starts and the card steps aside")
        post({"type": "tabs", "tabs": [{"id": 3, "title": "long", "running": False, "settings": {}}, {"id": 1, "title": "t", "running": False, "settings": {}}], "active": 1})
        page.wait_for_timeout(80)
        check(page.evaluate("() => { const pin = document.getElementById('pin'); return pin.hidden || pin.querySelector('.pin-text').textContent === 'hello'; }"), "switching tabs re-measures for the shown transcript")
        check(errors == [], f"no page errors ({errors})")
        browser.close()
    print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILURE(S)"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
