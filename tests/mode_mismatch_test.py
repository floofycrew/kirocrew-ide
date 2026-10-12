"""An adopted engine whose serving mode disagrees with the proxy is relaunched.

Regression for the "forward that port too" hint appearing on a remote host
right after the gateway restart that armed the same-origin proxy: the engine
still running from before that restart had been launched in direct-port mode,
the hook adopted it as-is, and the page fell back to the loopback URL. Now
``activate()`` and ``POST start`` relaunch such an engine under the live mode.
"""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_mismatch", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Ctx:
    def __init__(self, tmp):
        self.data_dir = tmp
        self.state = {}
        self.config = _Config()
        self.routes = _Routes()
        self.log = _Log()


class _Config:
    def get(self, _key, default=None):
        return default


class _Routes:
    def add(self, *_a, **_k):
        pass


class _Log:
    def __init__(self):
        self.lines = []

    def _rec(self, level):
        return lambda msg, *args: self.lines.append((level, msg % args if args else msg))

    def __getattr__(self, name):
        return self._rec(name)


def main():
    import tempfile

    hook = load_hook()
    tmp = tempfile.mkdtemp(prefix="ide-mismatch-")
    ctx = Ctx(tmp)

    # A live engine that was launched in direct mode...
    live = {"pid": 4242, "port": 35476, "token": "", "proxied": False,
            "folder": tmp, "engine": "openvscode-server", "startedAt": 0}
    hook._read_state = lambda: dict(live)
    hook._pid_alive = lambda pid: pid == 4242
    hook._port_open = lambda port: port == 35476
    cleared = []
    hook._clear_state = lambda: cleared.append(True)
    stopped = []
    real_stop = hook._stop

    def fake_stop(_request):
        stopped.append(True)
        hook._read_state = lambda: None   # after the stop, nothing is live
        return {"running": False}

    hook._stop = fake_stop
    started = []

    def fake_start(request):
        started.append(request.json())
        return {"running": True, "server": {"pid": 7, "port": 35476, "folder": tmp,
                                             "engine": "openvscode-server", "proxied": True}}

    real_start = hook._start
    hook._start = fake_start

    # ...while the proxy is live: activate() must relaunch it in the same folder.
    hook._proxy_state["registered"] = True
    hook._extension_version = lambda: None      # bridge dimension neutral for these cases
    assert hook._mode_mismatch(live) is True
    hook.activate(ctx)
    assert stopped == [True], "the direct-mode engine was stopped"
    assert started == [{"folder": tmp}], started
    assert ctx.state["server"]["port"] == 35476
    assert any("relaunching" in line for _, line in ctx.log.lines), ctx.log.lines

    # Matching modes: adopted as-is, nothing relaunched.
    stopped.clear()
    started.clear()
    hook._read_state = lambda: dict(live, proxied=True)
    hook.activate(Ctx(tmp))
    assert stopped == [] and started == [], "a matching engine is left alone"

    # POST start with a mismatched live engine relaunches instead of 'already running'.
    hook._stop, hook._start = fake_stop, real_start
    hook._read_state = lambda: dict(live)          # direct mode again
    hook._proxy_state["registered"] = True
    hook._ctx = ctx
    hook._engine = lambda: (None, None)            # no engine binary: start stops at 409
    result = hook._start(hook._FolderRequest(tmp))
    assert stopped == [True], "start stopped the mismatched engine first"
    assert isinstance(result, tuple) and result[0] == 409, result
    assert "already running" not in str(result)

    # The reverse mismatch (proxied engine, proxy gone) counts too.
    hook._proxy_state["registered"] = False
    assert hook._mode_mismatch(dict(live, proxied=True)) is True
    assert hook._mode_mismatch(dict(live, proxied=False)) is False
    assert hook._mode_mismatch(None) is False

    # The bridge extension is a launch-time fact too: an engine started without
    # the (current) bridge is relaunched, one started with it is left alone.
    hook._extension_version = lambda: "0.1.0"
    assert hook._mode_mismatch(dict(live, proxied=False)) is True, "engine predates the bridge"
    assert hook._mode_mismatch(dict(live, proxied=False, bridge="0.0.9")) is True, "stale bridge"
    assert hook._mode_mismatch(dict(live, proxied=False, bridge="0.1.0")) is False
    hook._extension_version = lambda: None
    assert hook._mode_mismatch(dict(live, proxied=False, bridge="0.1.0")) is True, "mod dropped the bridge"
    hook._stop = real_stop
    print("mode mismatch OK: mismatched engines are relaunched, matching ones adopted")


if __name__ == "__main__":
    main()
