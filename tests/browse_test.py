"""GET browse lists directories (not files), skips caches, walks up, and reports recents."""

import importlib.util
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


class Req:
    def __init__(self, path=None):
        self.query = {"path": [path]} if path else {}


def main():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_browse", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)

    root = tempfile.mkdtemp(prefix="ide-browse-")
    for name in ("beta", "alpha", ".hidden", "node_modules", "__pycache__"):
        os.mkdir(os.path.join(root, name))
    open(os.path.join(root, "file.txt"), "w").close()

    class Ctx:
        state = {"recentFolders": [os.path.join(root, "alpha"), "/nonexistent/dir"]}

    hook._ctx = Ctx()
    out = hook._browse(Req(root))
    assert out["path"] == os.path.realpath(root)
    assert [e["name"] for e in out["entries"]] == [".hidden", "alpha", "beta"], out["entries"]
    assert out["entries"][0]["hidden"] is True and out["entries"][1]["hidden"] is False
    assert out["parent"] == os.path.dirname(os.path.realpath(root))
    assert out["suggestions"] == [os.path.join(root, "alpha")], "recents: existing only"

    up = hook._browse(Req(os.path.join(root, "alpha", "..")))
    assert up["path"] == os.path.realpath(root), "'..' resolves"

    missing = hook._browse(Req(os.path.join(root, "nope")))
    assert isinstance(missing, tuple) and missing[0] == 404

    home = hook._browse(Req())
    assert home["path"] == os.path.realpath(os.path.expanduser("~"))

    hook._remember_folder(os.path.join(root, "beta"))
    assert Ctx.state["recentFolders"][0] == os.path.join(root, "beta")
    hook._remember_folder(os.path.join(root, "alpha"))
    assert Ctx.state["recentFolders"][:2] == [os.path.join(root, "alpha"), os.path.join(root, "beta")], "moved to front, no duplicate"
    print("browse OK: dirs only, caches skipped, '..' walks up, recents newest-first")


if __name__ == "__main__":
    main()
