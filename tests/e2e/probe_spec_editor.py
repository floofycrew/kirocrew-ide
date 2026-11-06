"""Headless, real engine: the Kiro spec editor renders through the engine's own
markdown renderer and draws mermaid; Shift+Cmd+V on a spec file opens IT.

    probe_spec_editor.py --engine <openvscode-server binary> [--mermaid <mermaid.min.js>] [--shots DIR]

What runs: a scratch data dir is provisioned the way the hook does it (both
extensions copied + registered; the pinned mermaid build vendored in when
--mermaid is given), a scratch engine is launched on a free loopback port with
that extensions dir and a scratch workspace holding `.kiro/specs/demo/*`, and
Chromium drives the workbench:

* design.md opens in the Kiro spec editor (the custom editor is the default
  for spec files): a python fence carries highlight.js token spans (proof the
  body came from `markdown.api.render`, not mdToHtml), every fence has the
  language + Copy bar, the mermaid fence is an <svg> (or stays a code block when
  no library was vendored), a heading renders;
* tasks.md: Kiro's task rows are boxes carrying their SOURCE LINE, open rows
  have ▶ Start task, the in-progress and queued rows show their state, the done
  row has no button; the Continue button reads "Run all tasks (N left)";
* Edit source, then Ctrl+Shift+V: the Kiro spec editor opens again (no
  "Preview tasks.md" tab from the built-in markdown preview).

Needs Playwright + Chromium (the FloofyCrew dev venv has them).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.dont_write_bytecode = True  # never leave hook/__pycache__ behind (it would be hashed into the manifest)

DESIGN_MD = """# Design

Overview paragraph with a [link](../../README.md).

```python
def greet(name):
    return f"hello {name}"  # comment
```

```mermaid
flowchart LR
  A[Start] --> B{Spec?}
  B -->|yes| C[Run tasks]
  B -->|no| D[Write it]
```

```
plain fence without a language
```
"""

TASKS_MD = """# Implementation Plan

- [x] 1. Spikes
  - [x] 1.1 Bootstrap
  - _Requirements: 1.1_
- [-] 2. Manifest
  - _Requirements: 2.1_
- [~] 3. Queued thing
- [ ] 4. Open task
  - [ ] 4.1 Sub task
- [ ]* 5. Optional task
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kide_hook_probe", str(ROOT / "hook" / "__init__.py"))
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


class Ctx:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.config = {}
        self.state = {}

        class Log:
            def info(self, *a): pass
            def warning(self, *a): print("hook warning:", a, flush=True)
            debug = info
        self.log = Log()


def provision(data_dir, mermaid):
    hook = load_hook()
    hook._ctx = Ctx(data_dir)
    if mermaid:
        data = open(mermaid, "rb").read()
        digest = hashlib.sha256(data).hexdigest()
        assert digest == hook.MERMAID_SHA256, "the given mermaid build is not the pinned one (%s)" % digest[:12]
        os.makedirs(os.path.dirname(hook._mermaid_path()), exist_ok=True)
        shutil.copyfile(mermaid, hook._mermaid_path())
    root = hook._provision_extension()
    assert root, "provisioning failed"
    return root


def frame_with(page, selector):
    for frame in page.frames:
        try:
            if frame.locator(selector).count():
                return frame
        except Exception:
            continue
    return None


