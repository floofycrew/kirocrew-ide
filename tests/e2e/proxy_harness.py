"""Serve the mod's _proxy locally, fronting a (tunnelled) live engine.

Usage: proxy_harness.py <engine-origin> [port]

Mounts the hook's real proxy handler on http://127.0.0.1:<port>/kirocrew-ide
with no dashboard in front, so a headless browser can exercise the whole
proxy code path — letterpress interception, the webviewEndpoint rewrite of
the root document, WebSocket pumping. This is the same shape the gateway
registers, minus the host — EXCEPT for the one host behaviour that decides
whether a request reaches the proxy at all, which is modelled here:

  the dashboard's token auth answers a GET/HEAD on a non-API path that carries
  no session cookie with the SPA shell (200, text/html), never with the
  proxied resource.

A request whose browser omits credentials therefore gets HTML, exactly as in
production. That is what blanked every webview in 0.8.3: a module service
worker's script fetch carries no cookie by spec. The gate is armed by the
`?token=` first visit (which sets the cookie, as the dashboard does) so a
browser that starts at .../kirocrew-ide/?token=x behaves like a logged-in
dashboard tab.
"""

import importlib.util
import os
import sys
import types

sys.modules.setdefault("floofy", types.ModuleType("floofy"))

# KIDE_HOOK points the harness at another checkout's hook (e.g. a worktree of
# an older release) to demonstrate a regression against the same live engine.
_HOOK = os.environ.get("KIDE_HOOK") or os.path.join(os.path.dirname(__file__), "..", "..", "hook", "__init__.py")
spec = importlib.util.spec_from_file_location("kide_hook", os.path.abspath(_HOOK))
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def main():
    engine = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18476
    hook._engine_origin = lambda: engine
    from aiohttp import web

    cookie_name = "mc_token_%d" % port
    shell = "<!doctype html><title>KiroCrew</title><div id=root>SPA shell (no session)</div>"

    # KIDE_HARNESS_BLANK_FIRST=N: answer the first N loads of the webview host page
    # with the shell instead — a webview document that never runs its script — to
    # exercise the bridge's blank-chat watchdog (it must reload and recover).
    blank_first = {"left": int(os.environ.get("KIDE_HARNESS_BLANK_FIRST") or 0)}

    @web.middleware
    async def cookie_gate(request, handler):
        # Same decision the dashboard's token_auth makes for /kirocrew-ide/*:
        # ?token= logs in (sets the cookie); a cookie-less request gets the
        # SPA shell; websockets and everything else need the cookie too.
        if blank_first["left"] > 0 and request.path.endswith("/webview/browser/pre/index.html"):
            blank_first["left"] -= 1
            print("harness: BLANK webview host served on purpose (%d left)" % blank_first["left"], flush=True)
            return web.Response(text=shell, content_type="text/html")
        if request.query.get("token"):
            response = await handler(request)
            response.set_cookie(cookie_name, "sess", httponly=True, samesite="Lax", path="/")
            return response
        if request.cookies.get(cookie_name):
            return await handler(request)
        if request.method in ("GET", "HEAD") and request.headers.get("Upgrade", "").lower() != "websocket":
            print("harness: shell served (no cookie) %s" % request.path_qs[:160], flush=True)
            return web.Response(text=shell, content_type="text/html")
        return web.Response(status=403, text="Token required")

    # A stand-in for the few dashboard /api routes the bridge reads at start-up,
    # so the composer's pick lists can be asserted end to end. Shapes mirror the
    # host (see the survey in tests/webview_endpoint_test.py's neighbours).
    fake = {
        "/api/models": [{"model_name": "fable-5", "display_name": "Claude Fable 5"}, {"model_name": "sonnet-5", "display_name": "Claude Sonnet 5"}],
        "/api/effort-levels": ["low", "medium", "high", "max"],
        "/api/agents": [{"name": "desk-default", "description": "the default crew"}, {"name": "spec-writer", "description": ""}],
        "/api/agents/installed": [{"name": "desk-default"}, {"name": "spec", "description": "Kiro mode"}, {"name": "plan", "description": "Kiro mode"}],
        "/api/chat/slots": [],
        "/api/chat/folders": [{"id": "f1", "name": "KiroCrew IDE"}],
    }

    async def fake_api(request):
        body = fake.get(request.path)
        if body is None:
            return web.json_response({"error": "harness: no fake for " + request.path}, status=404)
        return web.json_response(body)

    async def fake_ws(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for _ in ws:
            pass
        return ws

    app = web.Application(middlewares=[cookie_gate])
    for path in fake:
        app.router.add_get(path, fake_api)
    app.router.add_get("/api/ws", fake_ws)
    app.router.add_route("*", hook.PROXY_BASE, hook._proxy)
    app.router.add_route("*", hook.PROXY_BASE + "/{path:.*}", hook._proxy)
    web.run_app(app, host="127.0.0.1", port=port, print=lambda *a: print("harness ready on %d" % port, flush=True))


if __name__ == "__main__":
    main()
