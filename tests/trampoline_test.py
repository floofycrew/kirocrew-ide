"""The proxy route dispatches to the NEWEST hook module, so a mod update is live without a gateway restart."""

import asyncio
import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load(name):
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location(name, HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    gen1 = load("floofy_mods.kirocrew-ide.hook")   # what the route captured at gateway start
    sys.modules["floofy_mods.kirocrew-ide.hook"] = gen1
    calls = []

    async def old_proxy(request):
        calls.append("old")
        return "old"

    async def new_proxy(request):
        calls.append("new")
        return "new"

    gen1._proxy = old_proxy
    try:
        # Before any update: the trampoline resolves the registered module's _proxy.
        assert asyncio.run(gen1._proxy_trampoline(object())) == "old"
        # A floofy update re-imports the hook under the same key with new code.
        gen2 = load("floofy_mods.kirocrew-ide.hook.tmp")
        gen2._proxy = new_proxy
        sys.modules["floofy_mods.kirocrew-ide.hook"] = gen2
        assert asyncio.run(gen1._proxy_trampoline(object())) == "new", "the OLD route object now serves the NEW code"
        assert calls == ["old", "new"]
    finally:
        sys.modules.pop("floofy_mods.kirocrew-ide.hook", None)
        sys.modules.pop("floofy_mods.kirocrew-ide.hook.tmp", None)
    print("trampoline OK: the registered route serves the newest hook module's proxy")


if __name__ == "__main__":
    main()
