#!/usr/bin/env python3
"""Headless: spec actions on Kiro's engine against the fake KAS (requirement 10.3, checkpoint B).

    probe_kas_spec.py --engine <openvscode-server binary> [--shots DIR] [--keep]
    probe_kas_spec.py --engine <bin> --kiro-cli <real kiro-cli>     # LIVE: the same flow on the host's logged-in kiro-cli (requirement 10.4)

The probe_kas_tab.py harness (scratch engine behind the hook's real `_proxy`,
Kas_Link and `kas/*` routes with tests/e2e/fake_kas.py as kiro-cli, stub
`/api/*`), with `kirocrew.specEngine: "kas"` in the scratch user settings and a
fixture spec of two tasks. Checks: **Run all tasks** from tasks.md's title bar
goes to `_kiro/spec/resolveSession` + `invoke runAllTasks` (nothing reaches the
gateway's chat routes), the run opens as a Kiro-mode tab, the fake's
`taskStatusChanged` events turn the lenses to In progress / Done and the Specs
view follows, the boxes are ticked through the hook's `fs/write_text_file`, the
hook's `kas/tasks` route reports `succeed` with the session, and the **View
session** lens opens (focuses) the Kiro-mode tab. Zero console errors.
"""
import argparse
import json
import os
import pathlib
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True
from probe_kas_tab import Ctx, ENGINE_NOISE, Gateway, find_chat, free_port, load_hook, open_chat, rows_text, wait_until  # noqa: E402

TASKS_MD = "# Implementation Plan\n\n- [ ] 1. First thing\n  - Do the first thing.\n  - _Requirements: 1_\n- [ ] 2. Second thing\n  - Do the second thing.\n  - _Requirements: 1_\n"
#: The live fixture asks for two concrete file writes so a real model finishes in two short turns.
TASKS_MD_LIVE = "# Implementation Plan\n\n- [ ] 1. First thing\n  - Create `hello.txt` at the workspace root containing the single word `hello`. Nothing else.\n  - _Requirements: 1_\n- [ ] 2. Second thing\n  - Create `world.txt` at the workspace root containing the single word `world`. Nothing else.\n  - _Requirements: 1_\n"


