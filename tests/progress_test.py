"""Spec-task progress: each workspace row of `status` carries the completeness of its specs.

The hook reads `<folder>/.kiro/specs/*/tasks.md` with Kiro's task-line grammar
(the same regex the extension parses with) and counts the boxes by state. Every
box counts — a parent task's as much as a sub-task's, optional ones too — so the
percentage is the file's own checkboxes, nothing cleverer. Several specs sum
into the top-level counts (one percentage per workspace) and stay listed as the
breakdown. Re-read only when a file's mtime or size changes.
"""

import importlib.util
import os
import shutil
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_progress", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Log:
    def __getattr__(self, _name):
        return lambda *_a, **_k: None


class Ctx:
    def __init__(self, tmp):
        self.data_dir = tmp
        self.state = {"server": {"port": 35476, "folder": None, "engine": "openvscode-server"}}
        self.config = types.SimpleNamespace(get=lambda _k, d=None: d)
        self.routes = types.SimpleNamespace(add=lambda *_a, **_k: None)
        self.log = _Log()


ALPHA_TASKS = """# Implementation Plan

- [x] 1. Set up the project
  - [x] 1.1 Create the package
  - [x] 1.2 Add the test runner
    - _Requirements: 1.1_
- [-] 2. Build the parser
  - [x] 2.1 Grammar
  - [ ] 2.2 Serializer
- [~] 3. Wire the view
- [ ]* 4. Optional polish
- [ ]\\* 5. Also optional, escaped mark
* [ ] 6. Star bullet counts too
+ [X] 7. Plus bullet, capital X
- [ ]no space after the box is not a task
-[ ] no space after the bullet is not a task
Not a task line at all.
"""

BETA_TASKS = """- [x] 1. One
- [x] 2. Two
- [ ] 3. Three
"""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def main():
    hook = load_hook()
    tmp = tempfile.mkdtemp(prefix="ide-progress-")
    try:
        # The grammar, box by box.
        c = hook._count_tasks(ALPHA_TASKS)
        assert c == {"total": 11, "done": 5, "inProgress": 1, "queued": 1, "optional": 2}, c
        assert hook._count_tasks("") == {"total": 0, "done": 0, "inProgress": 0, "queued": 0, "optional": 0}
        assert hook._count_tasks("# only prose\n\n- a plain bullet\n")["total"] == 0

        # A workspace with two specs, one spec dir without tasks.md, and a stray file in specs/.
        ws = os.path.join(tmp, "ws")
        write(os.path.join(ws, ".kiro", "specs", "alpha", "tasks.md"), ALPHA_TASKS)
        write(os.path.join(ws, ".kiro", "specs", "beta", "tasks.md"), BETA_TASKS)
        write(os.path.join(ws, ".kiro", "specs", "gamma", "requirements.md"), "# no tasks yet\n")
        write(os.path.join(ws, ".kiro", "specs", "notes.txt"), "stray\n")
        p = hook._spec_progress(ws)
        assert p["total"] == 14 and p["done"] == 7 and p["inProgress"] == 1 and p["queued"] == 1 and p["optional"] == 2, p
        assert [s["name"] for s in p["specs"]] == ["alpha", "beta"], "name-sorted, only spec dirs with a tasks.md"
        alpha, beta = p["specs"]
        assert (alpha["done"], alpha["total"]) == (5, 11) and (beta["done"], beta["total"]) == (2, 3)
        assert alpha["dir"] == os.path.join(".kiro", "specs", "alpha") and alpha["tasks"] == os.path.join(".kiro", "specs", "alpha", "tasks.md")

        # No specs directory: None (the UI shows nothing). An empty specs dir: zero, with no rows.
        plain = os.path.join(tmp, "plain")
        os.makedirs(plain)
        assert hook._spec_progress(plain) is None
        empty = os.path.join(tmp, "empty")
        os.makedirs(os.path.join(empty, ".kiro", "specs"))
        assert hook._spec_progress(empty) == {"total": 0, "done": 0, "inProgress": 0, "queued": 0, "optional": 0, "specs": []}
        assert hook._spec_progress(os.path.join(tmp, "missing")) is None, "a folder that is gone is not an error"
        assert hook._spec_progress("~") is None or isinstance(hook._spec_progress("~"), dict), "~ expands, never raises"

        # Cache: the same mtime+size is not re-read; a change (bumped mtime) is.
        path = os.path.join(ws, ".kiro", "specs", "beta", "tasks.md")
        hook._progress_cache[path] = (os.stat(path).st_mtime_ns, os.stat(path).st_size, {"total": 99, "done": 99, "inProgress": 0, "queued": 0, "optional": 0})
        assert hook._spec_progress(ws)["specs"][1]["total"] == 99, "served from the cache while the file is unchanged"
        write(path, BETA_TASKS.replace("- [ ] 3.", "- [x] 3."))
        st = os.stat(path)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))
        p = hook._spec_progress(ws)
        assert (p["specs"][1]["done"], p["specs"][1]["total"]) == (3, 3), p["specs"][1]
        assert p["done"] == 8 and p["total"] == 14
        os.remove(path)
        assert [s["name"] for s in hook._spec_progress(ws)["specs"]] == ["alpha"], "a removed tasks.md drops out"
        assert path not in hook._progress_cache

        # Rides on status: one `progress` per workspace row.
        ctx = Ctx(tmp)
        hook._ctx = ctx
        hook._state_path = lambda: os.path.join(tmp, "server.json")
        hook._pid_alive = lambda pid: pid == 4242
        hook._port_open = lambda port: port == 35476
        hook._proxy_registered = lambda: True
        hook._extension_version = lambda: None
        hook._write_state({"pid": 4242, "port": 35476, "token": "T", "proxied": True, "folder": ws,
                           "workspaces": [ws, plain], "engine": "openvscode-server", "startedAt": 0})
        rows = hook._status(None)["workspaces"]
        assert [r["folder"] for r in rows] == [ws, plain]
        assert rows[0]["progress"]["total"] == 11 and rows[0]["progress"]["done"] == 5, rows[0]["progress"]
        assert rows[0]["progress"]["specs"][0]["name"] == "alpha"
        assert rows[1]["progress"] is None
        print("progress_test: ok")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