def wait_frame(page, selector, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        f = frame_with(page, selector)
        if f:
            return f
        page.wait_for_timeout(500)
    raise AssertionError("no frame with %s within %ss" % (selector, timeout))


def quick_open(page, name):
    page.keyboard.press("Control+P")
    page.wait_for_selector(".quick-input-widget", timeout=15000)
    page.keyboard.type(name)
    page.wait_for_timeout(700)
    page.keyboard.press("Enter")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--mermaid", default=None)
    ap.add_argument("--shots", default=None)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    scratch = tempfile.mkdtemp(prefix="kide-spec-probe-")
    data = os.path.join(scratch, "data"); os.makedirs(data)
    ws = os.path.join(scratch, "ws"); spec_dir = os.path.join(ws, ".kiro", "specs", "demo"); os.makedirs(spec_dir)
    open(os.path.join(ws, "README.md"), "w").write("# readme\n")
    open(os.path.join(spec_dir, "requirements.md"), "w").write("# Requirements\n\n1. It works.\n")
    open(os.path.join(spec_dir, "design.md"), "w").write(DESIGN_MD)
    open(os.path.join(spec_dir, "tasks.md"), "w").write(TASKS_MD)
    ext_dir = provision(data, args.mermaid)
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
            page.on("console", lambda m: console.append("%s: %s" % (m.type, m.text)))
            page.goto("http://127.0.0.1:%d/?folder=%s" % (port, ws), wait_until="domcontentloaded")
            page.wait_for_selector(".monaco-workbench", timeout=90000)
            page.wait_for_timeout(6000)
            trust = page.locator(".monaco-dialog-box a.monaco-button", has_text="trust the authors")
            if trust.count():
                trust.first.click(); page.wait_for_timeout(1500)

            # --- design.md in the Kiro spec editor
            quick_open(page, "design.md")
            doc = wait_frame(page, "#doc .codeblock")
            doc.wait_for_selector("#doc .hljs-keyword", timeout=30000)
            check(doc.locator("#doc .hljs-keyword").count() >= 1, "design.md: highlight.js token spans present (engine's own renderer)")
            check(doc.locator("#doc h1").count() == 1 and "Design" in doc.locator("#doc h1").inner_text(), "design.md: heading rendered")
            langs = doc.locator("#doc .codeblock .codebar .lang").all_inner_texts()
            check("python" in langs and "text" in langs, "design.md: every fence has a language label (%s)" % langs)
            check(doc.locator("#doc .codeblock .codebar button.copy").count() >= 2, "design.md: Copy on each code block")
            check(doc.locator("#doc a[href]").count() >= 1, "design.md: links kept as anchors")
            if args.mermaid:
                try:
                    doc.wait_for_selector("#doc .mermaid svg", timeout=30000)
                    check(True, "design.md: mermaid fence drawn as <svg>")
                except Exception as error:
                    check(False, "design.md: mermaid fence drawn as <svg> (%s)" % type(error).__name__)
                check("mermaid" not in langs, "design.md: the drawn fence is not also shown as a code block")
            else:
                check("mermaid" in langs or "text" in langs, "design.md: no library vendored, the mermaid fence stays a code block")
            check(doc.locator("#banner .stage.on").inner_text().strip().endswith("Design"), "design.md: banner marks the Design stage")
            if args.shots:
                os.makedirs(args.shots, exist_ok=True); page.screenshot(path=os.path.join(args.shots, "design.png"))

            # --- tasks.md: boxes with source lines, Start buttons, states, Continue label
            quick_open(page, "tasks.md")
            tdoc = None
            t0 = time.time()
            while time.time() - t0 < 40:
                for f in page.frames:
                    try:
                        if f.locator("#doc .box[data-line]").count() and f.locator("#banner .stage.on").inner_text().strip().endswith("Task list"):
                            tdoc = f; break
                    except Exception:
                        continue
                if tdoc: break
                page.wait_for_timeout(500)
            check(tdoc is not None, "tasks.md: opened in the Kiro spec editor with task boxes")
            if tdoc:
                lines = [int(x) for x in tdoc.locator("#doc .box[data-line]").evaluate_all("els => els.map(e => e.dataset.line)")]
                check(lines == [2, 3, 5, 7, 8, 9, 10], "tasks.md: boxes carry the source lines in order (%s)" % lines)
                starts = tdoc.locator("#doc button.start:not(.state)")
                check(starts.count() == 3, "tasks.md: ▶ Start task on the three open rows (got %d)" % starts.count())
                check(tdoc.locator("#doc button.start.state.part").inner_text().strip() == "In progress", "tasks.md: the [-] row reads In progress")
                check(tdoc.locator("#doc button.start.state.queued").inner_text().strip() == "Queued", "tasks.md: the [~] row reads Queued")
                done_li = tdoc.locator("#doc .box.on").first.locator("xpath=ancestor::li[1]")
                check(done_li.locator("button.start").count() == 0, "tasks.md: a done row has no button")
                check(tdoc.locator("#doc .box.optional").count() == 1, "tasks.md: the optional mark survives")
                cont = tdoc.locator("#continue").inner_text()
                # The fixture carries a [-] and a [~] row: an interrupted run, so the primary action resumes it.
                check("Resume run (3 left)" in cont, "tasks.md: Continue reads Resume run for the marks left in the file (%s)" % cont.strip())
                check(not any("[ ]" in t or "[x]" in t for t in tdoc.locator("#doc li").all_inner_texts()), "tasks.md: no bracket text left in the rows")
                if args.shots:
                    page.screenshot(path=os.path.join(args.shots, "tasks.png"))

                # --- Edit source, then the preview key: our editor, not the built-in preview
                tdoc.locator("#edit").click()
                page.wait_for_timeout(2500)
                page.wait_for_selector(".monaco-editor .view-lines", timeout=20000)
                page.locator(".monaco-editor .view-lines").first.click()
                page.keyboard.press("Control+Shift+V")
                page.wait_for_timeout(4000)
                tabs = page.locator(".tabs-container .tab .label-name").all_inner_texts()
                check(not any(t.startswith("Preview") for t in tabs), "Ctrl+Shift+V on the source: no built-in 'Preview tasks.md' tab (%s)" % tabs)
                active_label = page.locator(".tabs-container .tab.active .label-name").first.inner_text().strip()
                visible_task_editor = False
                for f in page.frames:
                    try:
                        if f.locator("#banner .stage.on").count() and f.locator("#banner").is_visible() and f.locator("#banner .stage.on").inner_text().strip().endswith("Task list"):
                            visible_task_editor = True
                    except Exception:
                        continue
                check(active_label == "tasks.md" and visible_task_editor, "Ctrl+Shift+V on the source: the active tab is tasks.md in the Kiro spec editor (active=%s, visible spec editor=%s)" % (active_label, visible_task_editor))
                # --- Ctrl+F through the workbench: the webview host swallows the key and forwards it; the
                # page's own keydown and the extension's keybinding (while a spec editor is active) both
                # open the editor's find bar, and the built-in find widget stays out of it.
                fdoc = wait_frame(page, "#doc .box[data-line]")
                fdoc.locator("#doc").click(position={"x": 40, "y": 10})
                page.wait_for_timeout(300)
                page.keyboard.press("Control+F")
                try:
                    fdoc.wait_for_selector("#find:not([hidden])", timeout=8000)
                    check(True, "Ctrl+F in the spec editor opens its find bar")
                except Exception:
                    check(False, "Ctrl+F in the spec editor opens its find bar")
                check(page.locator(".webview .find-widget, .monaco-editor .find-widget.visible").count() == 0, "the workbench's own find widget did not open")
                page.keyboard.type("Manifest")
                try:
                    fdoc.wait_for_function("() => document.querySelectorAll('#doc mark.hit').length === 1", timeout=8000)
                    check(fdoc.locator("#findcount").inner_text().strip() == "1 of 1", "typing marks the match and counts it (%s)" % fdoc.locator("#findcount").inner_text().strip())
                except Exception:
                    check(False, "typing marks the match and counts it")
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
                check(fdoc.locator("#find").get_attribute("hidden") is not None and fdoc.locator("#doc mark.hit").count() == 0, "Esc closes the bar and clears the marks")
                if args.shots:
                    page.screenshot(path=os.path.join(args.shots, "preview-key.png"))
            errs = [c for c in console if c.startswith("error") and "kirocrew" in c.lower()]
            check(not errs, "no kirocrew console errors (%s)" % errs[:3])
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
