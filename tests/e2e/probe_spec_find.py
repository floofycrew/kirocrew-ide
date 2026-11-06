#!/usr/bin/env python3
"""Headless, self-contained: find-in-document in the Kiro spec editor.

The real ``specEditorHtml()`` document in a Chromium page with ``acquireVsCodeApi``
stubbed, fed the ``doc`` message the extension sends (``mdToHtml`` of a tasks.md),
then driven with the keyboard: Ctrl+F opens the bar and focuses it, typing marks
every match (case-insensitive) and reports "1 of N", Enter / Shift+Enter walk the
matches (wrapping, the current one scrolled into view and styled apart), Aa makes
it case-sensitive, Filter tasks hides the task rows that do not match while a
parent/sub-task match keeps a row, a document refresh re-applies the search, Esc
closes and leaves the text node whole again, the host's ``find`` message opens
the bar, and a design.md shows no filter button.

Usage: probe_spec_find.py      (needs Playwright + Chromium)
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent

STUB = """<script>
window.__posted = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => null, setState: () => {} });
</script>"""

TASKS_MD = """# Implementation Plan

- [x] 1. Spikes
  - [x] 1.1 Bootstrap the Manifest reader
  - _Requirements: 1.1_
- [-] 2. Manifest
  - [ ] 2.1 Parse the manifest header
  - [ ] 2.2 Validate entries
- [~] 3. Queued thing
- [ ] 4. Open task about the (regex) chars a+b
  - [ ] 4.1 Sub task
- [ ]* 5. Optional task

