"""The same-origin proxy's WebSocket bridge fails loudly and cleans up.

The blank-page case (2026-10-20): a workbench document whose WebSocket never
reached the engine showed nothing, because the proxy accepted the browser's
upgrade before connecting upstream and swallowed every error — an upstream
failure became a socket that opened and closed in silence, logged as a 101.
Now the engine is connected FIRST: an unreachable or non-answering engine is a
502 before any upgrade (the workbench shows its connection error and retries),
a successful bridge pumps both ways, cancels the surviving pump on close (no
"Task exception was never retrieved"), and the proxy log + the
`status.proxy.websockets` counters record what happened.

Needs aiohttp (the gateway's own runtime has it); skipped where it is missing.
"""

import asyncio
import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook", "__init__.py")

try:
    import aiohttp
    from aiohttp import web
except ImportError:  # pragma: no cover — environment without the gateway's runtime
    aiohttp = web = None


def load_hook():
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location("kirocrew_ide_hook_ws", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Log:
    def __init__(self):
        self.lines = []

    def __getattr__(self, level):
        return lambda msg, *args, **_k: self.lines.append((level, msg % args if args else msg))


async def _engine_app(accept=True, hang=False):
    """A stand-in engine: echoes `vscode` frames back with a prefix, or refuses."""
    async def ws(request):
        if hang:
            # Outlive the proxy's timeout; the proxy drops this connection first.
            await asyncio.sleep(1.0)
            if request.transport is None or request.transport.is_closing():
                return web.Response(status=499)
        if not accept:
            raise web.HTTPForbidden(text="no")
        peer = web.WebSocketResponse(protocols=("vscode",))
        await peer.prepare(request)
        async for message in peer:
            if message.type == aiohttp.WSMsgType.TEXT:
                await peer.send_str("engine:" + message.data)
            elif message.type == aiohttp.WSMsgType.BINARY:
                await peer.send_bytes(b"engine:" + message.data)
            else:
                break
        return peer

    app = web.Application()
    app.router.add_route("*", "/{path:.*}", ws)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    return runner, port


async def _proxy_app(hook, engine_port):
    hook._engine_origin = lambda: "http://127.0.0.1:%d" % engine_port
    app = web.Application()
    app.router.add_route("*", hook.PROXY_BASE + "/{path:.*}", hook._proxy)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, runner.addresses[0][1]


async def scenario_bridge(hook):
    engine, eport = await _engine_app()
    proxy, pport = await _proxy_app(hook, eport)
    try:
        before = dict(hook._ws_stats)
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect("ws://127.0.0.1:%d%s/stable-abc?reconnectionToken=x" % (pport, hook.PROXY_BASE), protocols=("vscode",)) as ws:
                assert ws.protocol == "vscode", ws.protocol
                await ws.send_str("hello")
                reply = await asyncio.wait_for(ws.receive(), 5)
                assert reply.type == aiohttp.WSMsgType.TEXT and reply.data == "engine:hello", reply
                await ws.send_bytes(b"\x01\x02")
                reply = await asyncio.wait_for(ws.receive(), 5)
                assert reply.type == aiohttp.WSMsgType.BINARY and reply.data == b"engine:\x01\x02", reply
                assert hook._ws_stats["live"] == before["live"] + 1, hook._ws_stats
                assert hook._ws_stats["opened"] == before["opened"] + 1, hook._ws_stats
        # The browser closed: the bridge winds down, the surviving pump is cancelled, nothing leaks.
        for _ in range(50):
            if hook._ws_stats["live"] == before["live"]:
                break
            await asyncio.sleep(0.05)
        assert hook._ws_stats["live"] == before["live"], hook._ws_stats
        notes = [e["note"] for e in hook._proxy_log if e["path"].startswith(hook.PROXY_BASE + "/stable-abc")]
        assert notes[0] == "ws" and notes[-1].startswith("ws-closed after ") and "by client (2 up, 2 down)" in notes[-1], notes
        # The bridge record the stuck verdict reads: frames both ways, closed by the client, engine alive.
        rec = hook._bridges[-1]
        assert rec["up"] == 2 and rec["down"] == 2 and rec["closedBy"] == "client" and rec["closed"], rec
        assert hook._engine_alive_at["t"] and hook._engine_alive_at["t"] >= rec["opened"]
        assert hook._engine_health({"startedAt": rec["opened"] - 1}, now=rec["opened"] + 60)["stuck"] is False
        statuses = [e["status"] for e in hook._proxy_log if e["path"].startswith(hook.PROXY_BASE + "/stable-abc")]
        assert statuses == [101, 101], statuses
        # No orphaned pump task is left behind to raise later.
        await asyncio.sleep(0.1)
        stray = [t for t in asyncio.all_tasks() if "pump" in repr(t.get_coro())]
        assert not stray, stray
    finally:
        await proxy.cleanup()
        await engine.cleanup()


async def scenario_refused(hook):
    engine, eport = await _engine_app(accept=False)
    proxy, pport = await _proxy_app(hook, eport)
    try:
        before = dict(hook._ws_stats)
        async with aiohttp.ClientSession() as session:
            try:
                await session.ws_connect("ws://127.0.0.1:%d%s/stable-refused" % (pport, hook.PROXY_BASE), protocols=("vscode",))
            except aiohttp.WSServerHandshakeError as error:
                assert error.status == 502, error.status
            else:
                raise AssertionError("the upgrade was accepted although the engine refused it")
        assert hook._ws_stats["failed"] == before["failed"] + 1, hook._ws_stats
        assert hook._ws_stats["opened"] == before["opened"], hook._ws_stats
        entry = [e for e in hook._proxy_log if e["path"].endswith("/stable-refused")][-1]
        assert entry["status"] == 502 and entry["note"].startswith("ws-upstream-failed"), entry
        assert any(level == "warning" and "websocket upstream" in msg for level, msg in hook._ctx.log.lines), hook._ctx.log.lines
    finally:
        await proxy.cleanup()
        await engine.cleanup()


async def scenario_engine_down(hook):
    # Nothing listening on the engine port at all (the engine died under the document).
    probe, dead_port = await _engine_app()
    await probe.cleanup()
    proxy, pport = await _proxy_app(hook, dead_port)
    try:
        async with aiohttp.ClientSession() as session:
            try:
                await session.ws_connect("ws://127.0.0.1:%d%s/stable-down" % (pport, hook.PROXY_BASE), protocols=("vscode",))
            except aiohttp.WSServerHandshakeError as error:
                assert error.status == 502, error.status
            else:
                raise AssertionError("the upgrade was accepted although nothing listens upstream")
    finally:
        await proxy.cleanup()


async def scenario_hang(hook):
    hook.WS_UPSTREAM_TIMEOUT_S = 0.3
    engine, eport = await _engine_app(hang=True)
    proxy, pport = await _proxy_app(hook, eport)
    try:
        async with aiohttp.ClientSession() as session:
            try:
                await asyncio.wait_for(session.ws_connect("ws://127.0.0.1:%d%s/stable-hang" % (pport, hook.PROXY_BASE), protocols=("vscode",)), 5)
            except aiohttp.WSServerHandshakeError as error:
                assert error.status == 502, error.status
            else:
                raise AssertionError("a hanging engine must not leave the browser's socket half-open")
        entry = [e for e in hook._proxy_log if e["path"].endswith("/stable-hang")][-1]
        assert "Timeout" in entry["note"] or "ws-upstream-failed" in entry["note"], entry
    finally:
        await proxy.cleanup()
        await engine.cleanup()


def test_status_carries_the_counters(hook):
    hook._live_state = lambda: None
    hook._engine = lambda: ("openvscode-server", None)
    hook._host_label = lambda: "desk"
    hook._idle_unload_minutes = lambda: 15
    body = hook._status(None)
    assert body["proxy"]["websockets"] == hook._ws_stats
    assert set(body["proxy"]["websockets"]) == {"opened", "failed", "live"}


def main():
    if aiohttp is None:
        print("ws_proxy_test: SKIP (aiohttp not importable here; run with the gateway's python)")
        return 0
    hook = load_hook()
    hook._ctx = types.SimpleNamespace(log=_Log(), data_dir="/nonexistent",
                                      config=types.SimpleNamespace(get=lambda _k, d=None: d))
    test_status_carries_the_counters(hook)
    for scenario in (scenario_bridge, scenario_refused, scenario_engine_down, scenario_hang):
        asyncio.run(scenario(hook))
        print("ok", scenario.__name__)
    print("ws_proxy_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
