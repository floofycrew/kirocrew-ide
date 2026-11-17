"""hook/checkpoints.py: git-based workspace checkpoints behind the chat's "Revert changes".

A temp repository: a checkpoint captures tracked AND untracked files without
touching the user's index or HEAD; a revert restores modified and deleted
files, removes files created since (and their emptied directories), records a
"before revert" checkpoint for undo, reports what it changed; identical trees
reuse the newest record; a non-git folder is a 409; the routes refuse a folder
that is not an open workspace.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, "..", "hook", "checkpoints.py")


def _load():
    spec = importlib.util.spec_from_file_location("kirocrew_ide_checkpoints_t", MOD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True,
                          env=dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")).stdout


def write(repo, rel, text):
    p = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)


def read(repo, rel):
    with open(os.path.join(repo, rel), encoding="utf-8") as fh:
        return fh.read()


class Req:
    def __init__(self, body=None, **query):
        self._body = body
        self.query = {k: [v] for k, v in query.items()}

    def json(self):
        return self._body


class Routes:
    def __init__(self):
        self.table = {}

    def add(self, method, path, fn):
        self.table[(method, path)] = fn


class Ctx:
    def __init__(self):
        self.routes = Routes()


def main():
    cp = _load()
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.realpath(os.path.join(tmp, "repo"))
        data = os.path.join(tmp, "data")
        os.makedirs(repo)
        git(repo, "init", "-q")
        write(repo, "a.txt", "one\n")
        write(repo, ".gitignore", "ignored.log\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "base")
        head = git(repo, "rev-parse", "HEAD").strip()
        write(repo, "a.txt", "two\n")                 # modified, unstaged
        write(repo, "new/untracked.txt", "u\n")       # untracked
        write(repo, "ignored.log", "x\n")             # ignored: never part of a checkpoint
        index_before = git(repo, "ls-files", "--stage")

        # Snapshot: the user's index and HEAD are untouched; tracked + untracked captured.
        rec = cp.snapshot(data, repo, {"session": "k1", "turn": 1, "label": "first turn"})
        assert not isinstance(rec, tuple), rec
        assert git(repo, "ls-files", "--stage") == index_before, "user's index must not change"
        assert git(repo, "rev-parse", "HEAD").strip() == head, "HEAD must not change"
        assert git(repo, "status", "--short").strip() == git(repo, "status", "--short").strip()
        refs = git(repo, "for-each-ref", "--format=%(refname)", cp.REF_PREFIX)
        assert cp.REF_PREFIX + rec["id"] in refs, refs
        assert "kirocrew" not in git(repo, "branch", "--list"), "no branch must appear"
        tree_files = git(repo, "ls-tree", "-r", "--name-only", rec["tree"]).split()
        assert "a.txt" in tree_files and "new/untracked.txt" in tree_files, tree_files
        assert "ignored.log" not in tree_files, tree_files

        # Same tree again: the newest record is reused, no second ref.
        again = cp.snapshot(data, repo, {"session": "k1", "turn": 2})
        assert again["id"] == rec["id"] and again.get("reused") is True, again
        assert len(cp.list_checkpoints(data, repo)["checkpoints"]) == 1

        # The "agent" edits: modify a.txt, delete the untracked file, create b.txt and a nested file.
        write(repo, "a.txt", "three\n")
        os.unlink(os.path.join(repo, "new/untracked.txt"))
        write(repo, "b.txt", "b\n")
        write(repo, "deep/er/c.txt", "c\n")
        changed = cp.changed_since(data, repo, rec["id"])
        got = {f["path"]: f["status"] for f in changed["files"]}
        assert got == {"a.txt": "M", "new/untracked.txt": "D", "b.txt": "A", "deep/er/c.txt": "A"}, got
        assert changed["same"] is False

        # Revert: restores a.txt and the deleted file, removes the created ones and their empty dirs, offers undo.
        result = cp.revert(data, repo, rec["id"])
        assert not isinstance(result, tuple), result
        assert read(repo, "a.txt") == "two\n"
        assert read(repo, "new/untracked.txt") == "u\n"
        assert not os.path.exists(os.path.join(repo, "b.txt"))
        assert not os.path.exists(os.path.join(repo, "deep")), "emptied directories go too"
        assert os.path.exists(os.path.join(repo, "ignored.log")), "ignored files are left alone"
        assert result["removed"] == 2 and result["restored"] == 2, result
        assert result["undo"] and result["undo"] != rec["id"]
        assert git(repo, "rev-parse", "HEAD").strip() == head
        assert cp.changed_since(data, repo, rec["id"])["same"] is True

        # Undo the revert through the "before revert" checkpoint.
        back = cp.revert(data, repo, result["undo"])
        assert read(repo, "a.txt") == "three\n" and os.path.exists(os.path.join(repo, "b.txt")), back
        assert read(repo, "deep/er/c.txt") == "c\n"

        # Reverting to a checkpoint equal to the current tree changes nothing and still answers.
        same = cp.revert(data, repo, result["undo"])
        assert same["files"] == [] and same["restored"] == 0, same

        # Unknown / bad ids, and a non-git folder.
        assert cp.revert(data, repo, "zzz")[0] == 400
        assert cp.revert(data, repo, "0123456789ab")[0] == 404
        plain = os.path.join(tmp, "plain")
        os.makedirs(plain)
        assert cp.snapshot(data, plain)[0] == 409

        # Pruning keeps CHECKPOINTS_MAX records and drops the refs of the rest.
        cp.CHECKPOINTS_MAX = 3
        for i in range(5):
            write(repo, "a.txt", "v%d\n" % i)
            cp.snapshot(data, repo, {"turn": 10 + i})
        rows = cp.list_checkpoints(data, repo)["checkpoints"]
        assert len(rows) == 3, len(rows)
        refs = git(repo, "for-each-ref", "--format=%(refname)", cp.REF_PREFIX).split()
        assert len(refs) == 3, refs

        # Routes: the open-workspace gate, a subfolder of an open workspace is fine.
        ctx = Ctx()
        cp.routes(ctx, data, lambda: [repo])
        table = ctx.routes.table
        assert table[("POST", "checkpoints/snapshot")](Req({"folder": plain}))[0] == 403
        sub = os.path.join(repo, "new")
        os.makedirs(sub, exist_ok=True)
        snap = table[("POST", "checkpoints/snapshot")](Req({"folder": sub, "session": "k2", "turn": 1}))
        assert isinstance(snap, dict) and snap["root"] == repo, snap
        listed = table[("GET", "checkpoints")](Req(folder=repo))
        assert listed["checkpoints"][-1]["id"] == snap["id"]
        assert table[("GET", "checkpoints/changed")](Req(folder=repo, id=snap["id"]))["same"] is True
        assert table[("POST", "checkpoints/revert")](Req({"folder": repo, "id": "nope"}))[0] == 400

        # forget() drops every record and ref.
        cp.forget(data, repo)
        assert cp.list_checkpoints(data, repo)["checkpoints"] == []
        assert git(repo, "for-each-ref", cp.REF_PREFIX).strip() == ""
    print("checkpoints_test: ok")


if __name__ == "__main__":
    main()
