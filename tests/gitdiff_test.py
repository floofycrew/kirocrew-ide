"""The `gitdiff` mod route behind the chat's "# Git Diff" context."""

import importlib.util
import os
import subprocess
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


class Req:
    def __init__(self, **query):
        self.query = {k: [v] for k, v in query.items()}


def _load():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_gd", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


def main():
    hook = _load()
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "repo")
        os.makedirs(repo)
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@x", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@x")
        run = lambda *a: subprocess.run(["git", "-C", repo, *a], check=True, capture_output=True, env=env)  # noqa: E731
        run("init", "-q")
        with open(os.path.join(repo, "a.txt"), "w") as fh:
            fh.write("one\n")
        run("add", "a.txt")
        run("commit", "-q", "-m", "init")
        with open(os.path.join(repo, "a.txt"), "w") as fh:
            fh.write("one\ntwo\n")
        out = hook._gitdiff(Req(path=repo))
        assert isinstance(out, dict), out
        assert "+two" in out["text"], out["text"]
        assert "a.txt" in out["text"]
        assert out["truncated"] is False

        # Not a repo -> 409 with a message, not a crash.
        plain = os.path.join(tmp, "plain")
        os.makedirs(plain)
        status, body = hook._gitdiff(Req(path=plain))
        assert status == 409 and "not a git repository" in body["error"], (status, body)

        # Missing / non-dir -> 404
        status, _ = hook._gitdiff(Req(path=os.path.join(tmp, "nope")))
        assert status == 404
        status, _ = hook._gitdiff(Req())
        assert status == 404

        # Truncation is explicit.
        with open(os.path.join(repo, "big.txt"), "w") as fh:
            fh.write("x" * (hook.GITDIFF_LIMIT + 500) + "\n")
        run("add", "big.txt")
        out = hook._gitdiff(Req(path=repo))
        assert out["truncated"] is True and out["text"].endswith("… (truncated)\n")
        assert len(out["text"]) <= hook.GITDIFF_LIMIT + 40
    print("gitdiff OK: diff text, not-a-repo 409, bad path 404, explicit truncation")


if __name__ == "__main__":
    main()
