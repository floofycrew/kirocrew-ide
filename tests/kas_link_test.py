"""The Kas_Link over a real aiohttp WebSocket through the hook's `_proxy` (requirements 1.6, 9.1).

The hook module is loaded bare with a fake engine state (two open workspaces)
and a KasManager whose `kiro-cli` is the fake KAS. Through a listening proxy:
a plain GET on the Kas_Link path is 426; a cross-origin upgrade is 403; a
same-origin upgrade carries hello → new → prompt and streams the `update` /
`turnEnd` frames back with sequence numbers; a malformed frame is answered
with an `error` and the socket stays open; a hello for a folder the engine has
not open is refused; the mod routes `kas/status`, `kas/sessions`,
`kas/sessions/{id}/transcript` answer through the route table.

Needs aiohttp (the gateway's own runtime has it); skipped where it is missing.
"""
import asyncio
import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")
FAKE = os.path.join(HERE, "e2e", "fake_kas.py")

try:
    import aiohttp
    from aiohttp import web
except ImportError:  # pragma: no cover
    aiohttp = web = None


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_kaslink", HOOK)
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


class _Ctx:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.config = _Config()
        self.log = _Log()
        self.state = {}


class _Routes:
    def __init__(self):
        self.table = {}

    def add(self, method, path, handler):
        self.table[(method, path)] = handler


class _Req:
    def __init__(self, params=None, query=None):
        self.params = params or {}
        self.query = query or {}


