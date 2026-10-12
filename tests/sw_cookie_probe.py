"""Does a service-worker script fetch carry the dashboard session cookie?

Mirrors the KiroCrew multi-instance nesting exactly: a top-level dashboard on
port A embeds the remote dashboard (port B) in a sandboxed iframe whose URL
sets the ``mc_token_<B>`` cookie (HttpOnly, SameSite=Lax, path=/); inside
that, a same-origin iframe (the webview host page) registers a service
worker. Server B logs the Cookie header of every request, so the output shows
which request shapes the browser sends the cookie on.

Usage: uv run python tests/sw_cookie_probe.py [chromium|firefox]
"""
from __future__ import annotations

import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SEEN: list[tuple[str, str, bool]] = []

TOP = """<!doctype html><title>top</title>
<iframe id="remote" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
 src="http://localhost:%(b)d/?token=abc" style="width:600px;height:400px"></iframe>"""

DASH = """<!doctype html><title>dash</title>
<iframe id="pre" src="/pre/index.html?id=1" style="width:400px;height:200px"></iframe>"""

PRE = """<!doctype html><title>pre</title><script>
navigator.serviceWorker.register('service-worker.js?v=4&x=1', {scope: './'})
  .then(() => { document.title = 'sw-ok'; })
  .catch(e => { document.title = 'sw-fail:' + e.message; });
</script>"""

SW = "self.addEventListener('install', () => self.skipWaiting());"


class B(BaseHTTPRequestHandler):
    def log_message(self, *_):  # quiet
        pass

    def do_GET(self):
        cookie = self.headers.get("Cookie", "")
        SEEN.append((self.path, self.headers.get("Sec-Fetch-Dest", "?"), "mc_token_" in cookie))
        path = self.path.split("?")[0]
        if path == "/":
            body = DASH.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            if "token=" in self.path:
                self.send_header("Set-Cookie",
                                 "mc_token_%d=sess; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600" % PORT_B)
        elif path == "/pre/index.html":
            body, ctype = PRE.encode(), "text/html"
            self.send_response(200 if "mc_token_" in cookie else 403)
            self.send_header("Content-Type", ctype)
        elif path == "/pre/service-worker.js":
            if "mc_token_" in cookie:
                body, ctype = SW.encode(), "text/javascript"
                self.send_response(200)
            else:  # what the dashboard does: SPA shell, text/html
                body, ctype = b"<!doctype html>shell", "text/html"
                self.send_response(200)
            self.send_header("Content-Type", ctype)
        else:
            body = b"nf"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class A(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = (TOP % {"b": PORT_B}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(handler, port):
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


PORT_A, PORT_B = 48601, 48602


def main(browser_name: str) -> int:
    from playwright.sync_api import sync_playwright

    serve(A, PORT_A)
    serve(B, PORT_B)
    with sync_playwright() as pw:
        browser = getattr(pw, browser_name).launch()
        for label, url in (("top-level (browser tab)", "http://localhost:%d/?token=abc" % PORT_B),
                           ("nested in top-level port %d" % PORT_A, "http://localhost:%d/" % PORT_A)):
            SEEN.clear()
            ctx = browser.new_context()
            page = ctx.new_page()
            page.goto(url)
            pre = None
            for _ in range(40):
                pre = next((f for f in page.frames if f.url.endswith("/pre/index.html?id=1")), None)
                if pre and pre.title().startswith("sw-"):
                    break
                page.wait_for_timeout(250)
            print("== %s: pre title = %s" % (label, pre.title() if pre else "no frame"))
            for path, dest, has_cookie in SEEN:
                print("   %-30s dest=%-14s cookie=%s" % (path[:30], dest, has_cookie))
            ctx.close()
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "chromium"))
