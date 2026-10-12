"""Import check: the gateway hook module loads and exposes its lifecycle.

Stubs the ``floofy`` runtime module (the real one only exists inside the
gateway) and imports ``hook/__init__.py`` directly. No host code is imported.
"""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def main():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("activate", "deactivate", "_status", "_start", "_stop", "_engines"):
        assert callable(getattr(module, name)), name
    assert module.PRESETS, "engine presets present"
    print("hook import OK: activate/deactivate + 4 route handlers present")


if __name__ == "__main__":
    main()