async def main():
    if web is None:
        print("kas_link_test: SKIP (aiohttp not importable here; run with the gateway's python)")
        return
    tmp = tempfile.mkdtemp(prefix="kas-link-")
    try:
        ws_a = os.path.join(tmp, "ws-a")
        ws_b = os.path.join(tmp, "ws-b")
        closed = os.path.join(tmp, "closed")
        for d in (ws_a, ws_b, closed):
            os.makedirs(d)
        wrapper = os.path.join(tmp, "kiro-cli")
        with open(wrapper, "w") as fh:
            fh.write("#!/bin/sh\nexec %s %s \"$@\"\n" % (sys.executable, FAKE))
        os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IEXEC)
        os.environ["FAKE_KAS_STATE"] = os.path.join(tmp, "fake-state")

        hook = load_hook()
        ctx = _Ctx(os.path.join(tmp, "data"))
        hook._ctx = ctx
        hook._live_state = lambda: {"pid": os.getpid(), "port": 1, "folder": ws_a, "workspaces": [ws_a, ws_b]}
        hook._engine_origin = lambda: None   # no engine behind the proxy: only the Kas_Link path answers
        manager = hook._kas_manager()
        manager.which = lambda name: wrapper if name == "kiro-cli" else None

        routes = _Routes()
        ctx.routes = routes
        # register the kas routes the way activate() does, without the engine side effects
        for method, path, handler in (("GET", "kas/status", hook._kas_status), ("GET", "kas/sessions", hook._kas_sessions),
                                      ("GET", "kas/sessions/{id}/transcript", hook._kas_transcript), ("GET", "kas/tasks", hook._kas_tasks)):
            routes.add(method, path, handler)

        app = web.Application()
        app.router.add_route("*", hook.PROXY_BASE + "/{path:.*}", hook._proxy_trampoline)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = runner.addresses[0][1]
        base = "http://127.0.0.1:%d" % port
        path = hook.KAS_WS_PATH

        async with aiohttp.ClientSession() as http:
            async with http.get(base + path) as r:
                assert r.status == 426, r.status
            try:
                await http.ws_connect(base + path, headers={"Origin": "http://evil.example"})
                raise AssertionError("cross-origin upgrade accepted")
            except aiohttp.WSServerHandshakeError as error:
                assert error.status == 403, error.status
            print("ok 426 without upgrade, 403 cross-origin")

            ws = await http.ws_connect(base + path, headers={"Origin": base})

            async def recv(pred, timeout=20.0):
                got = []
                async def _loop():
                    while True:
                        msg = await ws.receive()
                        assert msg.type == aiohttp.WSMsgType.TEXT, msg
                        frame = json.loads(msg.data)
                        got.append(frame)
                        if pred(frame):
                            return frame
                try:
                    return await asyncio.wait_for(_loop(), timeout), got
                except asyncio.TimeoutError:
                    raise AssertionError("timed out; got %s" % [g.get("kind") for g in got])

            await ws.send_str("not json")
            err, _ = await recv(lambda f: f.get("kind") == "error")
            assert err["code"] == -32602, err
            await ws.send_str(json.dumps({"op": "prompt", "sessionId": "x", "blocks": "nope"}))
            err, _ = await recv(lambda f: f.get("kind") == "error")
            assert "blocks" in err["message"], err
            await ws.send_str(json.dumps({"op": "hello", "folder": closed, "ref": "bad"}))
            err, _ = await recv(lambda f: f.get("kind") == "error" and f.get("ref") == "bad")
            assert "not open" in err["message"] and closed in err["message"], err
            assert not manager.children, "a refused folder spawned nothing"
            print("ok malformed frames and a closed folder are errors, socket stays open")

            await ws.send_str(json.dumps({"op": "hello", "folder": ws_a, "ref": "h"}))
            hi, _ = await recv(lambda f: f.get("kind") == "hello")
            assert hi["ref"] == "h" and hi["login"] is True and any(m["id"] == "plan" for m in hi["modes"]), hi
            await ws.send_str(json.dumps({"op": "new", "mode": "bug-fix", "ref": "n", "autopilot": False}))
            created, _ = await recv(lambda f: f.get("kind") == "created")
            sid = created["sessionId"]
            assert created["mode"] == "bug-fix"
            await ws.send_str(json.dumps({"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "over the wire"}], "ref": "p"}))
            end, got = await recv(lambda f: f.get("kind") == "turnEnd")
            kinds = [g.get("kind") for g in got]
            assert "accepted" in kinds and kinds.count("update") >= 3, kinds
            seqs = [g["seq"] for g in got if "seq" in g]
            assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), seqs
            text = "".join(g["update"]["content"]["text"] for g in got if g.get("kind") == "update" and g["update"]["sessionUpdate"] == "agent_message_chunk")
            assert text == "Echo (bug-fix): over the wire", text
            print("ok hello → new → prompt streams with sequence numbers over the WebSocket")

            # a second socket attaches with `since` and gets only the tail
            ws2 = await http.ws_connect(base + path, headers={"Origin": base})
            await ws2.send_str(json.dumps({"op": "hello", "folder": ws_a}))
            await ws2.receive()
            await ws2.send_str(json.dumps({"op": "attach", "sessionId": sid, "since": end["seq"] - 1}))
            frames = []
            while True:
                msg = await asyncio.wait_for(ws2.receive(), 5)
                frames.append(json.loads(msg.data))
                if frames[-1].get("kind") == "turnEnd":
                    break
            assert [f.get("kind") for f in frames] == ["attached", "turnEnd"], [f.get("kind") for f in frames]
            assert manager.children and list(manager.children.values())[0].attached_count() == 2
            await ws2.close()
            await asyncio.sleep(0.2)
            assert list(manager.children.values())[0].attached_count() == 1
            print("ok attach tail replay on a second socket; link count follows the sockets")

            # the JSON routes
            status = await routes.table[("GET", "kas/status")](_Req())
            assert status["available"] is True and status["workspaces"][0]["sessions"] == [sid], status["workspaces"]
            sessions = routes.table[("GET", "kas/sessions")](_Req())
            assert any(r["sessionId"] == sid and r["mode"] == "bug-fix" for r in sessions["sessions"]), sessions
            transcript = routes.table[("GET", "kas/sessions/{id}/transcript")](_Req(params={"id": sid}))
            assert transcript["count"] >= 3 and transcript["frames"][-1]["kind"] == "turnEnd", transcript["count"]
            tasks = routes.table[("GET", "kas/tasks")](_Req(query={"folder": [ws_a], "feature": ["nope"]}))
            assert tasks["exists"] is False and tasks["tasks"] == {}, tasks
            assert routes.table[("GET", "kas/tasks")](_Req(query={"folder": [ws_a], "feature": ["../x"]}))[0] == 400
            print("ok kas/status, kas/sessions, transcript and tasks routes")

            await ws.close()
        children = list(manager.children.values())
        hook.deactivate(ctx)
        assert not manager.children
        for child in children:
            await asyncio.wait_for(child.client.proc.wait(), 10)   # SIGTERM from deactivate ends the fake
            assert child.client.proc.returncode is not None
        await asyncio.sleep(0.2)
        await runner.cleanup()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("kas_link_test: OK")


if __name__ == "__main__":
    asyncio.run(main())
