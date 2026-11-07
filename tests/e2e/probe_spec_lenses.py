"""Headless, real engine: task code lenses, task decorations and the spec
title-bar navigation on spec documents in the plain TEXT editor (requirements
4.1, 4.4, 4.5, 4.6, 3.1).

    probe_spec_lenses.py --engine <openvscode-server binary> [--shots DIR]

What runs: the same harness as probe_spec_editor.py (its provisioning and
helpers are imported): a scratch data dir with both extensions registered, a
scratch engine on a free loopback port, and a scratch workspace holding three
specs — `demo` (requirements-first / feature), `quick` (fast-task) and
`hotfix` (bugfix). The workspace settings make the text editor the default for
`*.md`, so quick-open lands in the Monaco editor (the Kiro spec editor is
clicked out of the way if it opens anyway). Chromium then drives the workbench:

* demo/tasks.md: one lens row above every task line, titled per box —
  `Start task` for `[ ]`, `Queued` for `[~]`, `In progress` for `[-]`, `Done`
  for `[x]`; the optional `[ ]*` row reads `Start task | Make required`;
* every task line carries a 2 px solid left border (the per-state
  TextEditorDecorationTypes), the colours differ between states, and only the
  optional line's text is dimmed to opacity 0.6;
* rewriting `[ ]` → `[x]` on disk turns that lens into `Done` and its border
  into the completed colour within one second, without reopening the editor;
* the title bar's "Go to …" actions follow the workflow type with the current
  document omitted: demo/requirements.md → design, tasks; quick/requirements.md
  (fast-task) → tasks, design; hotfix/design.md (bugfix) → bugfix, tasks and
  never requirements; demo/tasks.md → requirements, design plus Run all tasks;
* zero console errors (the engine's own, extension-independent noise aside;
  see `engine_noise` at the end of `main`).

Needs Playwright + Chromium (the FloofyCrew dev venv has them).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True  # never leave hook/__pycache__ behind (it would be hashed into the manifest)
from probe_spec_editor import free_port, frame_with, provision, quick_open  # noqa: E402

TASKS_MD = """# Implementation Plan

