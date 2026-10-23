"""Stuck-engine detection, the extension-host heap ceiling, and the relaunch route.

2026-10-20: an extension host hit node's default ~4 GB heap and died (SIGABRT);
the engine kept answering HTTP (status.running true, workbench HTML served) but
serviced no new WebSocket, so the page stayed blank through every client
reload. Three answers, all pinned here:

- `status.health.stuck` is true once a WebSocket bridge the proxy carries has
  been open 25 s with frames from the client and none from the engine, and the
  engine has shown no life on any bridge for as long. A bridge the engine
  answered or closed itself is a live engine; a bridge the client never spoke
  on proves nothing; bridges from before the engine's start (a relaunch) do not
  count. The first cut read the engine LOG for "New connection established"
  and raised false alarms (a reconnecting workbench is logged as "Unknown
  reconnection token"; a background tab fetches HTML and never connects).
- The engine is launched with `--max-old-space-size` in NODE_OPTIONS (8 GB by
  default, `engine.heap_mb` to change, 0 = node's default), which the server
  hands every extension host unchanged.
- `POST relaunch` stops and starts the engine keeping every open workspace.
"""

import importlib.util
import os
import sys
import tempfile
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_health", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Log:
    def __init__(self):
        self.lines = []

    def __getattr__(self, level):
        return lambda msg, *args, **_k: self.lines.append((level, msg % args if args else msg))


class _Config(dict):
    def get(self, key, default=None):
        return dict.get(self, key, default)

    def set(self, key, value):
        self[key] = value


class Ctx:
    def __init__(self, tmp, config=None):
        self.data_dir = tmp
        self.state = {}
        self.config = _Config(config or {})
        self.routes = types.SimpleNamespace(add=lambda *_a, **_k: None)
        self.log = _Log()


def write_engine_log(path, lines, mtime=None):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def test_health(hook, tmp):
    log = os.path.join(tmp, hook.ENGINE_LOG)
    now = time.time()
    hms = lambda t: time.strftime("%H:%M:%S", time.localtime(t))
    state = {"pid": 1, "port": 1, "startedAt": now - 600}

    def bridge(opened, up, down, closed=None, by=None):
        return {"opened": opened, "up": up, "down": down, "closed": closed, "closedBy": by}

    def reset(*bridges, alive=None, serves=()):
        hook._bridges.clear(); hook._bridges.extend(bridges)
        hook._html_serves.clear(); hook._html_serves.extend(serves)
        hook._engine_alive_at["t"] = alive

    write_engine_log(log, ["[%s] [127.0.0.1][aaaa][ManagementConnection] New connection established." % hms(now - 500)], mtime=now - 500)

    # Nothing connected yet: never stuck, however old the HTML serve (a background tab, a
    # wake-reload that never connected, prove nothing about the engine).
    reset(serves=[now - 300])
    h = hook._engine_health(state, now=now)
    assert h["stuck"] is False and h["silentBridges"] == 0 and abs(h["lastConnection"] - (now - 500)) < 2 and h["lastServe"] == now - 300, h

    # The 2026-10-20 shape: the client connected 30 s ago, sent its frames, the engine answered nothing. Stuck.
    reset(bridge(now - 30, up=5, down=0))
    h = hook._engine_health(state, now=now)
    assert h["stuck"] is True and h["silentBridges"] == 1 and "Relaunch" in h["reason"] and "30s" in h["reason"], h
    # Within the budget: not yet.
    assert hook._engine_health(state, now=now - 20)["stuck"] is False

    # The engine answered that bridge (one frame down): healthy.
    reset(bridge(now - 30, up=5, down=1), alive=now - 29)
    assert hook._engine_health(state, now=now)["stuck"] is False
    # A silent bridge, but the engine is alive on ANOTHER bridge right now: not stuck (the silent one
    # is a client that stalled, or a probe that only did the handshake).
    reset(bridge(now - 30, up=5, down=0), bridge(now - 100, up=40, down=60), alive=now - 3)
    assert hook._engine_health(state, now=now)["stuck"] is False
    # ...unless the engine has been silent everywhere for the budget too.
    reset(bridge(now - 30, up=5, down=0), bridge(now - 100, up=40, down=60), alive=now - 40)
    assert hook._engine_health(state, now=now)["stuck"] is True
    # A bridge the client never spoke on proves nothing (handshake-only probe).
    reset(bridge(now - 30, up=0, down=0))
    assert hook._engine_health(state, now=now)["stuck"] is False
    # A bridge the engine closed is a live engine's answer: "Unknown reconnection token" after a
    # relaunch looks exactly like this, and it raised the first cut's false alarm.
    reset(bridge(now - 30, up=2, down=0, closed=now - 29, by="engine"), alive=now - 29)
    assert hook._engine_health(state, now=now)["stuck"] is False
    # A bridge the client closed is gone too.
    reset(bridge(now - 30, up=2, down=0, closed=now - 20, by="client"))
    assert hook._engine_health(state, now=now)["stuck"] is False
    # Bridges from before the engine started do not count (a relaunch clears the condition),
    # and neither does the old engine's liveness.
    reset(bridge(now - 30, up=5, down=0), alive=now - 20)
    assert hook._engine_health({"pid": 1, "port": 1, "startedAt": now - 10}, now=now)["stuck"] is False
    reset(bridge(now - 30, up=5, down=0), alive=now - 40)
    assert hook._engine_health({"pid": 1, "port": 1, "startedAt": now - 35}, now=now)["stuck"] is True, "old liveness does not vouch for the new engine"
    # An unreadable engine log is a diagnostic gap, not a verdict.
    os.remove(log)
    reset(bridge(now - 30, up=5, down=0))
    h = hook._engine_health(state, now=now)
    assert h["stuck"] is True and h["lastConnection"] is None
    reset()
    print("health OK")


