"""Headless probe of the spec editor's tasks.md view (Kiro-style task running).

Drives the real ``specEditorHtml()`` document in Chromium with
``acquireVsCodeApi`` stubbed and the same messages the extension posts
(``doc`` with ``mdToHtml(tasks.md)``, ``continueLabel``), then checks what
Kiro's IDE shows on a task list:

* every task row that is not done carries its own "Start task" (one task, one
  session); a queued row reads "Queued", a running row "In progress", a done
  row has no button;
* a Start click posts ``startTask`` with the row's source line, and the host
  maps that line back to the task;
* the document's primary action (→ Continue) is "Run all tasks (N left)" —
  one click, every remaining task, no re-clicking per task;
* on requirements.md / design.md no task buttons are added.

Usage: probe_spec_editor.py [--shots <dir>]      (needs Playwright + Chromium)
"""

from __future__ import annotations

import argparse
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
  - [x] 1.1 Bootstrap
  - _Requirements: 1.1_
- [-] 2. Manifest
  - [ ] 2.1 Schema
    - _Requirements: 2.1_
  - [~] 2.2 Validator
- [ ]* 3. Optional polish
- [ ] 4. Wiring
"""


def render(*args: str) -> str:
    out = subprocess.run(["node", str(HERE / "render_chat_html.mjs"), *args], capture_output=True, text=True, check=True)
    return out.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=None)
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    failures: list[str] = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg)
        (failures.append(msg) if not cond else None)

    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write(TASKS_MD)
        md_path = fh.name
    doc_html = render("--md", md_path)
    pathlib.Path(md_path).unlink()

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        errors: list[str] = []

        def load(stage: str):
            page = browser.new_page(viewport={"width": 760, "height": 600})
            page.on("pageerror", lambda e: errors.append(str(e)))
            html = render("--spec", "my-feature", stage).replace("<head>", "<head>" + STUB, 1)
            page.set_content(html, wait_until="domcontentloaded")
            page.wait_for_function("() => window.__posted.some((m) => m.type === 'ready')")
            page.evaluate("(m) => window.postMessage(m, '*')", {"type": "doc", "html": doc_html, "synced": False})
            page.wait_for_selector("#doc li")
            return page

        page = load("tasks.md")
        page.evaluate("(m) => window.postMessage(m, '*')", {"type": "continueLabel", "label": "Resume tasks (3 left)", "title": "Continue"})
        rows = page.evaluate("""() => Array.from(document.querySelectorAll('#doc .box[data-line]')).map((box) => {
            const li = box.parentElement; const b = Array.from(li.children).find((c) => c.classList && c.classList.contains('start') && c.dataset.line === box.dataset.line);
            return { line: Number(box.dataset.line), cls: box.className, button: b ? b.textContent : null, state: b ? b.classList.contains('state') : null };
        })""")
        by_line = {r["line"]: r for r in rows}
        check(len(rows) == 7, f"seven task boxes rendered ({len(rows)})")
        check(by_line[2]["button"] is None and by_line[3]["button"] is None, "done rows (1, 1.1) get no button")
        check(by_line[5]["button"] == "In progress" and by_line[5]["state"], f"the running parent (2) shows 'In progress' ({by_line[5]})")
        check(by_line[6]["button"] == "▶ Start task" and not by_line[6]["state"], f"an open sub-task (2.1) gets Start task ({by_line[6]})")
        check(by_line[8]["button"] == "Queued" and by_line[8]["state"], f"a queued row (2.2) reads 'Queued' ({by_line[8]})")
        check(by_line[9]["button"] == "▶ Start task" and "optional" in by_line[9]["cls"], f"an optional open task is startable and marked optional ({by_line[9]})")
        check(by_line[10]["button"] == "▶ Start task", f"the last open task gets Start task ({by_line[10]})")
        # The button of a parent with children sits before its nested list, so it reads on the parent's line.
        order = page.evaluate("""() => { const box = document.querySelector('#doc .box[data-line="5"]'); const li = box.parentElement;
            const kids = Array.from(li.children).map((c) => c.tagName + (c.className ? '.' + c.className.split(' ')[0] : '')); return kids; }""")
        check(order.index("BUTTON.start") < order.index("UL"), f"a parent's state sits before its sub-task list ({order})")
        # Clicking Start posts the row's source line; a state label posts nothing.
        page.hover('#doc .box[data-line="6"]')
        page.click('#doc li .start[data-line="6"]')
        page.click('#doc li .start[data-line="8"]')
        posted = page.evaluate("() => window.__posted.filter((m) => m.type === 'startTask')")
        check(posted == [{"type": "startTask", "line": 6}], f"Start posts startTask with the source line; Queued posts nothing ({posted})")
        cont = page.evaluate("() => document.getElementById('continue').textContent")
        check(cont == "→ Resume tasks (3 left)", f"the primary action is the run-all/resume label ({cont!r})")
        page.click("#continue")
        check(page.evaluate("() => window.__posted.filter((m) => m.type === 'continue').length") == 1, "Continue posts one 'continue' (the host runs all remaining tasks)")
        if args.shots:
            page.hover('#doc .box[data-line="10"]')
            page.screenshot(path=str(pathlib.Path(args.shots) / "spec-editor-tasks.png"))
        # Re-posting the doc (tasks.md changed on disk) re-decorates without duplicating buttons.
        page.evaluate("(m) => window.postMessage(m, '*')", {"type": "doc", "html": doc_html, "synced": True})
        n = page.evaluate("() => document.querySelectorAll('#doc .start').length")
        check(n == 5, f"a re-rendered doc has one button per non-done row, no duplicates ({n})")

        design = load("design.md")
        check(design.evaluate("() => document.querySelectorAll('#doc .start').length") == 0, "design.md: task boxes render but get no Start buttons")
        check(not errors, f"no page errors ({errors})")
        browser.close()

    print(("PASS" if not failures else "FAIL") + f" — {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
