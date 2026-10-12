"""The proxy registration survives a Loader reload of the hook module.

`floofy install --now` / `floofy update` re-import the hook with fresh globals
while the raw route registered at gateway start stays on the aiohttp app. A
reloaded module must still know the proxy is live — the first version of the
mode-mismatch relaunch did not, and moved a working proxied engine back into
direct-port mode on every reinstall (owner-observed on the sandbox, 2026-09-23).
"""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load_hook(name):
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location(name, HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeRouter:
    def __init__(self):
        self.routes = []

    def add_route(self, method, path, handler):
        self.routes.append((method, path))


class FakeApp:
    def __init__(self):
        self.router = FakeRouter()


def main():
    first = load_hook("kirocrew_ide_hook_gen1")
    host_routes = types.ModuleType(first.ROUTES_MODULE)
    host_routes.register_app_routes = lambda app: None
    previous = sys.modules.get(first.ROUTES_MODULE)
    sys.modules[first.ROUTES_MODULE] = host_routes
    try:
        assert first._proxy_registered() is False, "nothing registered yet"
        app = FakeApp()
        first._add_proxy_route(None, app)
        assert first._proxy_registered() is True
        assert (("*", first.PROXY_BASE) in app.router.routes)
        record = getattr(host_routes, first.PROXY_RECORD_ATTR)
        assert record["registered"] and record["base"] == first.PROXY_BASE and record["pid"] == os.getpid()

        # The Loader reloads the hook: a second module object with fresh globals.
        second = load_hook("kirocrew_ide_hook_gen2")
        assert second._proxy_state["registered"] is False, "fresh globals, as after a reload"
        assert second._proxy_registered() is True, "but the process-level record is found"
        live = {"pid": 1, "port": 35476, "proxied": True, "folder": "/", "engine": "x", "bridge": second._extension_version()}
        assert second._mode_mismatch(live) is False, "a proxied engine is NOT relaunched after a reload"
        assert second._mode_mismatch(dict(live, proxied=False)) is True

        # A record for a different base path does not count.
        setattr(host_routes, first.PROXY_RECORD_ATTR, {"registered": True, "base": "/elsewhere"})
        assert second._proxy_registered() is False

        # Upgrade path: an older hook wrapped the host function but wrote no record.
        delattr(host_routes, first.PROXY_RECORD_ATTR)
        assert second._proxy_registered() is False
        second._wrap_register(host_routes)
        assert getattr(host_routes.register_app_routes, "__floofy_ide__", False)
        assert second._proxy_registered() is True, "the <=0.4.3 wrapper marker counts as live"
    finally:
        if previous is None:
            sys.modules.pop(first.ROUTES_MODULE, None)
        else:
            sys.modules[first.ROUTES_MODULE] = previous
    print("reload OK: a reloaded hook still sees the live proxy and leaves a proxied engine alone")


if __name__ == "__main__":
    main()
