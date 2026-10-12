"""early(ctx) must use ONLY the attributes the FloofyCrew early shim provides.

The shim's EarlyContext carries mod_id, mod_dir, host_home, data_home,
bootstrap, state and a log(message) CALLABLE — no ctx.hooks, no ctx.data_dir,
and log is not a logger object. Using anything else makes early() raise, which
the shim swallows: the mod then silently loses its early behaviour. This test
drives early() with a context that has exactly that surface and fails on any
extra attribute access.
"""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


class StrictEarlyContext:
    """Mirrors floofy_early.EarlyContext and forbids anything beyond it."""

    api_version = "1.0.0"
    unofficial = True
    _allowed = {
        "mod_id", "mod_dir", "host_home", "data_home", "bootstrap", "state",
        "log", "api_version", "unofficial", "_allowed", "messages",
    }

    def __init__(self, tmp):
        self.mod_id = "kirocrew-ide"
        self.mod_dir = os.path.join(tmp, "mods", "kirocrew-ide")
        self.host_home = tmp
        self.data_home = os.path.join(tmp, "floofy")
        self.bootstrap = types.ModuleType("kiro_crew.platform.bootstrap")
        self.state = {}
        self.messages = []

    def log(self, message):
        self.messages.append(message)

    def __getattr__(self, name):  # only reached for attributes not set above
        raise AssertionError(
            "early() touched ctx.%s, which the early shim does not provide" % name
        )


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_early", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    hook = load_hook()
    ctx = StrictEarlyContext("/tmp/kirocrew-ide-early-test")

    modules_before = set(sys.modules)
    meta_before = len(sys.meta_path)

    hook.early(ctx)   # raises AssertionError if it touches an unavailable attribute

    # The data dir must be derived, since ctx.data_dir does not exist.
    expected = os.path.join(ctx.data_home, "mods", ctx.mod_id, ".floofy")
    assert hook._data_dir_hint["path"] == expected, hook._data_dir_hint
    assert ctx.messages, "early() should log what it did"

    # THE CRITICAL INVARIANT: early() must import NO host module. Doing so
    # during the host's own half-finished bootstrap raises a circular
    # ImportError and leaves broken entries in sys.modules, which takes down
    # the host CLI in every process — not just this mod.
    leaked = {n for n in set(sys.modules) - modules_before if n.startswith("kiro_crew")}
    assert not leaked, "early() imported host modules: %s" % sorted(leaked)
    assert len(sys.meta_path) == meta_before + 1, "the lazy armer should be installed"
    print("early contract OK (no host imports):", ctx.messages[-1])

    # The armer must patch the module only once the host imports it, and must
    # tolerate a module that has no register_app_routes at all.
    armer = sys.meta_path[0]
    assert armer.find_spec("something.else") is None, "must ignore other modules"
    fake = types.ModuleType("fake_routes")
    hook._wrap_register(fake)            # no attribute -> no-op, no raise
    calls = []
    fake.register_app_routes = lambda app, *a, **k: calls.append(app) or "ok"
    hook._wrap_register(fake)
    assert fake.register_app_routes("APP") == "ok", "the original must still run"
    assert calls == ["APP"], calls
    wrapper_once = fake.register_app_routes
    hook._wrap_register(fake)            # idempotent: must not wrap a wrapper
    assert fake.register_app_routes is wrapper_once, "double-wrapped"
    assert not hasattr(wrapper_once.__wrapped__, "__floofy_ide__"), "nested wrapper"
    print("wrap_register OK: original preserved, idempotent, tolerant")
    sys.meta_path.remove(armer)

    # And the proxy route adder must survive a hostile app object.
    class Broken:
        class router:
            @staticmethod
            def add_route(*_a, **_k):
                raise RuntimeError("router frozen")

    hook._add_proxy_route(None, Broken())
    assert hook._proxy_state["registered"] is False
    assert hook._proxy_state["error"], "a failed add_route must be recorded"
    print("route-add failure recorded:", hook._proxy_state["error"])


if __name__ == "__main__":
    main()