def lens_texts(page):
    return [t.strip() for t in page.locator(".codelens-decoration").all_inner_texts() if t.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--shots", default=None)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--kiro-cli", default=None, help="run the real kiro-cli (live check) instead of the fake")
    args = ap.parse_args()
    live = bool(args.kiro_cli)
    from playwright.sync_api import sync_playwright

    scratch = tempfile.mkdtemp(prefix="kide-kas-spec-", dir=str(ROOT / ".pt-scratch")) if (ROOT / ".pt-scratch").is_dir() else tempfile.mkdtemp(prefix="kide-kas-spec-")
    data = os.path.join(scratch, "data"); os.makedirs(data)
    ws = os.path.join(scratch, "ws"); spec_dir = os.path.join(ws, ".kiro", "specs", "feat"); os.makedirs(spec_dir)
    open(os.path.join(ws, "README.md"), "w").write("# probe workspace\n")
    open(os.path.join(spec_dir, "requirements.md"), "w").write("# Requirements\n\n1. It works.\n")
    open(os.path.join(spec_dir, "design.md"), "w").write("# Design\n\nTwo one-word text files at the workspace root, hello.txt and world.txt.\n" if live else "# Design\n\nOne file.\n")
    tasks_path = os.path.join(spec_dir, "tasks.md")
    open(tasks_path, "w").write(TASKS_MD_LIVE if live else TASKS_MD)
    # The engine's remote-machine settings apply in every profile (the hook seeds profiles, so the
    # workbench may not run in Default, whose User/settings.json would be the only one read).
    udd = os.path.join(scratch, "udd"); os.makedirs(os.path.join(udd, "Machine"))
    with open(os.path.join(udd, "Machine", "settings.json"), "w") as fh:
        json.dump({"kirocrew.specEngine": "kas", "workbench.startupEditor": "none", "editor.codeLens": True}, fh)
    if live:
        kiro_cli = args.kiro_cli
        home = None
    else:
        os.environ["FAKE_KAS_STATE"] = os.path.join(scratch, "fake-state")
        kiro_cli = os.path.join(scratch, "kiro-cli")
        with open(kiro_cli, "w") as fh:
            fh.write("#!/bin/sh\nexec %s %s \"$@\"\n" % (sys.executable, str(HERE / "fake_kas.py")))
        os.chmod(kiro_cli, os.stat(kiro_cli).st_mode | stat.S_IEXEC)
        # The hook reads ~/.kiro/tasks for kas/tasks; the fake writes its tree under FAKE_KAS_STATE, so a
        # scratch HOME whose .kiro points there makes the route read the fake's files.
        home = os.path.join(scratch, "home"); os.makedirs(home)
        os.symlink(os.environ["FAKE_KAS_STATE"], os.path.join(home, ".kiro"))
        os.makedirs(os.environ["FAKE_KAS_STATE"], exist_ok=True)

    hook = load_hook()
    hook._ctx = Ctx(data)
    ext_dir = hook._provision_extension()
    engine_port = free_port()
    proc = subprocess.Popen([args.engine, "--host", "127.0.0.1", "--port", str(engine_port), "--without-connection-token",
                             "--server-base-path", hook.PROXY_BASE, "--extensions-dir", ext_dir, "--user-data-dir", udd, "--disable-workspace-trust", ws],
                            stdout=open(os.path.join(scratch, "engine.log"), "wb"), stderr=subprocess.STDOUT)
    saved_home = os.environ.get("HOME")
    if home:
        os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.join(saved_home or "", ".cache", "ms-playwright"))
        os.environ["HOME"] = home      # os.path.expanduser("~") in the hook's tasks_route
    gateway = Gateway(hook, ws, engine_port, kiro_cli)
    failures = []
    page = None

    def check(cond, msg):
        print(("ok   " if cond else "FAIL ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    def shot(name):
        if args.shots and page is not None:
            os.makedirs(args.shots, exist_ok=True)
            page.screenshot(path=os.path.join(args.shots, name))

    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", engine_port), timeout=0.5):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise AssertionError("engine did not open its port")
        gateway.start()
        print("kiro-cli: " + str(gateway.manager.cli_facts()))
        slow = 600 if live else 60   # a real model takes a few minutes for two tasks
        url = "http://127.0.0.1:%d%s/?folder=%s" % (gateway.port, hook.PROXY_BASE, ws)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1500, "height": 900})
            console = []
            page.on("console", lambda m: console.append("%s: %s @%s" % (m.type, m.text, (m.location or {}).get("url", ""))))
            page.on("pageerror", lambda e: console.append("pageerror: %s" % e))
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_selector(".monaco-workbench", timeout=90000)
            chat = open_chat(page)
            page.wait_for_timeout(1500)

            # --- open tasks.md: the spec editor (a webview) shows the two open tasks and Run all
            page.keyboard.press("Control+P"); page.wait_for_selector(".quick-input-widget", timeout=15000)
            page.keyboard.type("tasks.md"); page.wait_for_timeout(700); page.keyboard.press("Enter")
            doc = None
            def spec_editor():
                nonlocal doc
                for f in page.frames:
                    try:
                        if f.locator("button", has_text="Run all tasks").count():
                            doc = f
                            return True
                    except Exception:  # noqa: BLE001
                        continue
                return False
            check(wait_until(spec_editor, 30, page), "tasks.md opened in the spec editor with its Run all tasks button")
            check(doc.locator("button", has_text="Start task").count() == 2, "a Start task button per open row (%d)" % doc.locator("button", has_text="Start task").count())
            shot("spec-01-tasks.png")

            # --- Run all tasks from the spec editor's title bar: on Kiro's engine (kirocrew.specEngine = kas)
            doc.locator("button", has_text="Run all tasks").first.click()
            spawned = wait_until(lambda: len(gateway.manager.children) == 1, 60, page)
            check(spawned, "the hook spawned the kiro-cli child for the run")
            if not spawned:
                print("   gateway calls: %s" % [c["method"] + " " + c["path"] for c in gateway.calls][-12:])
                print("   chat rows: %s" % [t[:100] for t in rows_text(find_chat(page) or chat)][-5:])
                print("   Machine/settings.json present: %s" % os.path.exists(os.path.join(udd, "Machine", "settings.json")))
                shot("spec-fail-run-all.png")
                raise AssertionError("no child")
            child = list(gateway.manager.children.values())[0]
            check(wait_until(lambda: any(s.feature == "feat" for s in child.sessions.values()), 30, page), "the spec session was resolved for feat (%s)" % [(s.session_id, s.feature) for s in child.sessions.values()])
            sid = next((s.session_id for s in child.sessions.values() if s.feature == "feat"), None)
            chat = find_chat(page) or chat
            check(wait_until(lambda: "Kiro-mode session" in chat.locator("#hint").inner_text(), 30, page), "the run opened as a Kiro-mode tab (%s)" % chat.locator("#hint").inner_text()[:80])
            check(wait_until(lambda: any("Run all tasks" in t for t in chat.locator("#tabs .tab .t").all_inner_texts()), 20, page), "the tab is titled Run all tasks (%s)" % chat.locator("#tabs .tab .t").all_inner_texts())
            check(child.sessions[sid].autopilot is True if sid else False, "the hook turned Autopilot on for the run")

            # --- the source editor's lenses and the boxes follow the fake's taskStatusChanged / fs writes
            doc.locator("button", has_text="Edit source").first.click()
            check(wait_until(lambda: len(lens_texts(page)) >= 2, 30, page), "tasks.md source open with its lens rows (%s)" % lens_texts(page))
            check(wait_until(lambda: any("Done" in t for t in lens_texts(page)) and "[x] 1. First thing" in open(tasks_path).read(), slow, page), "task 1 done: lens Done, box ticked through fs/write_text_file (%s)" % lens_texts(page))
            check(wait_until(lambda: "[x] 2. Second thing" in open(tasks_path).read() and len([t for t in lens_texts(page) if "Done" in t]) >= 2, slow, page), "task 2 done too (%s)" % lens_texts(page))
            check(wait_until(lambda: any("View session" in t for t in lens_texts(page)), 15, page), "View session offered on the rows (from the task metadata)")
            check(wait_until(lambda: not chat.locator("#send").evaluate("b => b.classList.contains('stop')"), slow, page), "the run's turn ended (turn_end from the invoke)")
            texts = rows_text(chat)
            if live:
                check(os.path.isfile(os.path.join(ws, "hello.txt")) and os.path.isfile(os.path.join(ws, "world.txt")), "the run wrote hello.txt and world.txt (%s)" % sorted(os.listdir(ws)))
                check(len(texts) >= 2 and any("tool" in c.lower() or "task" in c.lower() for c in [t[:200] for t in texts]), "the run streamed into the tab (%d rows): %s" % (len(texts), [t[:50] for t in texts][-3:]))
            else:
                check(any("Doing 1. First thing" in t for t in texts) and any("Doing 2. Second thing" in t for t in texts), "the run's answer streamed into the tab: %s" % [t[:40] for t in texts][-4:])
            shot("spec-02-done.png")

            # --- the hook's kas/tasks route sees the fake's metadata
            with urllib.request.urlopen("http://127.0.0.1:%d/api/apps/floofycrew/mods/kirocrew-ide/api/kas/tasks?folder=%s&feature=feat" % (gateway.port, ws)) as r:
                doc = json.loads(r.read().decode())
            check(doc.get("tasks", {}).get("1. First thing", {}).get("executionStatus") == "succeed" and doc.get("specSessionId") == sid, "kas/tasks reports succeed + the spec session (%s)" % json.dumps(doc)[:160])

            # --- View session: a fresh tab is opened, the lens brings the run's tab back to the front
            chat.locator("#tabs .add").click(); page.wait_for_timeout(600)
            check("Kiro-mode session" not in chat.locator("#hint").inner_text(), "a new draft tab is in front")
            view = page.locator(".codelens-decoration a", has_text="View session").first
            view.click()
            check(wait_until(lambda: "Kiro-mode session " + (sid or "?") in (find_chat(page) or chat).locator("#hint").inner_text(), 20, page), "View session focused the run's Kiro-mode tab")
            check(not any("Run all tasks" in c["body"].get("message", "") if isinstance(c.get("body"), dict) else False for c in gateway.calls) and not any(c["path"].startswith("/chat?") for c in gateway.calls), "no spec turn went to the gateway's chat routes")
            errors = [c for c in console if (c.startswith("error") or c.startswith("pageerror")) and not any(n in c for n in ENGINE_NOISE)]
            check(not errors, "zero console errors (%d)" % len(errors))
            for e in errors[:10]:
                print("   console: " + e[:300])
            shot("spec-03-view-session.png")
            browser.close()
    finally:
        if saved_home is not None and home:
            os.environ["HOME"] = saved_home
        gateway.stop()
        try:
            proc.terminate(); proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
        if args.keep:
            print("scratch kept at " + scratch)
        else:
            shutil.rmtree(scratch, ignore_errors=True)
    if failures:
        print("\n%d FAILED:\n  " % len(failures) + "\n  ".join(failures))
        sys.exit(1)
    print("\nprobe_kas_spec: all checks passed")


if __name__ == "__main__":
    main()