- [ ] 1. Open task
- [~] 2. Queued task
- [-] 3. Running task
- [x] 4. Done task
- [ ]* 5. Optional task
"""

SPECS = {
    # name: (config, requirements file name)
    "demo": ({"specId": "11111111-1111-4111-8111-111111111111", "workflowType": "requirements-first", "specType": "feature"}, "requirements.md"),
    "quick": ({"specId": "22222222-2222-4222-8222-222222222222", "workflowType": "fast-task", "specType": "feature"}, "requirements.md"),
    "hotfix": ({"specId": "33333333-3333-4333-8333-333333333333", "workflowType": "requirements-first", "specType": "bugfix"}, "bugfix.md"),
}


def make_workspace(scratch):
    """The fixture workspace: three specs plus the settings that keep spec files in the text editor."""
    ws = os.path.join(scratch, "ws")
    os.makedirs(os.path.join(ws, ".vscode"))
    with open(os.path.join(ws, ".vscode", "settings.json"), "w") as fh:
        json.dump({"workbench.editorAssociations": {"*.md": "default"}, "editor.codeLens": True, "workbench.startupEditor": "none"}, fh)
    open(os.path.join(ws, "README.md"), "w").write("# readme\n")
    for name, (config, req) in SPECS.items():
        d = os.path.join(ws, ".kiro", "specs", name)
        os.makedirs(d)
        open(os.path.join(d, ".config.kiro"), "w").write(json.dumps(config))
        open(os.path.join(d, req), "w").write("# %s\n\n1. It works.\n" % req[:-3].capitalize())
        open(os.path.join(d, "design.md"), "w").write("# Design\n\nA paragraph.\n")
        open(os.path.join(d, "tasks.md"), "w").write(TASKS_MD)
    return ws


# Every rendered line of the active text editor: its text, the lens row above it (the
# `.codelens-decoration` whose bottom meets the line's top), whether the decorations
# overlay at the same top has a `.cdr` with a 2 px solid left border (and its colour),
# and whether any text span of the line is drawn at opacity 0.6.
LINES_JS = """() => {
  const root = document.querySelector('.editor-group-container.active .editor-instance .monaco-editor')
    || document.querySelector('.editor-instance .monaco-editor');
  if (!root) return null;
  const rect = (el) => el.getBoundingClientRect();
  const lines = [...root.querySelectorAll('.view-lines > .view-line')]
    .map((l) => ({ top: rect(l).top, text: l.textContent.replace(/\\u00a0/g, ' ').trim(), el: l }))
    .sort((a, b) => a.top - b.top);
  const lenses = [...root.querySelectorAll('.codelens-decoration')]
    .map((c) => ({ top: rect(c).top, bottom: rect(c).bottom, text: c.textContent.replace(/\\s+/g, ' ').trim() }))
    .filter((c) => c.text);
  const overlays = [...root.querySelectorAll('.view-overlays > div')].map((d) => {
    const styles = [...d.querySelectorAll('.cdr')].map((c) => getComputedStyle(c))
      .filter((s) => parseFloat(s.borderLeftWidth) >= 2 && s.borderLeftStyle === 'solid');
    return { top: rect(d).top, border: styles.length > 0, color: styles.length ? styles[styles.length - 1].borderLeftColor : null, width: styles.length ? styles[0].borderLeftWidth : null };
  });
  // A lens widget sits in a view zone right above its line: it belongs to the first line starting at or below its bottom edge.
  const lensOf = new Map();
  for (const c of lenses) { const l = lines.find((x) => x.top >= c.bottom - 2); if (l) lensOf.set(l, c.text); }
  return lines.map((l) => {
    const ov = overlays.find((o) => Math.abs(o.top - l.top) < 1.5);
    const dim = [...l.el.querySelectorAll('span')].some((s) => getComputedStyle(s).opacity === '0.6');
    return { text: l.text, lens: lensOf.get(l) || null, border: Boolean(ov && ov.border), color: ov ? ov.color : null, width: ov ? ov.width : null, dim };
  });
}"""

ACTIONS_JS = """() => [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-item a.action-label')]
  .map((a) => (a.getAttribute('aria-label') || a.title || '').replace(/\\s*\\(.*\\)\\s*$/, '').trim()).filter(Boolean)"""


def active_tab(page):
    try:
        return page.locator(".tabs-container .tab.active .label-name").first.inner_text(timeout=1000).strip()
    except Exception:
        return ""


def open_source(page, spec, name, timeout=40):
    """Quick-open `.kiro/specs/<spec>/<name>` and make sure it is the text editor that shows it."""
    quick_open(page, "specs/%s/%s" % (spec, name))
    t0 = time.time()
    while time.time() - t0 < timeout:
        if active_tab(page) == name:
            if page.locator(".editor-group-container.active .editor-instance .monaco-editor .view-lines").count():
                page.wait_for_timeout(400)
                return True
            f = frame_with(page, "#edit")  # the Kiro spec editor took it: open the source from its bar
            if f:
                try:
                    f.locator("#edit").click()
                except Exception:
                    pass
        page.wait_for_timeout(300)
    return False


def wait_lines(page, pred, timeout=30, step=0.05):
    """Poll LINES_JS until `pred(lines)` holds; returns (lines, seconds) — lines of the last poll on timeout."""
    t0 = time.time()
    lines = None
    while time.time() - t0 < timeout:
        lines = page.evaluate(LINES_JS) or []
        if pred(lines):
            return lines, time.time() - t0
        page.wait_for_timeout(int(step * 1000))
    return lines or [], time.time() - t0


def task_line(lines, needle):
    return next((l for l in lines if needle in l["text"]), None)


def goto_actions(page, timeout=15):
    """The 'Go to …' title-bar actions (in order) once the context keys settled (same answer twice in a row)."""
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        got = [a for a in page.evaluate(ACTIONS_JS) if "Go to" in a]
        if got and got == last:
            return got
        last = got
        page.wait_for_timeout(500)
    return last or []


def short(actions):
    return [a.split("Go to ", 1)[-1] for a in actions]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--shots", default=None)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    scratch = tempfile.mkdtemp(prefix="kide-lens-probe-")
    data = os.path.join(scratch, "data"); os.makedirs(data)
    ws = make_workspace(scratch)
    ext_dir = provision(data, None)
    port = free_port()
    udd = os.path.join(scratch, "udd")
    proc = subprocess.Popen([args.engine, "--host", "127.0.0.1", "--port", str(port), "--without-connection-token",
                             "--extensions-dir", ext_dir, "--user-data-dir", udd, "--disable-workspace-trust", ws],
                            stdout=open(os.path.join(scratch, "engine.log"), "wb"), stderr=subprocess.STDOUT)
    failures = []

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    def shot(name):
        if args.shots:
            os.makedirs(args.shots, exist_ok=True); page.screenshot(path=os.path.join(args.shots, name))

    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise AssertionError("engine did not open its port")
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            console = []
            page.on("console", lambda m: console.append("%s: %s [%s]" % (m.type, m.text, (m.location or {}).get("url", ""))))
            page.on("pageerror", lambda e: console.append("pageerror: %s" % e))
            page.goto("http://127.0.0.1:%d/?folder=%s" % (port, ws), wait_until="domcontentloaded")
            page.wait_for_selector(".monaco-workbench", timeout=90000)
            page.wait_for_timeout(6000)
            trust = page.locator(".monaco-dialog-box a.monaco-button", has_text="trust the authors")
            if trust.count():
                trust.first.click(); page.wait_for_timeout(1500)

            # --- demo/tasks.md in the text editor: lenses per state, Make required on the optional row
            check(open_source(page, "demo", "tasks.md"), "demo/tasks.md opens in the text editor")
            expect = {"1. Open task": "Start task", "2. Queued task": "Queued", "3. Running task": "In progress", "4. Done task": "Done", "5. Optional task": "Start task | Make required"}
            lines, took = wait_lines(page, lambda ls: all(task_line(ls, k) and task_line(ls, k)["lens"] for k in expect))
            check(all(task_line(lines, k) and task_line(lines, k)["lens"] for k in expect), "a lens row sits above every task line (%.1fs; %s)" % (took, [(l["text"][:16], l["lens"]) for l in lines if l["lens"]]))
            for key, title in expect.items():
                row = task_line(lines, key)
                got = row["lens"] if row else None
                check(got == title, "lens on '%s' reads %r (got %r)" % (key, title, got))
            check(not any(l["lens"] for l in lines if not l["text"].startswith("- [")), "no lens on a non-task line")
            shot("lenses.png")

            # --- decorations: 2 px solid left border on each task block, per-state colours, the optional row dimmed
            lines, took = wait_lines(page, lambda ls: all(task_line(ls, k) and task_line(ls, k)["border"] for k in expect) and (task_line(ls, "5. Optional task") or {}).get("dim"), timeout=10)
            for key in expect:
                row = task_line(lines, key) or {}
                check(row.get("border") and row.get("width") == "2px", "'%s' carries a 2 px solid left border (width=%s colour=%s)" % (key, row.get("width"), row.get("color")))
            check(not any(l["border"] for l in lines if not l["text"].startswith("- [")), "no border on a non-task line")
            colors = {k: (task_line(lines, k) or {}).get("color") for k in expect}
            distinct = {colors[k] for k in ("1. Open task", "2. Queued task", "3. Running task", "4. Done task")}
            check(len(distinct) >= 3, "the border colour follows the state (%d distinct over 4 states: %s)" % (len(distinct), sorted(x for x in distinct if x)))
            check(colors["5. Optional task"] == colors["1. Open task"], "the optional (not started) row has the not-started colour")
            check((task_line(lines, "5. Optional task") or {}).get("dim"), "the optional row's text is drawn at opacity 0.6")
            check(not any(l["dim"] for l in lines if "Optional" not in l["text"]), "no other line is dimmed")
            done_color = colors["4. Done task"]
            shot("decorations.png")

            # --- the file changes on disk ([ ] -> [x] on task 1): the lens and the border follow within one second
            # The workbench attaches its file watcher to a document as it opens and the first lens pass is the
            # slow one; the requirement is about a change landing while the editor is open, so let it settle.
            page.wait_for_timeout(2500)
            tasks_path = os.path.join(ws, ".kiro", "specs", "demo", "tasks.md")
            text = open(tasks_path).read().replace("- [ ] 1. Open task", "- [x] 1. Open task")
            t_write = time.time()
            with open(tasks_path, "w") as fh:
                fh.write(text)
            seen = {}  # the moment (s after the write) the editor's text, the lens and the border each followed

            def followed(ls):
                row = task_line(ls, "1. Open task") or {}
                now = time.time() - t_write
                if "text" not in seen and "[x] 1. Open task" in row.get("text", ""): seen["text"] = now
                if "lens" not in seen and row.get("lens") == "Done": seen["lens"] = now
                if "border" not in seen and row.get("color") == done_color: seen["border"] = now
                return len(seen) == 3
            lines, _ = wait_lines(page, followed, timeout=10)
            row = task_line(lines, "1. Open task") or {}
            check("text" in seen, "the editor reloaded the document from disk (%.2fs; shows %r)" % (seen.get("text", -1), row.get("text")))
            check(row.get("lens") == "Done", "after the disk write the lens on task 1 reads Done (got %r)" % row.get("lens"))
            check(seen.get("lens", 99) < 1.0, "the lens changed within one second (%.2fs after the write)" % seen.get("lens", -1))
            check(row.get("border") and row.get("color") == done_color, "its border took the completed colour (%s vs %s)" % (row.get("color"), done_color))
            check(seen.get("border", 99) < 1.0, "the border changed within one second (%.2fs after the write)" % seen.get("border", -1))
            check(active_tab(page) == "tasks.md" and page.locator(".tabs-container .tab").count() == 1, "the editor was not reopened (one tasks.md tab, still active)")
            shot("after-write.png")

            # --- title-bar navigation per workflow type, current document omitted (requirement 3.1)
            acts = short(goto_actions(page))
            check(acts == ["requirements", "design"], "demo/tasks.md (requirements-first): Go to requirements, design (%s)" % acts)
            check(any("Run all tasks" in a for a in page.evaluate(ACTIONS_JS)), "demo/tasks.md: Run all tasks in the title bar")
            check(open_source(page, "demo", "requirements.md"), "demo/requirements.md opens in the text editor")
            acts = short(goto_actions(page))
            check(acts == ["design", "tasks"], "demo/requirements.md (requirements-first): Go to design, tasks (%s)" % acts)
            check(open_source(page, "quick", "requirements.md"), "quick/requirements.md opens in the text editor")
            acts = short(goto_actions(page))
            check(acts == ["tasks", "design"], "quick/requirements.md (fast-task): Go to tasks, design — tasks first (%s)" % acts)
            check(open_source(page, "hotfix", "design.md"), "hotfix/design.md opens in the text editor")
            acts = short(goto_actions(page))
            check(acts == ["bugfix", "tasks"], "hotfix/design.md (bugfix): Go to bugfix, tasks and no requirements (%s)" % acts)
            check(open_source(page, "hotfix", "tasks.md"), "hotfix/tasks.md opens in the text editor")
            lines, _ = wait_lines(page, lambda ls: (task_line(ls, "1. Open task") or {}).get("lens") == "Start task", timeout=20)
            check((task_line(lines, "1. Open task") or {}).get("lens") == "Start task", "the bugfix spec's tasks.md gets lenses too")
            shot("title-bar.png")

            # Zero console errors, the engine's own noise aside — each of these shows up with an EMPTY extensions
            # dir too (vsda is a module openvscode-server does not ship; the punycode deprecation is node's,
            # raised by the built-in extensions) or is the workbench asking open-vsx for updates to our two
            # unpacked extensions (the real mod points the gallery at the KiroCrew service instead).
            engine_noise = ("/node_modules/vsda/", "[DEP0040] DeprecationWarning: The `punycode`", "open-vsx.org/vscode/gallery/")
            errs = [c for c in console if (c.startswith("error") or c.startswith("pageerror")) and not any(n in c for n in engine_noise)]
            check(not errs, "zero console errors (%s)" % errs[:3])
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
    print("\n%s (%d failure(s)); scratch kept at %s" % ("PASS" if not failures else "FAIL", len(failures), scratch))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
