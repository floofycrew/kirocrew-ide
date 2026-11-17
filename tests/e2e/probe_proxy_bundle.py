"""The hook's proxy, run in-process against the live engine: the served page
versions the bundle URL and the served bundle carries the rewritten Pane minimum.

Usage: probe_proxy_bundle.py [--port 35599]
Needs a running engine (reads the hook's state file like the gateway does).
Uses the hook's `_proxy` directly, mounted on a loopback aiohttp app, so no
dashboard session is needed.
"""

import asyncio
import os
import pathlib
import re
import sys
import time
import types

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
sys.modules.setdefault("floofy", types.ModuleType("floofy"))
import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402

import hook  # noqa: E402


class Log:
    def info(self, *a): print("[info]", a[0] % a[1:] if a[1:] else a[0])
    warning = info
    debug = info
    error = info


class Ctx:
    def __init__(self):
        self.config = {}
        self.log = Log()
        self.data_dir = pathlib.Path(os.path.expanduser("~/.kiro/crew/floofy/mods/kirocrew-ide/.floofy"))


async def main():
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 35599
    hook._ctx = Ctx()
    origin = hook._engine_origin()
    assert origin, "no engine running (state file empty)"
    print("engine", origin, "proxy base", hook.PROXY_BASE)
    app = web.Application()
    app.router.add_route("*", hook.PROXY_BASE + "{tail:.*}", hook._proxy)
    app.router.add_route("*", hook.PROXY_BASE, hook._proxy)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    ok = True
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("http://127.0.0.1:%d%s/?folder=/tmp" % (port, hook.PROXY_BASE)) as r:
                html = await r.text()
                print("page", r.status, len(html), "bytes")
            m = re.search(r'src="([^"]*' + re.escape(hook._WORKBENCH_JS_SUFFIX) + r'[^"]*)"', html)
            print("bundle src:", m and m.group(1))
            minimum = hook._pane_min_body()
            versioned = bool(m and ("?" + hook._PANE_MIN_QUERY + str(minimum)) in m.group(1))
            print("versioned with pane minimum:", versioned)
            ok &= versioned
            t0 = time.time()
            async with s.get("http://127.0.0.1:%d%s" % (port, m.group(1))) as r:
                js = await r.text()
                print("bundle", r.status, len(js), "bytes", r.headers.get("Content-Type"), r.headers.get("Cache-Control"), "%.2fs" % (time.time() - t0))
            rewritten = ("?200:%d," % minimum) in js and not hook._PANE_MIN_RE.search(js)
            print("bundle rewritten:", rewritten)
            ok &= rewritten
            t0 = time.time()
            async with s.get("http://127.0.0.1:%d%s" % (port, m.group(1))) as r:
                await r.read()
                print("second fetch (cache) %.2fs" % (time.time() - t0))
            # any other asset still streams through untouched
            async with s.get("http://127.0.0.1:%d%s" % (port, m.group(1).replace("workbench/workbench.js", "workbench/workbench.css").split("?")[0])) as r:
                css = await r.text()
                print("css", r.status, len(css), "bytes")
                ok &= r.status == 200 and len(css) > 1000
    finally:
        await runner.cleanup()
    print("ALL OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
