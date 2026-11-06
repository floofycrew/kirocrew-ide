"""A relaunch keeps the engine's port.

The engine is `sh` wrapping `node`. `_stop` watched the wrapper's pid, which dies
at once on SIGTERM while node is still closing its listener, so ~250 ms later
the port read busy and `_pick_port` moved to the next one: the engine flipped
between 35476 and 35477 on every relaunch (each new bridge version relaunches).
The workbench keys which profile a folder opens in by
`vscode-remote://127.0.0.1:<port>/<folder>`, so every other relaunch brought the
other port's stale entries back and a folder given a profile on one port opened
in Default on the other (2026-11-05). Now `_stop` waits for the port to be
released, remembers it, and `_pick_port` takes it again; the probe binds with
SO_REUSEADDR like node does, so TIME_WAIT leftovers do not count as busy.
"""

import importlib.util
import os
import socket
import sys
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def _load():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_port", HOOK)
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    return hook


class _Ctx:
    def __init__(self, config=None):
        self.config = config or {}
        self.state = {}


def _listener(port=0):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.listen(1)
    return sock


def main():
    hook = _load()
    hook._ctx = _Ctx()

    # --- the probe: a held listener is busy; a port with only TIME_WAIT leftovers is free ---
    held = _listener()
    port = held.getsockname()[1]
    assert not hook._port_free(port), "a listening socket is busy"
    client = socket.create_connection(("127.0.0.1", port))
    server_side, _ = held.accept()
    held.close()           # the listener is gone...
    server_side.close()    # ...and the accepted connection is closed from the server side: TIME_WAIT on our end
    client.close()
    assert hook._port_free(port), "TIME_WAIT leftovers do not make the port busy (node binds with SO_REUSEADDR too)"
    print("port probe: listener busy, TIME_WAIT free")

    # --- _wait_port_free: polls until the holder lets go ---
    held = _listener()
    port = held.getsockname()[1]
    t0 = time.time()
    assert not hook._wait_port_free(port, timeout=0.3), "still held: gives up after the timeout"
    assert 0.25 <= time.time() - t0 < 2
    threading.Timer(0.3, held.close).start()
    t0 = time.time()
    assert hook._wait_port_free(port, timeout=3), "released during the wait: returns True"
    assert time.time() - t0 < 2, "returns as soon as the port frees, not at the deadline"
    print("wait_port_free: gives up on a held port, returns early on a released one")

    # --- _pick_port: the last engine's port first (waiting for it), then the base scan ---
    base_hold = _listener(hook.PORT_BASE) if hook._port_free(hook.PORT_BASE) else None  # make the base busy so the scan is observable
    try:
        hook._ctx.state["last_port"] = port  # free now (released above)
        assert hook._pick_port() == port, "a free last port is taken again"
        held = _listener(port)
        hook.PORT_RELEASE_WAIT, saved = 0.3, hook.PORT_RELEASE_WAIT
        try:
            picked = hook._pick_port()
            assert picked != port and picked != hook.PORT_BASE and hook.PORT_BASE < picked < hook.PORT_BASE + hook.PORT_SCAN, \
                "a last port that stays busy past the wait falls back to the scan (%d)" % picked
            threading.Timer(0.1, held.close).start()
            hook.PORT_RELEASE_WAIT = 2
            assert hook._pick_port() == port, "a last port released during the wait is kept"
        finally:
            hook.PORT_RELEASE_WAIT = saved
            held.close()
        hook._ctx.state.pop("last_port", None)
        picked = hook._pick_port()
        assert picked != hook.PORT_BASE if base_hold else picked == hook.PORT_BASE, "no last port: the base scan as before (%d)" % picked
        hook._ctx = _Ctx({"engine.port": port})
        assert hook._pick_port() == port, "a pinned port is honoured"
    finally:
        if base_hold:
            base_hold.close()
    print("pick_port: last port first, scan after the wait, pin honoured")

    # --- _stop remembers the port and waits for it ---
    hook._ctx = _Ctx()
    held = _listener()
    port = held.getsockname()[1]
    state = {"pid": 999999999, "port": port}  # no such process: only the port part runs
    hook._read_state = lambda: state
    hook._pid_alive = lambda pid: False
    hook._clear_state = lambda: None
    logged = []
    hook._ctx.log = types.SimpleNamespace(info=lambda *a: logged.append(("info", a)), warning=lambda *a: logged.append(("warning", a)))
    threading.Timer(0.2, held.close).start()
    t0 = time.time()
    hook._stop(None)
    assert hook._ctx.state["last_port"] == port, "the stopped engine's port is remembered for the relaunch"
    assert time.time() - t0 < 2 and not [l for l in logged if l[0] == "warning"], "waited for the release, no warning"
    held = _listener()
    state["port"] = held.getsockname()[1]
    hook.PORT_RELEASE_WAIT = 0.3
    hook._stop(None)
    held.close()
    assert [l for l in logged if l[0] == "warning"], "a port still busy after the wait is logged"
    print("stop: remembers the port, waits for its release, warns when it stays busy")
    print("engine_port_test: ok")


if __name__ == "__main__":
    main()
