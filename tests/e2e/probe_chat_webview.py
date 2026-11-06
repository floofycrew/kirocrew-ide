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
import json
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

        # ---- the host's turn-ceiling card: an `error` role row is the red box, with Continue
        post({"type": "tabs", "tabs": [{"id": 4, "title": "limit", "running": False, "settings": {}}], "active": 4})
        card = "⏱️ This turn hit the 4-hour limit and was stopped. Work already written to disk is still there — nothing was rolled back. Send a message to continue from where it stopped."
        post({"type": "user", "id": 4, "text": "Run all tasks"})
        post({"type": "row", "id": 4, "row": {"role": "tool", "content": "🔧 task_status", "meta": {"tool_call_id": "tc-9", "done": True}}})
        post({"type": "done", "id": 4})
        post({"type": "row", "id": 4, "row": {"role": "error", "cls": "msg msg-err", "content": card, "meta": {"mid": "m-limit"}}})
        page.wait_for_selector(".log.on .row.assistant.err button.resume")
        box = page.evaluate("""() => { const d = document.querySelector('.log.on .row.assistant.err'); const cs = getComputedStyle(d); const b = d.querySelector('button.resume');
          return { text: d.textContent.includes('hit the 4-hour limit'), border: cs.borderTopWidth, bg: cs.backgroundColor, label: b.textContent, disabled: b.disabled, tool: Boolean(document.querySelector('.log.on .row.tool.err')) }; }""")
        check(box["text"] and box["border"] == "1px" and box["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"), f"the error-role row is the bordered red box, not a quiet tool row ({box})")
        check(not box["tool"], "no tool-styled copy of the card")
        check(box["label"] == "Continue from where it stopped" and not box["disabled"], f"the card carries one Continue button ({box['label']!r})")
        # A plain assistant failure row (msg-err, no ceiling text) gets the box but no button.
        post({"type": "row", "id": 4, "row": {"role": "assistant", "cls": "msg msg-err", "content": "❌ the model refused", "meta": {"mid": "m-fail"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.assistant.err').length === 2")
        check(page.evaluate("() => document.querySelectorAll('.log.on .row.assistant.err button.resume').length") == 1, "only the ceiling card has Continue")
        page.click(".log.on .row.assistant.err button.resume")
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'resume' && m.id === 4)")
        check(page.evaluate("() => { const b = document.querySelector('.log.on button.resume'); return b.disabled && b.textContent === 'Continuing…'; }"), "clicking posts resume for the tab and the button goes quiet")
        # The extension echoes the resumed turn as a user row: the button is gone, the run is on again.
        post({"type": "user", "id": 4, "text": "Resume: Run all tasks (2 left)"})
        page.wait_for_function("() => !document.querySelector('.log.on button.resume')")
        check(page.evaluate("() => document.querySelector('.log.on .row.user:last-of-type').textContent") == "Resume: Run all tasks (2 left)", "the next user turn removes the button")
        # A transcript loaded from history with the card followed by a later turn shows no stale button.
        post({"type": "clear", "id": 4})
        post({"type": "row", "id": 4, "row": {"role": "error", "cls": "msg msg-err", "content": card, "meta": {"mid": "m-old"}}})
        post({"type": "row", "id": 4, "row": {"role": "user", "content": "continue", "meta": {"mid": "m-cont"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.user').length === 1")
        check(page.evaluate("() => !document.querySelector('.log.on button.resume')"), "history: a card already answered offers no button")

        # ---- the interrupted-run card: judged from tasks.md by the extension, a warning-tinted
        # (not red) row with Resume run; gone once the next user turn lands.
        post({"type": "tabs", "tabs": [{"id": 5, "title": "run", "running": False, "settings": {}}], "active": 5})
        post({"type": "user", "id": 5, "text": "Run all tasks"})
        post({"type": "row", "id": 5, "row": {"role": "assistant", "content": "Dispatching 16.1.", "meta": {"mid": "m-a"}}})
        post({"type": "done", "id": 5})
        post({"type": "interrupted", "id": 5, "text": "This run was interrupted: 1 task in progress and 10 queued, and the session is idle. Resume run continues from tasks.md.", "resume": True})
        page.wait_for_selector('.log.on [data-testid="run-card"] button.resume')
        rc = page.evaluate("""() => { const d = document.querySelector('.log.on [data-testid="run-card"]'); const cs = getComputedStyle(d); const b = d.querySelector('button.resume');
          const err = getComputedStyle(document.querySelector('.log.on .row.err') || d);
          return { pause: d.classList.contains('pause'), err: d.classList.contains('err'), border: cs.borderTopWidth, bg: cs.backgroundColor, label: b.textContent, text: d.textContent.includes('1 task in progress and 10 queued') }; }""")
        check(rc["pause"] and not rc["err"] and rc["border"] == "1px" and rc["bg"] not in ("rgba(0, 0, 0, 0)", "transparent"), f"the run card is a bordered, tinted row and not the red error box ({rc})")
        check(rc["label"] == "Resume run" and rc["text"], f"it names what is left and offers Resume run ({rc['label']!r})")
        # A card without a resume (a question is in the way) has no button; it replaces the earlier card.
        post({"type": "interrupted", "id": 5, "text": "The run is waiting on your answer above (1 task in progress and 10 queued)."})
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"run-card\"]').length === 1")
        check(page.evaluate("() => !document.querySelector('.log.on [data-testid=\"run-card\"] button.resume')"), "a waiting-on-you card has no Resume run")
        post({"type": "interrupted", "id": 5, "text": "Stopped with 1 task in progress and 10 queued. Resume run continues from tasks.md.", "resume": True})
        page.wait_for_selector('.log.on [data-testid="run-card"] button.resume')
        page.click('.log.on [data-testid="run-card"] button.resume')
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'resume' && m.id === 5)")
        check(page.evaluate("() => { const b = document.querySelector('.log.on [data-testid=\"run-card\"] button.resume'); return b.disabled && b.textContent === 'Resume running…'; }"), "Resume run posts resume for the tab and goes quiet")
        post({"type": "user", "id": 5, "text": "Resume: Run all tasks (11 left)"})
        page.wait_for_function("() => !document.querySelector('.log.on [data-testid=\"run-card\"]')")
        check(page.evaluate("() => !document.querySelector('.log.on [data-testid=\"run-card\"]') && document.querySelectorAll('.log.on .row.user').length === 2"), "the resumed turn removes the card")

        # ---- the reading column: a wide pane gets margins, a narrow one keeps its 8px; the
        # pinned prompt follows the column; the presets scale as the dashboard's do.
        def column():
            return page.evaluate("""() => { const log = document.querySelector('.log.on'); const cs = getComputedStyle(log);
              const u = [...document.querySelectorAll('.log.on .row.user')].pop().getBoundingClientRect(); const lr = log.getBoundingClientRect();
              return { padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight), pane: lr.width, bubbleRight: lr.right - u.right,
                       composePadL: parseFloat(getComputedStyle(document.getElementById('compose')).paddingLeft),
                       width: getComputedStyle(document.documentElement).getPropertyValue('--kide-content-width').trim() }; }""")
        narrow = column()
        check(narrow["padL"] == 8 and narrow["padR"] == 8 and narrow["composePadL"] == 5, f"420px pane: the gutters stay 8px / 5px ({narrow})")
        page.set_viewport_size({"width": 1400, "height": 700})
        page.wait_for_timeout(50)
        wide = column()
        check(abs(wide["padL"] - (1400 - 800) / 2) < 1 and abs(wide["padR"] - (1400 - 800) / 2) < 1, f"1400px pane: an 800px column centred (gutters {wide['padL']:.0f}/{wide['padR']:.0f})")
        check(abs(wide["composePadL"] - (1400 - 816) / 2) < 1, f"the composer gets its 816px column ({wide['composePadL']:.0f})")
        check(wide["bubbleRight"] < 320, f"the user bubble hugs the column's right edge, not the pane's ({wide['bubbleRight']:.0f}px in)")
        # Font size scales the compact column (the dashboard's rule: × size/14).
        post({"type": "fontSize", "px": 21})
        page.wait_for_timeout(20)
        check(column()["width"] == "1200px", f"21px messages: 800 × 21/14 = 1200px column ({column()['width']})")
        post({"type": "fontSize", "px": 0})
        post({"type": "width", "preset": "comfortable"})
        page.wait_for_timeout(20)
        comf = column()
        check(abs(comf["padL"] - 1400 * 0.08) < 1, f"comfortable: 84% of the pane ({comf['padL']:.0f}px gutters)")
        post({"type": "width", "preset": "full"})
        page.wait_for_timeout(20)
        full = column()
        check(abs(full["padL"] - 1400 * 0.04) < 1, f"full: 92% of the pane ({full['padL']:.0f}px gutters)")
        post({"type": "width", "preset": "compact"})
        # The pinned card sits inside the same column: scroll a long transcript past a user turn and compare edges.
        post({"type": "tabs", "tabs": [{"id": 6, "title": "pin", "running": False, "settings": {}}], "active": 6})
        post({"type": "user", "id": 6, "text": "first prompt"})
        for i in range(40):
            post({"type": "row", "id": 6, "row": {"role": "assistant", "content": f"line {i}\nmore\nmore", "meta": {"mid": f"p{i}"}}})
        post({"type": "user", "id": 6, "text": "second prompt"})
        for i in range(40):
            post({"type": "row", "id": 6, "row": {"role": "assistant", "content": f"tail {i}\nmore\nmore", "meta": {"mid": f"q{i}"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.user').length === 2")
        page.evaluate("() => { const log = document.querySelector('.log.on'); log.scrollTop = log.scrollHeight; }")
        page.wait_for_function("() => { const p = document.getElementById('pin'); return p && !p.hidden; }")
        edges = page.evaluate("""() => { const card = document.querySelector('.pin-card').getBoundingClientRect(); const log = document.querySelector('.log.on');
          const u = [...document.querySelectorAll('.log.on .row.user')].pop().getBoundingClientRect(); const lr = log.getBoundingClientRect();
          return { cardRight: card.right, bubbleRight: u.right, paneRight: lr.right, scrollbar: log.offsetWidth - log.clientWidth }; }""")
        check(abs(edges["cardRight"] - edges["bubbleRight"]) <= 1, f"the pinned card's right edge lines up with the bubbles' ({edges})")
        page.set_viewport_size({"width": 420, "height": 700})

        # ---- follow mode and the Jump-to-latest button: at the bottom the pane follows new
        # rows; scrolled up it stays put, the pill appears, turns "New messages" when something
        # lands unseen, and a click (or scrolling back down) re-arms following. Your own turn
        # and a reload always land at the bottom.
        post({"type": "tabs", "tabs": [{"id": 7, "title": "follow", "running": False, "settings": {}}], "active": 7})
        post({"type": "user", "id": 7, "text": "tell me a long story"})
        for i in range(30):
            post({"type": "row", "id": 7, "row": {"role": "assistant", "content": f"paragraph {i}\nline\nline", "meta": {"mid": f"f{i}"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.assistant').length === 30")
        geo = lambda: page.evaluate("""() => { const log = document.querySelector('.log.on'); const j = document.getElementById('jump');
          return { atBottom: log.scrollHeight - log.scrollTop - log.clientHeight <= 8, jump: !j.hidden, label: j.querySelector('.jl').textContent, isNew: j.classList.contains('new'), top: log.scrollTop }; }""")
        g = geo()
        check(g["atBottom"] and not g["jump"], f"at the bottom after new rows: following, no button ({g})")
        page.evaluate("() => { const log = document.querySelector('.log.on'); log.scrollTop = 120; }")
        page.wait_for_function("() => !document.getElementById('jump').hidden")
        g = geo()
        check(g["jump"] and g["label"] == "Jump to latest" and not g["isNew"], f"scrolled up: the button shows, nothing new yet ({g['label']!r})")
        top_before = g["top"]
        post({"type": "row", "id": 7, "row": {"role": "assistant", "content": "a fresh paragraph while you read", "meta": {"mid": "f-new"}}})
        page.wait_for_function("() => document.getElementById('jump').classList.contains('new')")
        g = geo()
        check(g["top"] == top_before, f"a new row does not yank the view ({g['top']} vs {top_before})")
        check(g["label"] == "New messages" and g["isNew"], f"the button says New messages and is accented ({g['label']!r})")
        jr = page.evaluate("() => { const r = document.getElementById('jump').getBoundingClientRect(); const p = document.getElementById('panes').getBoundingClientRect(); return { centered: Math.abs((r.left + r.right) / 2 - (p.left + p.right) / 2) < 2, bottomGap: p.bottom - r.bottom }; }")
        check(jr["centered"] and 6 <= jr["bottomGap"] <= 14, f"the pill sits centred over the pane's bottom edge ({jr})")
        page.click("#jump")
        page.wait_for_function("() => { const log = document.querySelector('.log.on'); return log.scrollHeight - log.scrollTop - log.clientHeight <= 8; }")
        page.wait_for_function("() => document.getElementById('jump').hidden")
        check(True, "clicking scrolls to the bottom and hides the button")
        post({"type": "row", "id": 7, "row": {"role": "assistant", "content": "and following resumed", "meta": {"mid": "f-follow"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.assistant').length === 32")
        g = geo(); check(g["atBottom"] and not g["jump"], "following is re-armed after the jump")
        # Scrolling back down by hand re-arms too; a user turn always lands at the bottom.
        page.evaluate("() => { document.querySelector('.log.on').scrollTop = 0; }")
        page.wait_for_function("() => !document.getElementById('jump').hidden")
        page.evaluate("() => { const log = document.querySelector('.log.on'); log.scrollTop = log.scrollHeight; }")
        page.wait_for_function("() => document.getElementById('jump').hidden")
        check(True, "scrolling to the end by hand hides the button and re-arms following")
        page.evaluate("() => { document.querySelector('.log.on').scrollTop = 0; }")
        page.wait_for_function("() => !document.getElementById('jump').hidden")
        post({"type": "user", "id": 7, "text": "and then?"})
        page.wait_for_function("() => document.getElementById('jump').hidden")
        g = geo(); check(g["atBottom"], "your own turn scrolls to the bottom whatever the position")
        # The button belongs to the active tab: switching to a tab that is at its bottom hides it; back again, it returns.
        page.evaluate("() => { document.querySelector('.log.on').scrollTop = 0; }")
        page.wait_for_function("() => !document.getElementById('jump').hidden")
        post({"type": "tabs", "tabs": [{"id": 7, "title": "follow", "running": False, "settings": {}}, {"id": 8, "title": "other", "running": False, "settings": {}}], "active": 8})
        post({"type": "user", "id": 8, "text": "short"})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"8\"]')")
        check(page.evaluate("() => document.getElementById('jump').hidden"), "another tab at its bottom: no button")
        post({"type": "tabs", "tabs": [{"id": 7, "title": "follow", "running": False, "settings": {}}, {"id": 8, "title": "other", "running": False, "settings": {}}], "active": 7})
        page.wait_for_function("() => !document.getElementById('jump').hidden")
        check(True, "back on the scrolled-up tab the button returns")

        # ---- images: a pasted image is a thumbnail in the composer, the sent bubble shows the
        # picture, a history row's [attached_file N] marker becomes a fetched preview, a
        # markdown image in an answer is drawn in place, everything opens the lightbox, a
        # missing file is an error note, a dropped file joins the list.
        PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNAMDAO1ZD/lO4lZgAAAAAElFTkSuQmCC"  # 2x2 png
        post({"type": "tabs", "tabs": [{"id": 9, "title": "img", "running": False, "settings": {}}], "active": 9})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"9\"]')")
        page.evaluate("""(b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const file = new File([bytes], 'clip.png', { type: 'image/png' });
          const dt = new DataTransfer(); dt.items.add(file); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.getElementById('text').dispatchEvent(ev); }""", PNG)
        page.wait_for_selector("#chips .chip.img img")
        th = page.evaluate("() => { const im = document.querySelector('#chips .chip.img img'); const r = im.getBoundingClientRect(); return { src: im.src.slice(0, 21), h: r.height, name: im.dataset.name, rm: Boolean(im.parentElement.querySelector('button.rm')) }; }")
        check(th["src"] == "data:image/png;base64" and 40 <= th["h"] <= 50 and th["name"].startswith("pasted-image-") and th["rm"], f"a pasted image is a 48px thumbnail chip with its ×, named pasted-image-… ({th})")
        page.click("#chips .chip.img img")
        page.wait_for_selector("#lightbox.on")
        check(page.evaluate("() => document.querySelector('#lightbox img').src.startsWith('data:image/png') && document.querySelector('#lightbox .lb-open').hidden"), "clicking the thumbnail opens the lightbox (no Open file for an unsent paste)")
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.getElementById('lightbox').classList.contains('on')")
        check(True, "Esc closes the lightbox")
        # A drop adds a non-image file beside it.
        page.evaluate("""() => { const file = new File(['hello'], 'notes.txt', { type: 'text/plain' }); const dt = new DataTransfer(); dt.items.add(file);
          const c = document.getElementById('compose'); c.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); c.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }""")
        page.wait_for_function("() => document.querySelectorAll('#chips .chip').length === 2")
        check(page.evaluate("() => document.querySelectorAll('#chips .chip')[1].textContent.includes('notes.txt') && !document.getElementById('compose').classList.contains('drop')"), "a dropped file joins the chips as a 📎 and the drop outline clears")
        # The × removes the image; the sent files travel with the message.
        page.click("#chips .chip.img .rm")
        page.wait_for_function("() => document.querySelectorAll('#chips .chip').length === 1")
        page.evaluate("""(b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const file = new File([bytes], 'shot.png', { type: 'image/png' });
          const dt = new DataTransfer(); dt.items.add(file); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.getElementById('text').dispatchEvent(ev); }""", PNG)
        page.wait_for_selector("#chips .chip.img img")
        page.fill("#text", "what is this")
        page.keyboard.press("Enter")
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'send' && m.files && m.files.length === 2)")
        sent = page.evaluate("() => { const m = window.__posted.filter((m) => m.type === 'send').pop(); return { names: m.files.map((f) => f.name.replace(/\\d+/, 'N')), mimes: m.files.map((f) => f.mime), chips: document.querySelectorAll('#chips .chip').length }; }")
        check(sent["mimes"] == ["text/plain", "image/png"] and sent["chips"] == 0, f"send carries both files (mime + base64) and empties the chip row ({sent})")
        # The extension echoes the turn (same local id) with the files resolved: the image shows from its data URL, the text file is a 📎 chip.
        local = page.evaluate("() => window.__posted.filter((m) => m.type === 'send').pop().local")
        post({"type": "user", "id": 9, "local": local, "text": "what is this", "files": [{"name": "notes.txt", "path": "/home/u/.kiro/crew/uploads/1_notes.txt", "image": False}, {"name": "shot.png", "path": "/home/u/.kiro/crew/uploads/2_shot.png", "image": True, "data": "data:image/png;base64," + PNG}]})
        page.wait_for_function("() => { const im = document.querySelector('.log.on .row.user .att img'); return im && im.dataset.path === '/home/u/.kiro/crew/uploads/2_shot.png'; }")
        check(page.evaluate("() => document.querySelectorAll('.log.on .row.user').length") == 1, "the echoed turn completes the bubble drawn at send time; one bubble")
        bub = page.evaluate("() => { const u = [...document.querySelectorAll('.log.on .row.user')].pop(); const im = u.querySelector('.att img'); return { text: u.firstChild.nodeType === 3 ? u.firstChild.nodeValue : u.childNodes[0].textContent, src: im.src.slice(0, 21), path: im.dataset.path, file: u.querySelector('.att .file').textContent, prompt: u.dataset.prompt, posted: window.__posted.filter((m) => m.type === 'image').length }; }")
        check(bub["text"] == "what is this" and bub["src"] == "data:image/png;base64" and bub["path"].endswith("2_shot.png") and bub["file"] == "📎 notes.txt", f"the bubble shows the text, the picture and the file chip ({bub})")
        check(bub["posted"] == 0, "an image sent with its data needs no fetch")
        page.click(".log.on .row.user .att img")
        page.wait_for_selector("#lightbox.on")
        lb = page.evaluate("() => ({ name: document.querySelector('#lightbox .lb-name').textContent, open: !document.querySelector('#lightbox .lb-open').hidden, path: document.querySelector('#lightbox .lb-open').dataset.path })")
        check(lb["name"] == "shot.png" and lb["open"] and lb["path"].endswith("2_shot.png"), f"the lightbox names the file and offers Open file ({lb})")
        page.click("#lightbox .lb-open")
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'open' && m.path && m.path.endsWith('2_shot.png'))")
        check(True, "Open file asks the extension to open the image")
        page.click("#lightbox .lb-close")
        page.wait_for_function("() => !document.getElementById('lightbox').classList.contains('on')")
        # History: a user row with markers in the text and meta.files; the image is fetched through the extension.
        post({"type": "row", "id": 9, "row": {"role": "user", "content": "look at both\n[attached_file 1] /home/u/.kiro/crew/uploads/3_old shot.png\n[attached_file 2] /home/u/.kiro/crew/uploads/4_data.csv", "meta": {"mid": "h1", "files": ["/home/u/.kiro/crew/uploads/3_old shot.png", "/home/u/.kiro/crew/uploads/4_data.csv"]}}})
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'image' && m.path === '/home/u/.kiro/crew/uploads/3_old shot.png')")
        hist = page.evaluate("() => { const u = [...document.querySelectorAll('.log.on .row.user')].pop(); return { text: u.childNodes[0].nodeValue, ph: Boolean(u.querySelector('.imgph')), marker: u.textContent.includes('[attached_file'), file: u.querySelector('.att .file').textContent, prompt: u.dataset.prompt }; }")
        check(hist["text"] == "look at both" and hist["ph"] and not hist["marker"] and hist["file"] == "📎 4_data.csv", f"a history row strips the markers, resolves the path WITH a space from meta.files, shows a placeholder while fetching ({hist})")
        check(hist["prompt"] == "look at both", "the pinned prompt uses the text without the markers")
        post({"type": "image", "id": 9, "path": "/home/u/.kiro/crew/uploads/3_old shot.png", "data": "data:image/png;base64," + PNG})
        page.wait_for_selector(".log.on .row.user:last-of-type .att img")
        fetched = page.evaluate("() => { const u = [...document.querySelectorAll('.log.on .row.user')].pop(); const im = u.querySelector('.att img'); return { ph: Boolean(u.querySelector('.imgph')), name: im && im.dataset.name, alt: im && im.alt, path: im && im.dataset.path }; }")
        check(not fetched["ph"] and fetched["name"] == "3_old shot.png", f"the fetched image replaces the placeholder ({fetched})")
        # A missing file: the answer carries an error; the note keeps the name as a path link.
        post({"type": "row", "id": 9, "row": {"role": "user", "content": "[attached_file 1] /gone/x.png", "meta": {"mid": "h2"}}})
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'image' && m.path === '/gone/x.png')")
        post({"type": "image", "id": 9, "path": "/gone/x.png", "error": "not found"})
        page.wait_for_selector(".log.on .row.user .imgph.err")
        check(page.evaluate("() => { const e = document.querySelector('.log.on .row.user .imgph.err'); return e.textContent.includes('not found') && e.querySelector('a.path').dataset.path === '/gone/x.png'; }"), "a missing image is an error note with the file as a link")
        # A markdown image in an answer: a local path is fetched, an https one loads as is; both open the lightbox.
        post({"type": "row", "id": 9, "row": {"role": "assistant", "content": "Here it is:\n\n![the chart](/tmp/out/chart.png)\n\nand ![remote](https://example.invalid/r.png)", "meta": {"mid": "a9"}}})
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'image' && m.path === '/tmp/out/chart.png')")
        post({"type": "image", "id": 9, "path": "/tmp/out/chart.png", "data": "data:image/png;base64," + PNG})
        page.wait_for_function("() => { const im = document.querySelector('.log.on .row.assistant img.mdimg[data-path]'); return im && im.src.startsWith('data:'); }")
        md = page.evaluate("() => { const ims = [...document.querySelectorAll('.log.on .row.assistant img.mdimg')]; return { n: ims.length, alts: ims.map((i) => i.alt), remote: ims[1].getAttribute('src'), links: document.querySelectorAll('.log.on .row.assistant a.path').length }; }")
        check(md["n"] == 2 and md["alts"] == ["the chart", "remote"] and md["remote"] == "https://example.invalid/r.png" and md["links"] == 0, f"markdown images render as pictures, not path links ({md})")
        page.click(".log.on .row.assistant img.mdimg[data-path]")
        page.wait_for_selector("#lightbox.on")
        check(page.evaluate("() => document.querySelector('#lightbox .lb-name').textContent === 'the chart' && document.querySelector('#lightbox .lb-open').dataset.path === '/tmp/out/chart.png'"), "an answer's image opens the lightbox with its path")
        page.keyboard.press("Escape")
        # The cache: a second row with the same path shows at once, no second request.
        before_req = page.evaluate("() => window.__posted.filter((m) => m.type === 'image').length")
        post({"type": "row", "id": 9, "row": {"role": "user", "content": "again [attached_file 1] /tmp/out/chart.png", "meta": {"mid": "h3"}}})
        page.wait_for_function("() => [...document.querySelectorAll('.log.on .row.user')].pop().querySelector('.att img')")
        check(page.evaluate("() => window.__posted.filter((m) => m.type === 'image').length") == before_req, "a path already fetched is served from the cache")

        # ---- your turn shows at once: the bubble exists before the extension has answered the
        # send; the extension's later `user` message (same local id) completes it in place.
        post({"type": "tabs", "tabs": [{"id": 10, "title": "fast", "running": False, "settings": {}}], "active": 10})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"10\"]')")
        page.evaluate("""(b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const file = new File([bytes], 'quick.png', { type: 'image/png' });
          const dt = new DataTransfer(); dt.items.add(file); document.getElementById('text').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""", PNG)
        page.wait_for_selector("#chips .chip.img img")
        page.fill("#text", "why is this slow")
        n_before = page.evaluate("() => window.__posted.filter((m) => m.type === 'send').length")
        page.keyboard.press("Enter")
        # Synchronous with the key: no extension round trip has happened (nothing was posted back to the page).
        at_once = page.evaluate("""() => { const u = [...document.querySelectorAll('.log.on .row.user')].pop(); const w = document.querySelector('.log.on [data-testid="working"]');
          return { bubble: Boolean(u), text: u && u.childNodes[0].nodeValue, local: u && u.dataset.local, thumb: Boolean(u && u.querySelector('.att img')), working: w && getComputedStyle(w).display !== 'none', chips: document.querySelectorAll('#chips .chip').length, textbox: document.getElementById('text').value }; }""")
        check(at_once["bubble"] and at_once["text"] == "why is this slow" and at_once["thumb"] and at_once["local"], f"the bubble, with its image, is on screen the moment Enter is pressed ({at_once})")
        check(at_once["working"] and at_once["chips"] == 0 and at_once["textbox"] == "", "the foxes start and the composer is cleared at once")
        sent = page.evaluate("() => window.__posted.filter((m) => m.type === 'send').pop()")
        check(sent["local"] == at_once["local"] and len(sent["files"]) == 1, "the send carries the bubble's local id")
        # The extension answers with the resolved upload: the same bubble gains the path, no second row.
        post({"type": "user", "id": 10, "local": sent["local"], "text": "why is this slow", "files": [{"name": "quick.png", "path": "/home/u/.kiro/crew/uploads/9_quick.png", "image": True, "data": "data:image/png;base64," + PNG}]})
        page.wait_for_function("() => { const u = [...document.querySelectorAll('.log.on .row.user')].pop(); const im = u && u.querySelector('.att img'); return im && im.dataset.path === '/home/u/.kiro/crew/uploads/9_quick.png'; }")
        check(page.evaluate("() => document.querySelectorAll('.log.on .row.user').length") == 1, "the extension's user message completed the bubble instead of adding one")
        # A dispatch's user row (no local id) still appends.
        post({"type": "user", "id": 10, "text": "Run all tasks"})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.user').length === 2")
        check(True, "a user row without a local id is appended as before")

        # ---- the host's inject rows: a tool call stopped by a safety policy is the dashboard's
        # collapsed recovery card (title, muted detail, the pattern as a mono chip), the notice
        # itself a click away; a Continue is the routine card; an automation notice draws nothing;
        # a cron notification stays a quiet row.
        post({"type": "tabs", "tabs": [{"id": 11, "title": "inject", "running": False, "settings": {}}], "active": 11})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"11\"]')")
        blocked = ("[Tool blocked — reason sent to the agent] policy\n"
                   "[Kiro Crew host notice] The tool call you just made was blocked by a Kiro Crew safety policy. This was NOT a user action — the user did not cancel, reject, or interrupt anything.\n\n"
                   "Blocked: cd ~/.kiro/crew && python - <<'EOF'\nprint(open('/tmp/x.py').read())\nEOF: Blocked by security policy: (?:\\A|[;&|\\n`]|\\$\\()[\\s\"'(]*kiro[-.]?crew\\b[^|;&#>/*]*\\btoken\\b\n"
                   "Matched structurally on the command's argv, not by the pattern text above.")
        post({"type": "row", "id": 11, "row": {"role": "inject", "content": blocked, "meta": {"mid": "i1"}}})
        page.wait_for_selector(".log.on [data-testid=\"recovery-card\"]")
        card = page.evaluate("""() => { const c = document.querySelector('.log.on [data-testid="recovery-card"]'); const cs = getComputedStyle(c); const h = c.querySelector('.rc-head'); const hcs = getComputedStyle(h);
          const ico = c.querySelector('.rc-ico svg'); return { kind: c.dataset.kind, severity: c.dataset.severity, open: c.dataset.open, isTool: c.classList.contains('tool'),
            title: c.querySelector('.rc-title').textContent, detail: c.querySelector('.rc-detail').textContent, chip: c.querySelector('[data-testid="recovery-card-chip"]').textContent,
            bodyShown: getComputedStyle(c.querySelector('[data-testid="recovery-card-body"]')).display !== 'none', radius: cs.borderRadius, border: cs.borderStyle, headBg: hcs.backgroundColor, headPad: hcs.paddingLeft,
            icoColor: getComputedStyle(c.querySelector('.rc-ico')).color, textColor: cs.color, svg: !!ico, oneLine: h.getBoundingClientRect().height < 32, raw: c.textContent.includes('reason sent to the agent') }; }""")
        check(card["kind"] == "tool_blocked" and card["severity"] == "attention" and card["open"] == "false" and not card["bodyShown"], f"a blocked call is a collapsed attention card ({card['kind']}, {card['severity']})")
        check(card["title"] == "Tool call blocked" and card["detail"] == "safety policy blocked the call · the agent was told why, in this turn", f"the dashboard's title and detail ({card['title']!r} / {card['detail']!r})")
        check(card["chip"].startswith("(?:\\A|") and card["chip"].endswith("\\btoken\\b"), f"the policy pattern is the mono chip ({card['chip'][:30]}…)")
        check(not card["raw"] and card["oneLine"], "collapsed: one line, the raw prefix is not shown")
        check(card["radius"] == "6px" and card["border"] == "solid" and card["headBg"] in ("rgba(0, 0, 0, 0)", "transparent") and not card["isTool"], f"a squared card with its own hairline, not a tool row ({card['radius']}, {card['headBg']})")
        check(card["svg"] and card["icoColor"] != card["textColor"], f"the attention icon is drawn in the warning colour ({card['icoColor']} vs text {card['textColor']})")
        page.click(".log.on [data-testid=\"recovery-card\"] .rc-head")
        page.wait_for_function("() => document.querySelector('.log.on [data-testid=\"recovery-card\"]').dataset.open === 'true'")
        body = page.evaluate("""() => { const c = document.querySelector('.log.on [data-testid="recovery-card"]'); const b = c.querySelector('[data-testid="recovery-card-body"]'); const cs = getComputedStyle(b);
          return { shown: cs.display !== 'none', mono: cs.fontFamily, pre: cs.whiteSpace, text: b.textContent, link: [...b.querySelectorAll('a.path')].map((a) => a.title).find((t) => t.endsWith('x.py')), expanded: c.querySelector('.rc-head').getAttribute('aria-expanded') }; }""")
        check(body["shown"] and body["expanded"] == "true" and body["pre"] == "pre-wrap", "a click opens the body, pre-wrapped")
        check(body["text"].startswith("[Kiro Crew host notice]") and "Matched structurally" in body["text"] and "] policy" not in body["text"], "the body is the whole notice after the prefix line")
        check(body["link"] == "Open /tmp/x.py", f"paths in the notice are links ({body['link']})")
        page.click(".log.on [data-testid=\"recovery-card\"] .rc-head")
        page.wait_for_function("() => document.querySelector('.log.on [data-testid=\"recovery-card\"]').dataset.open === 'false'")
        check(page.evaluate("() => getComputedStyle(document.querySelector('.log.on [data-testid=\"recovery-card-body\"]')).display === 'none'"), "a second click folds it")
        # Routine kinds: no chip, the rotate icon in the muted colour; a Continue the user asked for.
        post({"type": "row", "id": 11, "row": {"role": "inject", "content": "[Continue — requested by the user]\nThe previous turn was interrupted before it finished (a dropped connection, a restart, or a backend error) and the user has asked you to carry on.", "meta": {"mid": "i2", "injectKind": "recovery"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"recovery-card\"]').length === 2")
        cont = page.evaluate("""() => { const c = [...document.querySelectorAll('.log.on [data-testid="recovery-card"]')].pop(); return { kind: c.dataset.kind, severity: c.dataset.severity, title: c.querySelector('.rc-title').textContent, detail: c.querySelector('.rc-detail').textContent,
          chip: !!c.querySelector('[data-testid="recovery-card-chip"]'), icoColor: getComputedStyle(c.querySelector('.rc-ico')).color, textColor: getComputedStyle(c).color }; }""")
        check(cont["kind"] == "manual" and cont["severity"] == "routine" and cont["title"] == "Continued at your request" and cont["detail"] == "resuming the interrupted turn" and not cont["chip"], f"a Continue is the routine card without a chip ({cont['title']!r})")
        check(cont["icoColor"] == cont["textColor"], "a routine icon keeps the muted text colour")
        # A refusal with several bullets counts calls and patterns.
        post({"type": "row", "id": 11, "row": {"role": "inject", "content": "[Tool refusal — automatic recovery]\n- rm: Blocked by security policy: one\n- cp: Blocked by security policy: two", "meta": {"mid": "i3", "injectKind": "recovery"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"recovery-card\"]').length === 3")
        ref = page.evaluate("() => { const c = [...document.querySelectorAll('.log.on [data-testid=\"recovery-card\"]')].pop(); return [c.querySelector('.rc-title').textContent, c.querySelector('[data-testid=\"recovery-card-chip\"]').textContent]; }")
        check(ref == ["2 tool calls blocked", "2 patterns"], f"several blocked calls: counted title and chip ({ref})")
        # A generic recovery notice, an automation notice (nothing), a cron notification (a quiet row, as before).
        n_rows = page.evaluate("() => document.querySelectorAll('.log.on .row').length")
        post({"type": "row", "id": 11, "row": {"role": "inject", "content": "the gateway says hello", "meta": {"mid": "i4", "injectKind": "recovery"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"recovery-card\"]').length === 4")
        gen = page.evaluate("() => { const c = [...document.querySelectorAll('.log.on [data-testid=\"recovery-card\"]')].pop(); return [c.dataset.kind, c.querySelector('.rc-title').textContent, c.querySelector('.rc-detail').textContent]; }")
        check(gen == ["generic", "System notice", "injected by the gateway"], f"an unknown recovery notice is the generic card ({gen})")
        post({"type": "row", "id": 11, "row": {"role": "inject", "content": "[Automation] nothing to see", "meta": {"mid": "i5", "injectKind": "automation_notice"}}})
        post({"type": "row", "id": 11, "row": {"role": "inject", "content": "[Cron notification from \"watch\"]\nall quiet\n[End of cron notification]", "meta": {"mid": "i6", "injectKind": "cron"}}})
        page.wait_for_function("(n) => document.querySelectorAll('.log.on .row').length === n + 2", arg=n_rows)
        last = page.evaluate("() => { const r = [...document.querySelectorAll('.log.on .row')].pop(); return { cls: r.className, text: r.textContent.slice(0, 30) }; }")
        check(last["cls"] == "row tool" and last["text"].startswith("[Cron notification"), f"an automation notice draws nothing; a cron notification stays a quiet row ({last})")
        # The card fits a narrow sidebar: nothing overflows the pane.
        fit = page.evaluate("() => { const l = document.querySelector('.log.on'); return [...l.querySelectorAll('[data-testid=\"recovery-card\"]')].every((c) => c.getBoundingClientRect().right <= l.getBoundingClientRect().right + 1 && c.scrollWidth <= c.clientWidth + 1); }")
        check(fit, "every card stays inside a 420px pane (detail and chip truncate)")

        # ---- Kiro's task_status bookkeeping rows (the host persists them with no input and no
        # output): the row names the task from the action id and its body explains what it is.
        post({"type": "row", "id": 11, "row": {"role": "tool", "content": "🔧 task_status", "meta": {"tool_call_id": "toolu_bdrk_018Vex9cLiVXZq8nmRBxV3t5_taskStatus_1_1_Create__conne", "purpose": "", "input": "", "kind": "other", "mid": "ts1", "done": True, "output": ""}}})
        page.wait_for_selector(".log.on .row.tool.task")
        trow = page.evaluate("() => { const r = document.querySelector('.log.on .row.tool.task'); return { title: r.querySelector('.tool-title').textContent, ico: r.querySelector('.tool-ico').textContent, taskId: r.dataset.taskId, live: r.classList.contains('live') }; }")
        check(trow["title"] == "Task status · 1.1 Create conne…" and trow["ico"] == "📋" and trow["taskId"] == "1.1" and not trow["live"], f"the row names the task from the action id ({trow})")
        page.click(".log.on .row.tool.task .tool-head")
        page.wait_for_function("() => document.querySelector('.log.on .row.tool.task').dataset.open === 'true'")
        tbody = page.evaluate("() => { const r = document.querySelector('.log.on .row.tool.task'); const secs = [...r.querySelectorAll('.tool-sec')].filter((s) => !s.hidden); return { labels: secs.map((s) => s.querySelector('.tool-k').textContent), text: secs[0].querySelector('.tool-pre').textContent, muted: secs[0].querySelector('.tool-pre').classList.contains('muted') }; }")
        check(tbody["labels"] == ["Note"] and tbody["text"].startswith("Kiro's task orchestrator recorded a status change") and tbody["muted"], f"opened: no Input, a Note instead of '(no output)' ({tbody['labels']})")
        # A live one: the tool_call update that follows (title task_status, no input) does not undo the decoded title; an empty tool_result keeps the note.
        post({"type": "toolUpdate", "id": 11, "tcid": "toolu_bdrk_018Vex9cLiVXZq8nmRBxV3t5_taskStatus_1_1_Create__conne", "title": "task_status", "input": ""})
        post({"type": "toolResult", "id": 11, "tcid": "toolu_bdrk_018Vex9cLiVXZq8nmRBxV3t5_taskStatus_1_1_Create__conne", "output": ""})
        page.wait_for_timeout(30)
        after = page.evaluate("() => { const r = document.querySelector('.log.on .row.tool.task'); const shown = [...r.querySelectorAll('.tool-sec')].filter((s) => !s.hidden); return [r.querySelector('.tool-title').textContent, shown.length, shown[0].querySelector('.tool-pre').textContent.slice(0, 20)]; }")
        after = [after[0], after[2]] if after[1] == 1 else after
        check(after == ["Task status · 1.1 Create conne…", "Kiro's task orchestr"], f"the update and the empty result leave the decoded row alone ({after})")
        if args.shots:
            page.click(".log.on [data-testid=\"recovery-card\"] .rc-head")
            page.wait_for_timeout(50)
            page.screenshot(path=str(pathlib.Path(args.shots) / "recovery-cards.png"))
        # The command tip (the dashboard's tool-command-tip): resting the pointer on a collapsed shell
        # row whose label is its description shows the command, one grid line per pipeline segment.
        post({"type": "tabs", "tabs": [{"id": 12, "title": "tip", "running": False, "settings": {}}], "active": 12})
        cmd = "git status --short && git -P log --oneline -n 3 2>/dev/null | head -20; echo \"---\""
        post({"type": "row", "id": 12, "row": {"role": "tool", "content": "🔧 Check the mod repo state", "meta": {"tool_call_id": "run_command_1", "kind": "execute", "input": json.dumps({"command": cmd, "description": "Check the mod repo state"}), "output": "clean", "done": True}}})
        post({"type": "row", "id": 12, "row": {"role": "tool", "content": "🔧 ls", "meta": {"tool_call_id": "run_command_2", "kind": "execute", "input": json.dumps({"command": "ls"}), "output": "", "done": True}}})
        post({"type": "row", "id": 12, "row": {"role": "tool", "content": "🔧 @slack-enterprise-mcp/slack_read_channel", "meta": {"tool_call_id": "mcp_1", "kind": "other", "mcp_server": "slack-enterprise-mcp", "purpose": "Read the migration channel", "input": json.dumps({"channel_id": "C1", "limit": 100}), "output": "{}", "done": True}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.tool.call').length === 3")
        check(page.evaluate("() => { const h = document.querySelector('.log.on .row.tool.call .tool-head'); return [h.hasAttribute('title'), h.getAttribute('aria-label')]; }") == [False, "Show this call's input and output: Check the mod repo state"], "a shell row's header has no native tooltip; the click's effect is its accessible name")
        page.hover(".log.on .row.tool.call >> nth=0 >> .tool-head")
        page.wait_for_selector("#ktip:not([hidden])", timeout=2000)
        tip = page.evaluate("""() => { const t = document.getElementById('ktip'); const h = document.querySelector('.log.on .row.tool.call .tool-head'); const tr = t.getBoundingClientRect(), hr = h.getBoundingClientRect();
          const lines = [...t.querySelectorAll('.ktip-grid > .ktip-op')].map((g) => g.textContent); const segs = [...t.querySelectorAll('.ktip-grid > .ktip-seg')].map((s) => s.textContent);
          const kinds = [...t.querySelector('.ktip-grid > .ktip-seg').querySelectorAll('span')].map((s) => s.className);
          return { role: t.getAttribute('role'), shell: t.classList.contains('sh'), placement: t.dataset.placement, aboveOrBelow: tr.bottom <= hr.top || tr.top >= hr.bottom, leftAligned: Math.abs(tr.left - hr.left) < 2, inView: tr.left >= 8 && tr.right <= window.innerWidth - 8,
                   lines, segs, kinds, pipeClass: t.querySelector('.ktip-op.pipe')?.textContent ?? null, lit: h.dataset.tip, described: h.getAttribute('aria-describedby'), sr: t.querySelector('.ktip-sr').textContent, cut: !!t.querySelector('.ktip-cut') }; }""")
        check(tip["role"] == "tooltip" and tip["shell"] and tip["aboveOrBelow"] and tip["leftAligned"] and tip["inView"], f"the tip is a tooltip beside the header, left-aligned with it, inside the viewport ({tip['placement']}, above/below {tip['aboveOrBelow']}, left {tip['leftAligned']})")
        check(tip["lines"] == ["$", "&&", "|", ";"], f"one grid line per pipeline segment: $ then the operator in the gutter ({tip['lines']})")
        check(tip["segs"] == ["git status --short", "git -P log --oneline -n 3 2>/dev/null", "head -20", 'echo "---"'], f"each segment's text in its cell ({tip['segs']})")
        check(tip["kinds"][:5] == ["p-program", "p-text", "p-text", "p-text", "p-flag"], f"the program, then the flag, coloured by kind ({tip['kinds'][:5]})")
        check(tip["pipeClass"] == "|", "the pipe operator takes the accent class, the sequence operators stay muted")
        check(tip["lit"] == "true" and tip["described"] == "ktip" and tip["sr"] == cmd and not tip["cut"], f"the header is lit while the tip is open and described by it; the full command for a reader ({tip['lit']}, {tip['described']})")
        if args.shots:
            page.screenshot(path=str(pathlib.Path(args.shots) / "tool-command-tip.png"))
        page.mouse.move(5, 5)
        page.wait_for_function("() => document.getElementById('ktip').hidden")
        check(page.evaluate("() => document.querySelector('.log.on .row.tool.call .tool-head').dataset.tip") is None, "leaving the header hides the tip and unlights the header")
        # A row whose label IS the full command has nothing more to say (the dashboard's rule).
        page.hover(".log.on .row.tool.call >> nth=1 >> .tool-head")
        page.wait_for_timeout(250)
        check(page.evaluate("() => document.getElementById('ktip').hidden"), "a shell row labelled with its whole command shows no tip")
        # An MCP row whose label is the call's purpose tips its raw title as plain text.
        page.hover(".log.on .row.tool.call >> nth=2 >> .tool-head")
        page.wait_for_selector("#ktip:not([hidden])", timeout=2000)
        mcp = page.evaluate("() => { const t = document.getElementById('ktip'); return [t.classList.contains('txt'), t.querySelector('.ktip-grid') === null, t.querySelector('[aria-hidden]').textContent]; }")
        check(mcp == [True, True, "@slack-enterprise-mcp/slack_read_channel"], f"a purpose-labelled MCP row tips its raw title, as text ({mcp})")
        # Opening the row hides the tip and keeps it away while open; the body still shows the command.
        page.click(".log.on .row.tool.call >> nth=0 >> .tool-head")
        page.wait_for_timeout(30)
        check(page.evaluate("() => document.getElementById('ktip').hidden"), "the click that opens the row hides the tip")
        page.mouse.move(5, 5)
        page.hover(".log.on .row.tool.call >> nth=0 >> .tool-head")
        page.wait_for_timeout(250)
        check(page.evaluate("() => document.getElementById('ktip').hidden"), "an open row shows no tip (its body already shows the command)")
        # Keyboard: focus shows it, Escape hides it.
        page.click(".log.on .row.tool.call >> nth=0 >> .tool-head")  # close again
        page.mouse.move(5, 5)
        page.keyboard.press("Tab")
        page.evaluate("() => document.querySelector('.log.on .row.tool.call .tool-head').focus()")
        page.keyboard.press("Shift+Tab")
        page.keyboard.press("Tab")
        focused = page.evaluate("() => document.activeElement && document.activeElement.className")
        if focused == "tool-head":
            page.wait_for_selector("#ktip:not([hidden])", timeout=2000)
            check(True, "focusing the header with the keyboard shows the tip")
            page.keyboard.press("Escape")
            check(page.evaluate("() => document.getElementById('ktip').hidden"), "Escape hides it")
        # A long command is cut at 12 segments with the hint; a multi-line one is shown verbatim.
        long_cmd = " && ".join(f"step{i}" for i in range(15))
        post({"type": "row", "id": 12, "row": {"role": "tool", "content": "🔧 Fifteen steps", "meta": {"tool_call_id": "run_command_3", "kind": "execute", "input": json.dumps({"command": long_cmd}), "output": "", "done": True}}})
        post({"type": "row", "id": 12, "row": {"role": "tool", "content": "🔧 Two lines", "meta": {"tool_call_id": "run_command_4", "kind": "execute", "input": json.dumps({"command": "ls\nls -la"}), "output": "", "done": True}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.tool.call').length === 5")
        page.hover(".log.on .row.tool.call >> nth=3 >> .tool-head")
        page.wait_for_selector("#ktip:not([hidden])", timeout=2000)
        cut = page.evaluate("() => { const t = document.getElementById('ktip'); return [t.querySelectorAll('.ktip-grid > .ktip-op').length, t.querySelector('.ktip-cut')?.textContent]; }")
        check(cut == [12, "… Open the step to see the rest"], f"12 segments at most, then the hint ({cut})")
        page.mouse.move(5, 5)
        page.hover(".log.on .row.tool.call >> nth=4 >> .tool-head")
        page.wait_for_selector("#ktip:not([hidden])", timeout=2000)
        verbatim = page.evaluate("() => { const t = document.getElementById('ktip'); return [[...t.querySelectorAll('.ktip-grid > .ktip-op')].map((g) => g.textContent), t.querySelector('.ktip-seg').textContent, t.querySelector('.ktip-seg span') === null]; }")
        check(verbatim == [["$"], "ls\nls -la", True], f"a multi-line command is one verbatim cell behind a single $ ({verbatim})")
        page.mouse.move(5, 5)
        check(errors == [], f"no page errors ({errors})")
        browser.close()
    print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILURE(S)"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
