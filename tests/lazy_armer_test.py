"""The lazy armer must patch the target module when it is really imported.

Builds a throwaway package on disk with the same name shape as the host's
(`kiro_crew.apps.routes` is simulated by pointing ROUTES_MODULE at it), imports
it the normal way, and checks the armer wrapped `register_app_routes` and then
removed itself from sys.meta_path.
"""

import importlib
import importlib.util
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_lazy", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    hook = load_hook()
    tmp = tempfile.mkdtemp(prefix="floofy-armer-")

    # A stand-in for the host package: pkg/sub/routes.py
    pkg = os.path.join(tmp, "fakehost", "apps")
    os.makedirs(pkg)
    open(os.path.join(tmp, "fakehost", "__init__.py"), "w").close()
    open(os.path.join(pkg, "__init__.py"), "w").close()
    with open(os.path.join(pkg, "routes.py"), "w") as handle:
        handle.write("registered = []\n"
                     "def register_app_routes(app):\n"
                     "    registered.append(app)\n"
                     "    return 'original'\n")
    sys.path.insert(0, tmp)
    hook.ROUTES_MODULE = "fakehost.apps.routes"

    added = []

    def fake_add(result, app):
        added.append(app)
        hook._proxy_state["registered"] = True
        return result

    hook._add_proxy_route = fake_add

    messages = []
    ctx = types.SimpleNamespace(
        mod_id="kirocrew-ide", mod_dir=tmp, host_home=tmp,
        data_home=os.path.join(tmp, "floofy"), bootstrap=None, state={},
        log=messages.append,
    )
    meta_before = len(sys.meta_path)
    hook.early(ctx)
    assert len(sys.meta_path) == meta_before + 1

    # The real import — this is what the host does.
    routes = importlib.import_module("fakehost.apps.routes")
    assert hook._proxy_state["armed"] is True, "the armer did not fire"
    assert len(sys.meta_path) == meta_before, "the armer did not remove itself"

    result = routes.register_app_routes("THE_APP")
    assert result == "original", result
    assert routes.registered == ["THE_APP"], routes.registered
    assert added == ["THE_APP"], "our route adder did not receive the app: %s" % added
    print("lazy armer OK: fired on real import, original ran, app forwarded")
    print("messages:", messages)


if __name__ == "__main__":
    main()
