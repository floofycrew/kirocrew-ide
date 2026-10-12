"""Machine-scope engine settings are seeded once and never overwrite what is already there."""

import importlib.util
import json
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def main():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_settings", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    tmp = tempfile.mkdtemp(prefix="ide-settings-")
    path = os.path.join(tmp, "Machine", "settings.json")

    assert hook._seed_machine_settings(path) is True, "created"
    doc = json.load(open(path))
    assert doc["chat.disableAIFeatures"] is True and doc["workbench.secondarySideBar.defaultVisibility"] == "visible"
    assert hook._seed_machine_settings(path) is False, "idempotent"

    # An operator's own value for a seeded key is kept; unrelated keys are kept; missing ones added.
    json.dump({"chat.disableAIFeatures": False, "editor.fontSize": 15}, open(path, "w"))
    assert hook._seed_machine_settings(path) is True
    doc = json.load(open(path))
    assert doc["chat.disableAIFeatures"] is False and doc["editor.fontSize"] == 15
    assert doc["workbench.startupEditor"] == "none"

    # Garbage in the file is not fatal and not clobbered into a crash.
    open(path, "w").write("{not json")
    assert hook._seed_machine_settings(path) is False
    print("machine settings OK: seeded once, user values kept, bad file tolerated")


if __name__ == "__main__":
    main()
