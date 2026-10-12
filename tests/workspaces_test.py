"""Workspaces: several folders on ONE engine, each its own workbench document.

The engine serves any folder a document asks for with `?folder=`, so a second
workspace is a second embed URL, not a second process. The open set lives in the
engine's persisted state (survives a gateway restart with the engine, cleared
with it on stop); `status` reports a row per workspace with its embed URL;
`workspaces/open` adds one (and boots the engine when none runs);
`workspaces/close` forgets one and leaves the engine up; `start` on a running
engine with a new folder opens it instead of being ignored.
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_ws", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Log:
    def __getattr__(self, _name):
        return lambda *_a, **_k: None


class Ctx:
    def __init__(self, tmp):
        self.data_dir = tmp
        self.state = {"server": {"port": 35476, "folder": None, "engine": "openvscode-server"}}
        self.config = types.SimpleNamespace(get=lambda _k, d=None: d)
        self.routes = types.SimpleNamespace(add=lambda *_a, **_k: None)
        self.log = _Log()


class Req:
    def __init__(self, body):
        self._body = body
        self.query = {}

    def json(self):
        return self._body


def main():
    hook = load_hook()
    tmp = tempfile.mkdtemp(prefix="ide-ws-")
    try:
        a, b, c = (os.path.join(tmp, n) for n in ("alpha", "beta", "gamma"))
        for d in (a, b, c):
            os.makedirs(d)
        ctx = Ctx(tmp)
        hook._ctx = ctx
        hook._state_path = lambda: os.path.join(tmp, "server.json")
        hook._pid_alive = lambda pid: pid == 4242
        hook._port_open = lambda port: port == 35476
        hook._proxy_registered = lambda: True
        hook._extension_version = lambda: None   # bridge dimension of the mismatch check is neutral here
        live = {"pid": 4242, "port": 35476, "token": "T", "proxied": True,
                "folder": a, "engine": "openvscode-server", "startedAt": 0}
        hook._write_state(live)
        ctx.state["server"]["folder"] = a

        # One workspace: the start folder, with the plain embed URL.
        status = hook._status(None)
        assert [r["folder"] for r in status["workspaces"]] == [a], status["workspaces"]
        assert status["workspaces"][0]["name"] == "alpha"
        assert status["workspaces"][0]["embedUrl"] == status["embedUrl"]
        assert "folder=" + a in status["embedUrl"] and "tkn=T" in status["embedUrl"]

        # Open two more: same engine, each row its own ?folder=, the token shared.
        out = hook._workspaces_open(Req({"folder": b}))
        assert out["running"] and [r["folder"] for r in out["workspaces"]] == [a, b]
        out = hook._workspaces_open(Req({"folder": b}))
        assert [r["folder"] for r in out["workspaces"]] == [a, b], "idempotent"
        out = hook._start(Req({"folder": c}))
        assert out["note"] == "already running"
        assert [r["folder"] for r in out["workspaces"]] == [a, b, c], "start on a running engine opens the folder"
        urls = [r["embedUrl"] for r in out["workspaces"]]
        assert len(set(urls)) == 3 and all("tkn=T" in u for u in urls)
        assert "folder=" + c in urls[2]
        assert hook._read_state()["workspaces"] == [a, b, c], "persisted with the engine"
        assert ctx.state["recentFolders"][0] == c, "remembered for the picker"

        # Bad input.
        assert hook._workspaces_open(Req({}))[0] == 400
        assert hook._workspaces_open(Req({"folder": os.path.join(tmp, "nope")}))[0] == 400
        assert hook._start(Req({"folder": os.path.join(tmp, "nope")}))[0] == 400

        # Close the lead folder: the next one leads, the engine stays up.
        out = hook._workspaces_close(Req({"folder": a}))
        assert out["running"] and [r["folder"] for r in out["workspaces"]] == [b, c]
        assert hook._read_state()["folder"] == b
        assert ctx.state["server"]["folder"] == b
        assert "folder=" + b in out["embedUrl"]
        hook._workspaces_close(Req({"folder": b}))
        out = hook._workspaces_close(Req({"folder": c}))
        assert out["running"] and out["workspaces"] == [], "last one closed: engine up, nothing open"
        assert hook._read_state()["folder"] is None
        assert "folder=" not in out["embedUrl"]
        assert hook._workspaces_close(Req({"folder": c}))["workspaces"] == [], "closing twice is harmless"

        # No engine: open boots it with that folder (start is the path; here it stops at 'no engine').
        hook._clear_state()
        hook._engine = lambda: (None, None)
        out = hook._workspaces_open(Req({"folder": a}))
        assert out[0] == 409 and out[1]["error"] == "no engine found", out
        assert hook._workspaces_close(Req({"folder": a})) == {"running": False, "workspaces": []}
        assert hook._status(None)["workspaces"] == []

        # Idle unloading: the limit rides on status (default 15, config key wins, 0 = never),
        # and settings/idle-unload writes it through the mod config so every client shares it.
        store = {}
        ctx.config = types.SimpleNamespace(get=lambda k, d=None: store.get(k, d), set=lambda k, v: store.__setitem__(k, v))
        assert hook._status(None)["idleUnloadMinutes"] == 15
        assert hook._set_idle_unload(Req({"minutes": 30})) == {"idleUnloadMinutes": 30} and store["idle_unload_minutes"] == 30
        assert hook._status(None)["idleUnloadMinutes"] == 30
        assert hook._set_idle_unload(Req({"minutes": 0}))["idleUnloadMinutes"] == 0 and hook._status(None)["idleUnloadMinutes"] == 0
        assert hook._set_idle_unload(Req({"minutes": "x"}))[0] == 400
        assert hook._set_idle_unload(Req({"minutes": -5}))[0] == 400
        store["idle_unload_minutes"] = "junk"
        assert hook._status(None)["idleUnloadMinutes"] == 15, "an unreadable value falls back to the default"
        print("workspaces_test: ok")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