```js
const manifest = load("manifest.json"); // MANIFEST
```
"""


def render(mode, *args) -> str:
    out = subprocess.run(["node", str(HERE / "render_chat_html.mjs"), mode, *args], capture_output=True, text=True, check=True)
    return out.stdout


def main() -> int:
    from playwright.sync_api import sync_playwright

    failures: list[str] = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg)
        (failures.append(msg) if not cond else None)

    html = render("--spec", "demo", "tasks.md").replace("<head>", "<head>" + STUB, 1)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write(TASKS_MD)
        md_path = fh.name
    body = render("--md", md_path)
    tasks = [{"line": i, "status": "not_started", "optional": False} for i in range(9)]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 900, "height": 420})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.set_content(html, wait_until="domcontentloaded")
        page.wait_for_function("() => window.__posted.some((m) => m.type === 'ready')")
        post = lambda m: page.evaluate("(m) => window.postMessage(m, '*')", m)
        post({"type": "doc", "html": body, "engine": "mdToHtml", "tasks": tasks, "synced": False})
        page.wait_for_selector("#doc .box[data-line]")

        state = lambda: page.evaluate("""() => ({ hidden: document.getElementById('find').hidden, focused: document.activeElement === document.getElementById('findtext'),
          value: document.getElementById('findtext').value, count: document.getElementById('findcount').textContent, none: document.getElementById('find').classList.contains('none'),
          hits: document.querySelectorAll('#doc mark.hit').length, cur: [...document.querySelectorAll('#doc mark.hit')].findIndex((m) => m.classList.contains('cur')),
          curText: (document.querySelector('#doc mark.hit.cur') || {}).textContent || '', hidden_rows: document.querySelectorAll('#doc li.find-hide').length,
          filterShown: !document.getElementById('findfilter').hidden })""")
        check(state()["hidden"], "the bar starts hidden")
        page.keyboard.press("Control+f")
        page.wait_for_function("() => !document.getElementById('find').hidden")
        s = state()
        check(s["focused"], "Ctrl+F opens the bar and focuses its input")
        check(s["filterShown"], "tasks.md shows the Filter tasks toggle")
        page.keyboard.type("manifest")
        page.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length > 0")
        s = state()
        check(s["hits"] == 6 and s["count"] == "1 of 6", f"'manifest' marks 6 matches across rows and the code block (two in it), case-insensitively ({s['hits']}, {s['count']!r})")
        check(s["cur"] == 0 and s["curText"] == "Manifest", f"the first match (on or below the fold) is current ({s['curText']!r})")
        cur_bg = page.evaluate("() => getComputedStyle(document.querySelector('#doc mark.hit.cur')).backgroundColor")
        other_bg = page.evaluate("() => getComputedStyle(document.querySelectorAll('#doc mark.hit')[1]).backgroundColor")
        check(cur_bg != other_bg, f"the current match is styled apart ({cur_bg} vs {other_bg})")
        page.keyboard.press("Enter")
        s = state(); check(s["cur"] == 1 and s["count"] == "2 of 6", f"Enter moves to the next ({s['count']})")
        page.keyboard.press("Shift+Enter"); page.keyboard.press("Shift+Enter")
        s = state(); check(s["cur"] == 5 and s["count"] == "6 of 6", f"Shift+Enter walks back and wraps ({s['count']})")
        in_view = page.evaluate("() => { const r = document.querySelector('#doc mark.hit.cur').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }")
        check(in_view, "the current match is scrolled into view (the code block at the bottom)")
        check(page.evaluate("() => document.querySelector('#doc mark.hit.cur').closest('pre') !== null"), "code is searched too")
        # Aa: case-sensitive drops the lowercase ones.
        page.click("#findcase")
        page.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length === 3")
        s = state(); check(s["hits"] == 3 and s["curText"] == "manifest" and s["count"] == "1 of 3", f"Aa: the typed lowercase query keeps only the 3 lowercase matches ({s['hits']}, {s['curText']!r})")
        page.click("#findcase")
        page.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length === 6")
        # Filter tasks: rows without a match go; 1.1 matches so 1 (its parent) stays; 2 matches so 2.1/2.2 (its sub-tasks) stay.
        page.click("#findfilter")
        page.wait_for_function("() => document.querySelectorAll('#doc li.find-hide').length > 0")
        visible = page.evaluate("() => [...document.querySelectorAll('#doc li')].filter((li) => !li.classList.contains('find-hide') && !li.closest('li.find-hide')).map((li) => li.firstChild && li.textContent.trim().slice(0, 28))")
        hidden = page.evaluate("() => [...document.querySelectorAll('#doc li.find-hide')].map((li) => li.textContent.trim().slice(0, 20))")
        check(any(v.startswith("1. Spikes") or "Spikes" in v for v in visible) and any("Parse the manifest" in v for v in visible) and any("Validate entries" in v for v in visible),
              f"filter keeps a matching row's parent and a matching parent's sub-tasks ({visible})")
        check(any("Queued thing" in h for h in hidden) and any("Open task" in h for h in hidden) and any("Optional task" in h for h in hidden) and any("Requirements: 1.1" in h for h in hidden), f"rows without a match are hidden ({hidden})")
        # Typing a query nothing matches: 'No results', the input tinted, the filter releases every row.
        page.fill("#findtext", "zzqx")
        page.wait_for_function("() => document.getElementById('findcount').textContent === 'No results'")
        s = state(); check(s["none"] and s["hits"] == 0 and s["hidden_rows"] == 0, f"no match: tinted, nothing marked, no row hidden ({s['hidden_rows']})")
        # Regex metacharacters are literal.
        page.fill("#findtext", "(regex) chars a+b")
        page.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length === 1")
        check(state()["count"] == "1 of 1", "regex metacharacters in the query are searched literally")
        # A refresh of the document keeps the search live.
        page.fill("#findtext", "manifest")
        page.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length === 6")
        post({"type": "doc", "html": body.replace("Validate entries", "Validate the manifest entries"), "engine": "mdToHtml", "tasks": tasks, "synced": True})
        page.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length === 7")
        check(state()["count"].endswith("of 7"), "a document refresh re-applies the open search")
        # Esc closes, removes the marks and re-joins the text nodes; the filter releases the rows.
        page.keyboard.press("Escape")
        page.wait_for_function("() => document.getElementById('find').hidden")
        s = state()
        joined = page.evaluate("() => { const li = [...document.querySelectorAll('#doc li')].find((l) => l.textContent.includes('Bootstrap the Manifest reader')); return li.childNodes.length <= 4 && !li.querySelector('mark'); }")
        check(s["hits"] == 0 and s["hidden_rows"] == 0 and joined, "Esc closes: no marks, no hidden rows, text nodes whole again")
        # The host's keybinding arrives as a message and opens the bar with the previous query kept.
        post({"type": "find"})
        page.wait_for_function("() => !document.getElementById('find').hidden")
        s = state(); check(s["focused"] and s["value"] == "manifest" and s["hits"] == 7, f"the 'find' message opens the bar and re-runs the kept query ({s['value']!r}, {s['hits']})")
        # The 🔍 button does the same; F3 walks.
        page.keyboard.press("Escape")
        page.click("#findbtn")
        page.wait_for_function("() => !document.getElementById('find').hidden")
        page.keyboard.press("F3")
        check(state()["count"] == "2 of 7", f"F3 walks to the next match ({state()['count']})")
        # Selected text seeds the query, as the editor's find does.
        page.keyboard.press("Escape")
        page.evaluate("() => { const h = [...document.querySelectorAll('#doc li')].find((l) => l.textContent.includes('Queued thing')); const r = document.createRange(); const t = [...h.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.includes('Queued')); r.setStart(t, t.nodeValue.indexOf('Queued')); r.setEnd(t, t.nodeValue.indexOf('Queued') + 6); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }")
        page.keyboard.press("Control+f")
        page.wait_for_function("() => document.getElementById('findtext').value === 'Queued'")
        check(state()["count"] == "1 of 1", "a selection seeds the query")
        check(errors == [], f"no page errors ({errors})")
        # design.md: same bar, no task filter.
        page2 = browser.new_page(viewport={"width": 900, "height": 420})
        page2.set_content(render("--spec", "demo", "design.md").replace("<head>", "<head>" + STUB, 1), wait_until="domcontentloaded")
        page2.wait_for_function("() => window.__posted.some((m) => m.type === 'ready')")
        page2.evaluate("(m) => window.postMessage(m, '*')", {"type": "doc", "html": "<h1>Design</h1><p>The Manifest reader and its manifest cache.</p>", "engine": "mdToHtml", "tasks": [], "synced": False})
        page2.wait_for_selector("#doc h1")
        page2.keyboard.press("Control+f"); page2.keyboard.type("manifest")
        page2.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length === 2")
        check(page2.evaluate("() => document.getElementById('findfilter').hidden"), "design.md: the bar works, the task filter is not offered")
        browser.close()
    print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILURE(S)"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
