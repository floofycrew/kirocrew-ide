"""The bridge extension is provisioned and REGISTERED in VS Code's extensions.json each start.

Regression: openvscode-server only loads folders listed in its extensions.json
and drops everything it finds in `.obsolete`; a provisioned-but-unregistered
copy is "Marked extension as removed" and never activates. The entry must be
application-scoped, or a user profile other than the default never sees it.
"""

import importlib.util
import json
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


class Log:
    def info(self, *a): pass
    def warning(self, *a): raise AssertionError("provisioning warned: %s" % (a,))


class Ctx:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.log = Log()


def main():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_ext", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    data = tempfile.mkdtemp(prefix="ide-ext-")
    hook._ctx = Ctx(data)
    root = os.path.join(data, hook.EXTENSIONS_DIR)
    os.makedirs(root)
    # A stale registry from an older copy plus an .obsolete verdict against the current one.
    with open(os.path.join(hook._mod_dir(), "extension", "package.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    ext_id = "%s.%s" % (manifest["publisher"], manifest["name"])
    json.dump([{"identifier": {"id": ext_id}, "version": "0.0.1", "location": {"path": "/old"}},
               {"identifier": {"id": "other.ext"}, "version": "1.0.0"}], open(os.path.join(root, "extensions.json"), "w"))
    json.dump({ext_id + "-" + manifest["version"]: True, "other.ext-1.0.0": True}, open(os.path.join(root, ".obsolete"), "w"))
    os.makedirs(os.path.join(root, ext_id + "-0.0.1"))

    out = hook._provision_extension()
    assert out == root, out
    target = os.path.join(root, ext_id + "-" + manifest["version"])
    assert os.path.isfile(os.path.join(target, "package.json")) and os.path.isfile(os.path.join(target, "extension.js"))
    assert not os.path.isdir(os.path.join(root, ext_id + "-0.0.1")), "older copy removed"
    registry = json.load(open(os.path.join(root, "extensions.json")))
    ours = [e for e in registry if e["identifier"]["id"] == ext_id]
    assert len(ours) == 1 and ours[0]["version"] == manifest["version"], registry
    assert ours[0]["location"]["path"] == os.path.realpath(target) and ours[0]["relativeLocation"] == os.path.basename(target)
    # Regression (0.14.1): a profile the user imports/creates carries its own
    # extensions.json; only application-scoped entries of the default registry
    # are merged into it, so without this flag the bridge is missing there.
    # And NOT isBuiltin: the engine drops a builtin-flagged user extension
    # that has no system twin ("Skipping obsolete builtin extension").
    assert ours[0]["metadata"]["isApplicationScoped"] is True, ours[0]["metadata"]
    assert not ours[0]["metadata"].get("isBuiltin"), ours[0]["metadata"]
    assert any(e["identifier"]["id"] == "other.ext" for e in registry), "other entries kept"
    obsolete = json.load(open(os.path.join(root, ".obsolete")))
    assert obsolete == {"other.ext-1.0.0": True}, obsolete
    assert hook._extension_version() == manifest["version"]
    # idempotent
    assert hook._provision_extension() == root
    assert len([e for e in json.load(open(os.path.join(root, "extensions.json"))) if e["identifier"]["id"] == ext_id]) == 1

    # Adoption path (0.14.2): a hook reloaded over a RUNNING engine rewrites the
    # entry for the copy already on disk — so a 0.14.1 registry (flag False)
    # is repaired without a Stop/Start — and never re-copies the folder the
    # engine is serving from.
    registry = json.load(open(os.path.join(root, "extensions.json")))
    for e in registry:
        if e["identifier"]["id"] == ext_id:
            e["metadata"]["isApplicationScoped"] = False
    json.dump(registry, open(os.path.join(root, "extensions.json"), "w"))
    json.dump({ext_id + "-" + manifest["version"]: True}, open(os.path.join(root, ".obsolete"), "w"))
    marker = os.path.join(target, "untouched.marker")
    open(marker, "w").close()
    assert hook._reregister_extension() is True
    ours = [e for e in json.load(open(os.path.join(root, "extensions.json"))) if e["identifier"]["id"] == ext_id]
    assert len(ours) == 1 and ours[0]["metadata"]["isApplicationScoped"] is True, ours
    assert os.path.isfile(marker), "the provisioned folder was re-copied under a running engine"
    assert json.load(open(os.path.join(root, ".obsolete"))) == {}, "un-obsoleted again"
    # Nothing on disk to register (never provisioned): a no-op, not a copy.
    import shutil
    shutil.rmtree(target)
    assert hook._reregister_extension() is False
    assert not os.path.isdir(target)
    print("extension provisioning OK: copied, registered application-scoped in extensions.json, un-obsoleted, older copies removed; adoption re-registers without re-copying")


if __name__ == "__main__":
    main()