def test_midnight_wrap(hook, tmp):
    # A line stamped 23:59:50 in a file last written at 00:00:10 is yesterday's.
    log = os.path.join(tmp, hook.ENGINE_LOG)
    midnight = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1))
    write_engine_log(log, ["[23:59:50] [127.0.0.1][aaaa][ManagementConnection] New connection established."], mtime=midnight + 10)
    stamp = hook._last_engine_connection(log)
    assert abs(stamp - (midnight - 10)) < 2, (stamp, midnight)
    print("midnight wrap OK")


def test_heap_env(hook, tmp):
    hook._ctx = Ctx(tmp)
    env = hook._engine_env()
    assert env["NODE_OPTIONS"].split() == ["--max-old-space-size=8192"], env["NODE_OPTIONS"]
    os.environ["NODE_OPTIONS"] = "--max-old-space-size=100 --no-warnings"
    try:
        env = hook._engine_env()
        assert env["NODE_OPTIONS"].split() == ["--no-warnings", "--max-old-space-size=8192"], env["NODE_OPTIONS"]
        hook._ctx = Ctx(tmp, {"engine.heap_mb": 0})
        assert hook._engine_env()["NODE_OPTIONS"] == "--max-old-space-size=100 --no-warnings", "0 leaves node's own setting alone"
        hook._ctx = Ctx(tmp, {"engine.heap_mb": "6144"})
        assert "--max-old-space-size=6144" in hook._engine_env()["NODE_OPTIONS"]
    finally:
        del os.environ["NODE_OPTIONS"]
    print("heap env OK")


def test_relaunch(hook, tmp):
    hook._ctx = Ctx(tmp)
    calls = []
    hook._read_state = lambda: {"pid": 4242, "port": 35476, "folder": "/tmp/a", "workspaces": ["/tmp/a", "/tmp/b"]}
    hook._workspaces = lambda state: ["/tmp/a", "/tmp/b"]
    hook._stop = lambda req: calls.append("stop") or {"running": False}

    def fake_start(req):
        calls.append(("start", req.json()))
        return {"running": True, "server": {"pid": 9, "port": 35476, "folder": "/tmp/a"}, "workspaces": []}

    hook._start = fake_start
    hook._add_workspace = lambda state, folder: calls.append(("add", folder))
    hook._workspace_rows = lambda state: [{"folder": "/tmp/a"}, {"folder": "/tmp/b"}]
    hook._html_serves.append(time.time())
    hook._bridges.append({"opened": time.time(), "up": 1, "down": 0, "closed": None, "closedBy": None})
    hook._engine_alive_at["t"] = time.time()
    real_isdir = os.path.isdir
    os.path.isdir = lambda p: p in ("/tmp/a", "/tmp/b")
    try:
        result = hook._relaunch(None)
    finally:
        os.path.isdir = real_isdir
    assert calls == ["stop", ("start", {"folder": "/tmp/a"}), ("add", "/tmp/b")], calls
    assert result["note"] == "relaunched" and len(result["workspaces"]) == 2, result
    assert not hook._html_serves and not hook._bridges and hook._engine_alive_at["t"] is None, "a relaunch forgets the old engine's serves, bridges and liveness"
    hook._read_state = lambda: None
    assert hook._relaunch(None)[0] == 409
    print("relaunch OK")


def test_status_carries_health_and_heap(hook, tmp):
    hook._ctx = Ctx(tmp)
    hook._live_state = lambda: None
    hook._engine = lambda: ("openvscode-server", None)
    hook._host_label = lambda: "desk"
    body = hook._status(None)
    assert body["health"]["stuck"] is False and body["health"]["reason"] is None, body["health"]
    assert body["heapMb"] == 8192
    print("status OK")


def main():
    tmp = tempfile.mkdtemp(prefix="kide-health-")
    hook = load_hook()
    hook._ctx = Ctx(tmp)
    test_health(hook, tmp)
    test_midnight_wrap(hook, tmp)
    test_heap_env(hook, tmp)
    test_relaunch(hook, tmp)
    test_status_carries_health_and_heap(hook, tmp)
    print("engine health OK: stuck detection from the proxy's bridges, heap ceiling in NODE_OPTIONS, relaunch keeps workspaces")
    return 0


if __name__ == "__main__":
    sys.exit(main())
