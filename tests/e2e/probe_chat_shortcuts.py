"""Headless check of the chat webview's Kiro-parity shortcuts (spec kiro-ide-parity, task 10.5):
the tab shortcuts forwarded as messages (8.1, 8.2), the find bar (8.3), approve-all /
reject-all over staged approval cards (8.4), ``kirocrew.toolCardDisplayMode`` (8.5), and a
regression pass (8.6) that the follow pill, image lightbox, command tip, pinned prompt,
recovery cards and thinking blocks still render as probe_chat_webview.py asserts them.

Same harness as probe_chat_webview.py: the real ``chatHtml()`` document with
``acquireVsCodeApi`` stubbed, driven with the messages ``ChatView.post`` sends.

Usage: probe_chat_shortcuts.py      (needs Playwright + Chromium)
"""

from __future__ import annotations

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from probe_chat_webview import chat_html  # noqa: E402

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwHwyBNAMDAO1ZD/lO4lZgAAAAAElFTkSuQmCC"  # 2x2 png


def tab(i, title, running=False):
    return {"id": i, "title": title, "running": running, "settings": {}}


def perm(tab_id, rid):
    return {"type": "row", "id": tab_id, "row": {"role": "permission", "content": "", "meta": {"tool_name": "execute_bash", "request_id": rid, "full_command": "ls " + rid}}}


def shell_row(tab_id, tcid, label, command, done=True, output="ok"):
    return {"type": "row", "id": tab_id, "row": {"role": "tool", "content": "🔧 " + label, "meta": {"tool_call_id": tcid, "kind": "execute", "input": json.dumps({"command": command, "description": label}), "output": output, "done": done}}}


def main() -> int:
    from playwright.sync_api import sync_playwright

    failures: list[str] = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg)
        (failures.append(msg) if not cond else None)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 420, "height": 700})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.set_content(chat_html(), wait_until="domcontentloaded")
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'ready')")

        def post(m):
            page.evaluate("(m) => window.postMessage(m, '*')", m)

        def posted():
            return page.evaluate("() => window.__posted")

        def since(n, kinds=None):
            return [m for m in posted()[n:] if kinds is None or m["type"] in kinds]

        count = lambda: page.evaluate("() => document.getElementById('findcount').textContent")
        cards = lambda: page.evaluate("() => document.querySelectorAll('.log.on [data-testid=\"approval-card\"]').length")

        # ---- 8.1 / 8.2: tab shortcuts arrive as messages and take the strip's own paths
        post({"type": "tabs", "tabs": [tab(1, "one"), tab(2, "two"), tab(3, "three")], "active": 3})
        page.wait_for_function("() => document.querySelectorAll('#tabs .tab').length === 3 && document.querySelector('.log.on[data-id=\"3\"]')")
        ids = page.evaluate("() => [...document.querySelectorAll('#tabs .tab')].map((t) => t.dataset.id)")
        check(ids == ["1", "2", "3"], f"three tabs carry data-id in strip order ({ids})")
        n = len(posted()); post({"type": "tabs.next"}); page.wait_for_timeout(30)
        check(since(n) == [{"type": "select", "id": 1}], f"tabs.next on the last tab posts select for the first (wrap) ({since(n)})")
        n = len(posted()); post({"type": "tabs.prev"}); page.wait_for_timeout(30)
        check(since(n) == [{"type": "select", "id": 2}], f"tabs.prev posts select for the second ({since(n)})")
        post({"type": "tabs", "tabs": [tab(1, "one"), tab(2, "two"), tab(3, "three")], "active": 1})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"1\"]')")
        n = len(posted()); post({"type": "tabs.prev"}); page.wait_for_timeout(30)
        check(since(n) == [{"type": "select", "id": 3}], f"tabs.prev on the first wraps to the last ({since(n)})")
        n = len(posted()); post({"type": "tabs.close"}); page.wait_for_timeout(30)
        check(since(n) == [{"type": "close", "id": 1}], f"tabs.close posts close for the active tab ({since(n)})")
        n = len(posted()); post({"type": "tabs.new"}); page.wait_for_timeout(30)
        check(since(n) == [{"type": "new"}], f"tabs.new posts new ({since(n)})")
        post({"type": "tabs.rename", "id": 2, "title": "renamed"})
        page.wait_for_function("() => document.querySelector('#tabs .tab[data-id=\"2\"] .t').textContent === 'renamed'")
        labels = page.evaluate("() => [...document.querySelectorAll('#tabs .tab .t')].map((t) => t.textContent)")
        check(labels == ["one", "renamed", "three"], f"tabs.rename changes that tab's label and no other ({labels})")
        n = len(posted()); page.dblclick("#tabs .tab[data-id='3']"); page.wait_for_timeout(30)
        check({"type": "rename", "id": 3} in since(n), f"double-clicking a tab asks the extension to rename it ({since(n)})")
        page.click("#tabs .tab[data-id='3']", button="right")
        page.wait_for_selector("#menu.on")
        items = page.evaluate("() => [...document.querySelectorAll('#menu .it')].map((i) => i.textContent.trim())")
        check(items[:1] == ["Rename"] and "Close tab" in items, f"right-click offers Rename (and Close tab) ({items})")
        n = len(posted()); page.click("#menu .it >> nth=0"); page.wait_for_timeout(30)
        check({"type": "rename", "id": 3} in since(n), "picking Rename posts rename for that tab")
        post({"type": "tabs", "tabs": [tab(1, "one")], "active": 1})
        page.wait_for_function("() => document.querySelectorAll('#tabs .tab').length === 1")
        n = len(posted()); post({"type": "tabs.next"}); post({"type": "tabs.prev"}); page.wait_for_timeout(30)
        check(since(n) == [], "with one tab, next/prev post nothing")

        # ---- 8.3: the find bar over the transcript
        post({"type": "tabs", "tabs": [tab(4, "find")], "active": 4})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"4\"]')")
        post({"type": "user", "id": 4, "text": "Please grep the Parser for errors"})
        post({"type": "row", "id": 4, "row": {"role": "tool", "content": "grep parser src/", "meta": {"tool_name": "grep", "input": "parser hidden body", "output": "parser:1"}}})
        post({"type": "row", "id": 4, "row": {"role": "assistant", "content": "The parser is fine.\n\n" + "\n\n".join(f"line {i}" for i in range(60)) + "\n\n```js\nconst parser = 1;\n```\n", "meta": {}}})
        post({"type": "done", "id": 4})
        page.wait_for_selector(".log.on .row.assistant")
        before = page.evaluate("() => document.querySelector('.log.on').innerHTML")
        check(page.evaluate("() => document.getElementById('find').hidden"), "the bar is hidden until asked for")
        # Park the view with the user bubble and the tool row above the fold: the search starts at the first match in view.
        page.evaluate("() => { const l = document.querySelector('.log.on'); l.scrollTop = l.querySelector('.row.assistant').offsetTop; }")
        page.wait_for_function("() => { const l = document.querySelector('.log.on'); return l.scrollTop > 0 && l.scrollHeight > l.clientHeight; }")
        post({"type": "find.open"})
        page.wait_for_function("() => !document.getElementById('find').hidden")
        bar = page.evaluate("() => { const f = document.getElementById('find'); return { testid: f.dataset.testid, focused: document.activeElement === document.getElementById('findtext'), live: document.getElementById('findcount').getAttribute('aria-live'), pressed: document.getElementById('findcase').getAttribute('aria-pressed') }; }")
        check(bar["testid"] == "find-bar" and bar["focused"] and bar["live"] and bar["pressed"] == "false", f"find.open shows the bar and focuses its input; the count is live, Aa off ({bar})")
        page.keyboard.type("parser")
        # typing is debounced: wait for the run on the whole word (an Enter during the debounce searches instead of stepping)
        page.wait_for_function("() => { const ms = [...document.querySelectorAll('mark.hit')]; return ms.length === 4 && ms.every((m) => m.textContent.toLowerCase() === 'parser'); }")
        where = page.evaluate("() => [...document.querySelectorAll('mark.hit')].map((m) => m.closest('.tool-title') ? 'label' : m.closest('code') ? 'code' : m.closest('.user') ? 'user' : m.closest('.assistant') ? 'text' : 'other')")
        check(where == ["user", "label", "text", "code"], f"a query matching user text, a tool label, prose and code marks all four, hidden tool body skipped ({where})")
        check(count() == "3 of 4" and page.evaluate("() => document.querySelectorAll('mark.hit')[2].classList.contains('cur')"), f"the count is 'N of 4' and the current match carries .cur ({count()!r})")
        page.keyboard.press("Enter"); check(count() == "4 of 4", f"Enter steps forward ({count()!r})")
        page.keyboard.press("Enter"); check(count() == "1 of 4", f"Enter wraps to the first ({count()!r})")
        page.keyboard.press("Shift+Enter"); check(count() == "4 of 4", f"Shift+Enter steps back, wrapping ({count()!r})")
        page.click("#findprev"); check(count() == "3 of 4", f"↑ steps back ({count()!r})")
        page.click("#findnext"); check(count() == "4 of 4", f"↓ steps forward ({count()!r})")
        in_view = page.evaluate("() => { const r = document.querySelector('mark.hit.cur').getBoundingClientRect(); const p = document.getElementById('panes').getBoundingClientRect(); return r.top >= p.top && r.bottom <= p.bottom; }")
        check(in_view, "the current match (in the code block, far down) is scrolled into view")
        page.click("#findcase")
        page.wait_for_function("() => document.getElementById('findcount').textContent.endsWith(' of 3')")
        cs = page.evaluate("() => ({ pressed: document.getElementById('findcase').getAttribute('aria-pressed'), where: [...document.querySelectorAll('mark.hit')].map((m) => m.closest('.user') ? 'user' : 'other') })")
        check(cs["pressed"] == "true" and cs["where"] == ["other", "other", "other"], f"Aa is pressed and the capitalised 'Parser' in the user turn drops out: 3 matches ({cs})")
        page.fill("#findtext", "zzzz")
        page.wait_for_function("() => document.getElementById('findcount').textContent === 'No results'")
        check(page.evaluate("() => document.getElementById('find').classList.contains('none') && document.querySelectorAll('mark.hit').length === 0"), "'No results' with the error outline and no marks")
        # Follow is suspended while the bar is open: new content leaves the view alone and the jump pill announces it.
        page.fill("#findtext", "parser")
        page.wait_for_function("() => document.querySelectorAll('mark.hit').length === 3")
        page.evaluate("() => { document.querySelector('.log.on').scrollTop = 0; }")
        page.wait_for_timeout(50)
        post({"type": "row", "id": 4, "row": {"role": "assistant", "content": "another parser note\n" + "x\n" * 30, "meta": {}}})
        page.wait_for_function("() => document.querySelectorAll('mark.hit').length === 4")
        check(page.evaluate("() => document.querySelector('.log.on').scrollTop") == 0 and count() == "1 of 4", f"a new row while the bar is open re-runs the search without moving the view ({count()!r})")
        check(not page.evaluate("() => document.getElementById('jump').hidden"), "the jump pill shows for the unseen content")
        page.focus("#findtext"); page.keyboard.press("Escape")
        page.wait_for_function("() => document.getElementById('find').hidden")
        after = page.evaluate("() => document.querySelector('.log.on').innerHTML")
        check(page.evaluate("() => document.querySelectorAll('mark').length") == 0, "Esc hides the bar and leaves zero mark elements")
        check(after.startswith(before[: before.rfind('<div class="work')]), "the rows' HTML is what it was before the search")
        page.focus("#text"); page.keyboard.press("Control+f")
        page.wait_for_function("() => !document.getElementById('find').hidden")
        check(count().endswith(" of 4"), f"Ctrl+F on the page reopens the bar with the kept query ({count()!r})")
        page.click("#findclose")
        check(page.evaluate("() => document.getElementById('find').hidden && !document.querySelector('mark')"), "✕ closes and clears")

        # ---- 8.4: approve-all / reject-all over the active tab's pending approval cards
        post({"type": "tabs", "tabs": [tab(5, "a"), tab(6, "b")], "active": 5})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"5\"]')")
        post(perm(5, "r1")); post(perm(5, "r2")); post(perm(6, "other"))
        page.wait_for_function("() => document.querySelectorAll('[data-testid=\"approval-card\"]').length === 3")
        check(page.evaluate("() => document.querySelectorAll('.log.on [data-testid=\"approval-card\"] button[data-action=\"approved\"], .log.on [data-testid=\"approval-card\"] button[data-action=\"rejected\"]').length") == 4, "each staged card has an approve and a reject button")
        n = len(posted()); post({"type": "approvals.approveAll"}); page.wait_for_timeout(50)
        new = [(m["type"], m["id"], m["requestId"], m["action"]) for m in since(n)]
        check(new == [("approve", 5, "r1", "approved"), ("approve", 5, "r2", "approved")], f"approveAll posts the two approve messages in order ({new})")
        check(cards() == 0 and page.evaluate("() => document.querySelectorAll('[data-testid=\"approval-card\"]').length") == 1, "both cards of the active tab are gone; the other tab's stays")
        post(perm(5, "r3")); post(perm(5, "r4"))
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"approval-card\"]').length === 2")
        n = len(posted()); post({"type": "approvals.rejectAll"}); page.wait_for_timeout(50)
        new = [(m["type"], m["requestId"], m["action"]) for m in since(n)]
        check(new == [("approve", "r3", "rejected"), ("approve", "r4", "rejected")] and cards() == 0, f"rejectAll posts the two reject messages in order and removes the cards ({new})")
        n = len(posted()); post({"type": "approvals.approveAll"}); post({"type": "approvals.rejectAll"}); page.wait_for_timeout(50)
        check(since(n) == [], f"nothing pending: approveAll / rejectAll post nothing ({since(n)})")
        post(perm(5, "r5"))
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"approval-card\"]').length === 1")
        page.fill("#text", "keep me"); page.focus("#text")
        n = len(posted()); page.keyboard.press("Control+Enter"); page.wait_for_timeout(50)
        check([(m["requestId"], m["action"]) for m in since(n)] == [("r5", "approved")] and page.input_value("#text") == "keep me", f"Ctrl+Enter with a card pending approves it and keeps the composer text ({since(n)})")
        post(perm(5, "r6"))
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"approval-card\"]').length === 1")
        n = len(posted()); page.keyboard.press("Control+Shift+C"); page.wait_for_timeout(50)
        check([(m["requestId"], m["action"]) for m in since(n)] == [("r6", "rejected")], f"Ctrl+Shift+C on the page rejects the pending card ({since(n)})")
        n = len(posted()); page.focus("#text"); page.keyboard.press("Control+Enter"); page.wait_for_timeout(50)
        new = since(n)
        check(len(new) == 1 and new[0]["type"] == "send" and new[0]["text"] == "keep me", f"Ctrl+Enter with nothing pending sends ({[m['type'] for m in new]})")

        # ---- 8.5: toolCardDisplayMode
        post({"type": "tabs", "tabs": [tab(7, "mode", running=True)], "active": 7})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"7\"]')")
        post(shell_row(7, "m1", "finished at arrival", "ls", done=True))
        post(shell_row(7, "m2", "still running", "sleep 1", done=False, output=""))
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.tool.call').length === 2")
        opens = lambda: page.evaluate("() => [...document.querySelectorAll('.log.on .row.tool.call')].map((r) => r.dataset.open)")
        check(opens() == ["false", "false"], f"default (collapseOnComplete): rows arrive folded ({opens()})")
        post({"type": "toolResult", "id": 7, "tcid": "m2", "output": "done"})
        page.wait_for_function("() => !document.querySelector('.log.on .row.tool.call[data-tcid=\"m2\"]').classList.contains('live')")
        check(opens() == ["false", "false"], f"a finished row stays folded under the default ({opens()})")
        post({"type": "toolCardDisplayMode", "mode": "alwaysExpanded"})
        page.wait_for_function("() => [...document.querySelectorAll('.log.on .row.tool.call')].every((r) => r.dataset.open === 'true')")
        check(page.evaluate("() => [...document.querySelectorAll('.log.on .row.tool.call .tool-body')].every((b) => !b.hidden)"), "alwaysExpanded opens the finished rows, bodies shown")
        post(shell_row(7, "m3", "arrives expanded", "pwd", done=False, output=""))
        page.wait_for_function("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m3\"]')")
        check(page.evaluate("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m3\"]').dataset.open") == "true", "under alwaysExpanded a new row opens on arrival")
        post({"type": "toolResult", "id": 7, "tcid": "m3", "output": "/w"})
        page.wait_for_timeout(30)
        check(page.evaluate("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m3\"]').dataset.open") == "true", "…and stays open once its result lands")
        page.click(".log.on .row.tool.call[data-tcid='m1'] .tool-head")  # the user folds one by hand
        page.wait_for_function("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m1\"]').dataset.open === 'false'")
        post({"type": "toolCardDisplayMode", "mode": "collapseOnComplete"})
        page.wait_for_function("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m2\"]').dataset.open === 'false'")
        check(opens() == ["false", "false", "false"] and page.evaluate("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m1\"]').dataset.userToggled") == "true", f"back to collapseOnComplete folds the finished rows; the hand-toggled row keeps its mark ({opens()})")
        page.click(".log.on .row.tool.call[data-tcid='m2'] .tool-head")
        page.wait_for_function("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m2\"]').dataset.open === 'true'")
        post({"type": "toolResult", "id": 7, "tcid": "m2", "output": "done again"})
        page.wait_for_timeout(30)
        check(page.evaluate("() => document.querySelector('.log.on .row.tool.call[data-tcid=\"m2\"]').dataset.open") == "true", "a row the user opened is not folded by a later result (data-user-toggled guard)")
        post({"type": "done", "id": 7})

        # ---- 8.6 regression: the transcript features of probe_chat_webview.py still render
        # thinking blocks: deltas accumulate into one collapsed live block that opens on click
        post({"type": "tabs", "tabs": [tab(8, "think", running=True)], "active": 8})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"8\"]')")
        post({"type": "user", "id": 8, "text": "hello"})
        deltas = ["It seems ", "the parser ", "grabs the whole line."]
        for d in deltas:
            post({"type": "thinking", "id": 8, "text": d})
        page.wait_for_selector('.log.on [data-testid="think-block"]')
        tb = page.evaluate("""() => { const b = document.querySelector('.log.on [data-testid="think-block"]'); return { n: document.querySelectorAll('.log.on [data-testid="think-block"]').length, live: b.classList.contains('live'), label: b.querySelector('.think-label').textContent, open: b.dataset.open, body: b.querySelector('[data-testid="think-body"]').textContent, rows: document.querySelectorAll('.log.on .row.thinking').length }; }""")
        check(tb["n"] == 1 and tb["live"] and tb["label"] == "Thinking" and tb["open"] == "false" and tb["body"] == "".join(deltas) and tb["rows"] == 0, f"thinking deltas render as one collapsed live block with the concatenated body ({tb})")
        page.click('.log.on [data-testid="think-block"] .think-head')
        page.wait_for_function("() => document.querySelector('.log.on [data-testid=\"think-block\"]').dataset.open === 'true'")
        check(page.evaluate("() => !document.querySelector('.log.on [data-testid=\"think-body\"]').hidden"), "clicking the header expands the thinking body")
        post({"type": "done", "id": 8})
        # recovery cards: a blocked tool call is the collapsed attention card with the pattern chip
        blocked = ("[Tool blocked — reason sent to the agent] policy\n[Kiro Crew host notice] The tool call you just made was blocked by a Kiro Crew safety policy.\n\n"
                   "Blocked: cat /tmp/x.py: Blocked by security policy: (?:\\A|[;&|\\n`])kiro[-.]?crew\\b[^|;&#>/*]*\\btoken\\b\nMatched structurally on the command's argv.")
        post({"type": "row", "id": 8, "row": {"role": "inject", "content": blocked, "meta": {"mid": "i1"}}})
        page.wait_for_selector('.log.on [data-testid="recovery-card"]')
        rc = page.evaluate("""() => { const c = document.querySelector('.log.on [data-testid="recovery-card"]'); return { kind: c.dataset.kind, severity: c.dataset.severity, open: c.dataset.open, title: c.querySelector('.rc-title').textContent, chip: c.querySelector('[data-testid="recovery-card-chip"]').textContent, bodyShown: getComputedStyle(c.querySelector('[data-testid="recovery-card-body"]')).display !== 'none' }; }""")
        check(rc["kind"] == "tool_blocked" and rc["severity"] == "attention" and rc["open"] == "false" and rc["title"] == "Tool call blocked" and rc["chip"].endswith("\\btoken\\b") and not rc["bodyShown"], f"a blocked call is the collapsed attention card with the pattern chip ({rc})")
        page.click('.log.on [data-testid="recovery-card"] .rc-head')
        page.wait_for_function("() => document.querySelector('.log.on [data-testid=\"recovery-card\"]').dataset.open === 'true'")
        check(page.evaluate("() => document.querySelector('.log.on [data-testid=\"recovery-card-body\"]').textContent.startsWith('[Kiro Crew host notice]')"), "a click opens the card to the notice")
        post({"type": "row", "id": 8, "row": {"role": "inject", "content": "[Continue — requested by the user]\ncarry on", "meta": {"mid": "i2", "injectKind": "recovery"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on [data-testid=\"recovery-card\"]').length === 2")
        check(page.evaluate("() => { const c = [...document.querySelectorAll('.log.on [data-testid=\"recovery-card\"]')].pop(); return [c.dataset.kind, c.dataset.severity, c.querySelector('.rc-title').textContent]; }") == ["manual", "routine", "Continued at your request"], "a Continue is the routine card")
        # command tip: hovering a collapsed shell row labelled by its description shows the command grid
        cmd = "git status --short && git -P log -n 3 | head -20"
        post({"type": "tabs", "tabs": [tab(9, "tip")], "active": 9})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"9\"]')")
        post(shell_row(9, "run_command_1", "Check the repo state", cmd))
        page.wait_for_selector(".log.on .row.tool.call .tool-head")
        page.hover(".log.on .row.tool.call .tool-head")
        page.wait_for_selector("#ktip:not([hidden])", timeout=2000)
        tip = page.evaluate("""() => { const t = document.getElementById('ktip'); const h = document.querySelector('.log.on .row.tool.call .tool-head'); return { role: t.getAttribute('role'), shell: t.classList.contains('sh'), ops: [...t.querySelectorAll('.ktip-grid > .ktip-op')].map((g) => g.textContent), segs: [...t.querySelectorAll('.ktip-grid > .ktip-seg')].map((s) => s.textContent), lit: h.dataset.tip, sr: t.querySelector('.ktip-sr').textContent }; }""")
        check(tip["role"] == "tooltip" and tip["shell"] and tip["ops"] == ["$", "&&", "|"] and tip["segs"] == ["git status --short", "git -P log -n 3", "head -20"] and tip["lit"] == "true" and tip["sr"] == cmd, f"the command tip shows one grid line per pipeline segment ({tip})")
        page.mouse.move(5, 5)
        page.wait_for_function("() => document.getElementById('ktip').hidden")
        check(page.evaluate("() => document.querySelector('.log.on .row.tool.call .tool-head').dataset.tip") is None, "leaving the header hides the tip")
        # lightbox: an echoed user turn with an image opens the lightbox naming the file; Esc closes it
        post({"type": "user", "id": 9, "text": "what is this", "files": [{"name": "shot.png", "path": "/home/u/.kiro/crew/uploads/2_shot.png", "image": True, "data": "data:image/png;base64," + PNG}]})
        page.wait_for_selector(".log.on .row.user .att img")
        page.click(".log.on .row.user .att img")
        page.wait_for_selector("#lightbox.on")
        lb = page.evaluate("() => ({ name: document.querySelector('#lightbox .lb-name').textContent, src: document.querySelector('#lightbox img').src.slice(0, 21), open: !document.querySelector('#lightbox .lb-open').hidden, path: document.querySelector('#lightbox .lb-open').dataset.path })")
        check(lb["name"] == "shot.png" and lb["src"] == "data:image/png;base64" and lb["open"] and lb["path"].endswith("2_shot.png"), f"clicking the picture opens the lightbox with its name and Open file ({lb})")
        page.keyboard.press("Escape")
        page.wait_for_function("() => !document.getElementById('lightbox').classList.contains('on')")
        check(True, "Esc closes the lightbox")
        # pinned prompt: scrolled past the first turn its text is pinned top-right; the pin's own layout pass is retried, not timed
        post({"type": "tabs", "tabs": [tab(10, "pin")], "active": 10})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"10\"]')")
        post({"type": "user", "id": 10, "text": "first question about the parser " + "with a long tail of detail " * 12})
        post({"type": "row", "id": 10, "row": {"role": "assistant", "content": "\n".join(f"answer line {i}" for i in range(60)), "meta": {}}})
        post({"type": "user", "id": 10, "text": "second question, short"})
        post({"type": "row", "id": 10, "row": {"role": "assistant", "content": "\n".join(f"more {i}" for i in range(200)), "meta": {}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.user').length === 2")
        page.evaluate("() => { document.querySelector('.log.on').scrollTop = 0; }")
        page.wait_for_function("() => document.getElementById('pin').hidden", timeout=3000)
        check(True, "scrolled to the top, nothing is pinned")
        page.evaluate("() => { const l = document.querySelector('.log.on'); const u = l.querySelectorAll('.row.user')[0]; l.scrollTop = u.offsetTop + u.offsetHeight + 40; }")
        page.wait_for_function("() => !document.getElementById('pin').hidden && document.querySelector('#pin .pin-text').textContent.startsWith('first question')", timeout=3000)
        pinned = page.evaluate("""() => { const pin = document.getElementById('pin'), t = pin.querySelector('.pin-text'), card = pin.querySelector('.pin-card'); const pr = pin.parentElement.getBoundingClientRect(), cr = card.getBoundingClientRect(), tr = t.getBoundingClientRect();
          return { lines: Math.round(tr.height / parseFloat(getComputedStyle(t).lineHeight)), right: Math.abs(pr.right - 8 - cr.right) < 3, top: cr.top - pr.top, more: pin.classList.contains('more') }; }""")
        check(pinned["lines"] == 1 and pinned["right"] and 0 <= pinned["top"] <= 8 and pinned["more"], f"the first prompt is pinned top-right, one line, with the ⌄ ({pinned})")
        page.evaluate("() => { const l = document.querySelector('.log.on'); l.scrollTop = l.scrollHeight; }")
        page.wait_for_function("() => !document.getElementById('pin').hidden && document.querySelector('#pin .pin-text').textContent === 'second question, short'", timeout=3000)
        check(True, "at the bottom the second prompt takes over the pin")
        page.click("#pin .pin-text")
        page.wait_for_function("() => { const l = document.querySelector('.log.on'); const u = l.querySelectorAll('.row.user')[1]; return Math.abs(l.scrollTop - (u.offsetTop - 8)) < 2; }")
        page.wait_for_function("() => document.getElementById('pin').hidden", timeout=3000)
        check(True, "clicking the card jumps to that turn and the card steps aside")
        # follow pill: scrolled up, a new row does not move the view and the pill says New messages; a click re-arms following
        post({"type": "tabs", "tabs": [tab(11, "follow")], "active": 11})
        page.wait_for_function("() => document.querySelector('.log.on[data-id=\"11\"]')")
        post({"type": "user", "id": 11, "text": "tell me a long story"})
        for i in range(30):
            post({"type": "row", "id": 11, "row": {"role": "assistant", "content": f"paragraph {i}\nline\nline", "meta": {"mid": f"f{i}"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.assistant').length === 30")
        geo = lambda: page.evaluate("""() => { const log = document.querySelector('.log.on'); const j = document.getElementById('jump');
          return { atBottom: log.scrollHeight - log.scrollTop - log.clientHeight <= 8, jump: !j.hidden, label: j.querySelector('.jl').textContent, isNew: j.classList.contains('new'), top: log.scrollTop }; }""")
        g = geo(); check(g["atBottom"] and not g["jump"], f"at the bottom after new rows: following, no pill ({g})")
        page.evaluate("() => { document.querySelector('.log.on').scrollTop = 120; }")
        page.wait_for_function("() => !document.getElementById('jump').hidden")
        g = geo(); check(g["label"] == "Jump to latest" and not g["isNew"], f"scrolled up: the pill shows, nothing new yet ({g['label']!r})")
        top_before = g["top"]
        post({"type": "row", "id": 11, "row": {"role": "assistant", "content": "a fresh paragraph while you read", "meta": {"mid": "f-new"}}})
        page.wait_for_function("() => document.getElementById('jump').classList.contains('new')")
        g = geo(); check(g["top"] == top_before and g["label"] == "New messages", f"a new row leaves the view alone and the pill says New messages ({g})")
        page.click("#jump")
        page.wait_for_function("() => { const log = document.querySelector('.log.on'); return log.scrollHeight - log.scrollTop - log.clientHeight <= 8; }")
        page.wait_for_function("() => document.getElementById('jump').hidden")
        check(True, "clicking the pill scrolls to the bottom and hides it")
        post({"type": "row", "id": 11, "row": {"role": "assistant", "content": "and following resumed", "meta": {"mid": "f-follow"}}})
        page.wait_for_function("() => document.querySelectorAll('.log.on .row.assistant').length === 32")
        g = geo(); check(g["atBottom"] and not g["jump"], f"following is re-armed after the jump ({g})")

        check(errors == [], f"no page errors ({errors})")
        browser.close()
    print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILURE(S)"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
