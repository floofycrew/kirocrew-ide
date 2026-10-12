"""Headless check of the IDE layer and its host switching, in both realms a dashboard runs in.

No gateway involved. A stub server plays every part the layer and the App page need:

* ``/api/apps/floofycrew/spa/kirocrew-ide/*`` — the mod's spa files (this checkout's spa/),
                                 served where the FloofyCrew SPA host would import them;
* ``/apps/kirocrew-ide/ui/*``  — the App page's files (this checkout's app/ui/);
* ``/umd/*`` + ``/vendor/*``   — a real React 18 UMD build and ESM shims under the
                                 import-map names the App uses (the dashboard's own
                                 vendor stubs need the host bundle's module registry);
* ``/api/apps/floofycrew/mods/kirocrew-ide/api/*`` — a running IDE (``status`` with a
                                 ``host`` label, switchable to stopped) and a ``theme`` sink;
* ``/pane.html``               — a dashboard document: activates the layer with a stub
                                 ``ctx`` the way the SPA host does, and a router stand-in
                                 that mounts the App page on ``/apps/kirocrew-ide`` (the
                                 document starts there) and unmounts it elsewhere;
* ``/parent.html``             — the desktop window: embeds ``/pane.html`` in an
                                 <iframe>, answers ``mc-embedded-ready`` with an
                                 ``mc-host-model`` (plus the ack), records every
                                 ``mc-switch-instance`` it receives;
* ``/local.html``              — a local dashboard: the same, next to a stand-in of
                                 KiroCrew's ``crew-chip-row`` (re-rendered on demand).

Usage: probe_hosts.py [--node-modules <dir with React 18 umd builds>] [--shots <dir>]
Exit 0 when every assertion holds.
"""

from __future__ import annotations

import argparse
import http.server
import json
import mimetypes
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
MOD = HERE.parent.parent
API = "/api/apps/floofycrew/mods/kirocrew-ide/api/"
SPA = "/api/apps/floofycrew/spa/kirocrew-ide/"

# The dashboard's own /vendor/react.mjs stubs re-export the host bundle's module
# registry, which only exists inside the real SPA. The probe loads a real React
# 18 UMD build as classic scripts (they run before any module script) and serves
# ESM shims that re-export the globals under the import-map names the App uses.
IMPORT_MAP = (
    '<script src="/umd/react.js"></script><script src="/umd/react-dom.js"></script>'
    '<script type="importmap">{"imports":{"react":"/vendor/react.mjs","react-dom":"/vendor/react-dom.mjs","react-dom/client":"/vendor/react-dom-client.mjs"}}</script>'
)
REACT_SHIM = "const m = window.React; export default m; export const { useState, useEffect, useRef, useCallback, useMemo, createElement, Fragment } = m;\n"
REACT_DOM_SHIM = "const m = window.ReactDOM; export default m; export const { createPortal } = m;\n"
REACT_DOM_CLIENT_SHIM = "export const createRoot = window.ReactDOM.createRoot; export default { createRoot };\n"


def find_react_umd() -> pathlib.Path | None:
    """A local node_modules holding React 18 UMD builds (any project on the box will do)."""
    for root in (pathlib.Path.home() / "workplace", pathlib.Path.home()):
        for pkg in root.glob("*/src/*/node_modules/react-dom/umd/react-dom.development.js"):
            return pkg.parent.parent.parent
        for pkg in root.glob("*/node_modules/react-dom/umd/react-dom.development.js"):
            return pkg.parent.parent.parent
    return None


MOUNT = f"""
<script type="module">
  import React from "react";
  import {{ createRoot }} from "react-dom/client";
  import activate from "{SPA}layer.mjs";
  import App from "/apps/kirocrew-ide/ui/index.mjs";
  // The SPA host's ctx, reduced to what the layer reads.
  const ctx = {{ modId: "kirocrew-ide", log: console, surfaces: {{ get: (name) => name === "topbar" ? document.getElementById("topbar") : null }} }};
  window.__deactivate = activate(ctx);
  // A stand-in for the dashboard's router: the App page is mounted on /apps/kirocrew-ide
  // and unmounted elsewhere; a history push + popstate is how the real one is driven.
  const root = createRoot(document.getElementById("app"));
  const route = () => {{ if (location.pathname === "/apps/kirocrew-ide") root.render(React.createElement(App)); else root.render(null); }};
  window.__popstates = 0;
  window.addEventListener("popstate", () => {{ window.__popstates++; route(); }});
  window.__unmountApp = () => {{ history.pushState({{}}, "", "/sessions"); route(); }};
  history.replaceState({{}}, "", "/apps/kirocrew-ide");
  route();
  window.__mounted = true;
</script>
"""

# `#app` opens a stacking context, as the host's route container does: a z-index set inside
# the page competes within it and never reaches past a body-level fixed layer.
STYLE = "<style>body{margin:0;background:#111;color:#eee;font:13px system-ui}#topbar{height:36px;display:flex;align-items:center;padding:0 8px;background:#222;gap:8px}#app{position:relative;z-index:0}</style>"

PANE_HTML = f"""<!doctype html><html data-mode="dark"><head>{IMPORT_MAP}{STYLE}</head>
<body><div id="topbar">pane topbar</div><div id="app"></div>{MOUNT}</body></html>"""

# Mirrors upstream Switcher: the crew on screen is a LEADING chip beside the
# pinned row (`crew-chip-row`), then the dropdown trigger — all in one group.
CHIP_ROW = """<div role="group" aria-label="Instances" style="display:flex;gap:4px">
  <button aria-label="desk (dev-dsk-a) — connected" aria-current="true" class="tb-crew-active-chip">desk</button>
  <div data-testid="crew-chip-row" style="display:flex;gap:4px">
  <button aria-label="Local dashboard" title="Local dashboard">Local</button>
  <button aria-label="sandbox (sandbox) — connected" onclick="window.__clicked=(window.__clicked||[]).concat(['sandbox'])">sandbox</button>
  </div><button aria-label="Switch crew" aria-haspopup="menu">▾</button></div>"""

LOCAL_HTML = f"""<!doctype html><html data-mode="dark"><head>{IMPORT_MAP}{STYLE}</head>
<body>
<div id="topbar"><div id="bar-slot">{CHIP_ROW}</div></div>
<script>window.__rerenderBar = () => {{ document.getElementById("bar-slot").innerHTML = {json.dumps(CHIP_ROW)}; }};</script>
<div id="app"></div>{MOUNT}</body></html>"""

PARENT_HTML = """<!doctype html><html><head><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style></head>
<body><iframe id="pane" src="/pane.html"></iframe>
<script>
  window.__switches = []; window.__readyAsks = 0;
  const model = { type: "mc-host-model", v: 1, activeId: "crew-a", macInset: false, winInset: false, electron: true,
    tabs: [ { id: "crew-a", name: "desk", sshHost: "dev-dsk-a", state: "connected", unread: 0 },
            { id: "crew-b", name: "sandbox", sshHost: "sandbox", state: "connected", unread: 4 },
            { id: "crew-c", name: "lab", sshHost: "lab-host", state: "error", unread: 0 } ],
    self: { state: "connected" }, pinnedCrews: [], stableOrder: false, focusMode: false };
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    const pane = document.getElementById("pane").contentWindow;
    if (e.source !== pane) return;
    if (d.type === "mc-embedded-ready") { window.__readyAsks++; pane.postMessage(model, "*"); pane.postMessage({ type: "mc-embedded-ack", v: 1 }, "*"); }
    else if (d.type === "mc-switch-instance") window.__switches.push(d);
  });
</script></body></html>"""


class Engine:
    """The stub engine's state, flipped by the probe to exercise stop handling."""

    running = True
    workspaces = ["/tmp/demo"]
    idle = 15          # idleUnloadMinutes, as the hook reports it
    idle_posts = []    # what settings/idle-unload received
    # Spec-task progress as the hook reports it (`_spec_progress`): /tmp/demo has two specs, the others none.
    progress = {"/tmp/demo": {"total": 14, "done": 7, "inProgress": 1, "queued": 1, "optional": 2, "specs": [
        {"name": "alpha", "dir": ".kiro/specs/alpha", "tasks": ".kiro/specs/alpha/tasks.md", "total": 11, "done": 5, "inProgress": 1, "queued": 1, "optional": 2},
        {"name": "beta", "dir": ".kiro/specs/beta", "tasks": ".kiro/specs/beta/tasks.md", "total": 3, "done": 2, "inProgress": 0, "queued": 0, "optional": 0}]}}

    @classmethod
    def rows(cls):
        # One document per folder, like the real engine: same page, its own ?folder=.
        return [{"folder": f, "name": f.rsplit("/", 1)[-1], "embedUrl": "/workbench.html?folder=" + f, "progress": cls.progress.get(f)} for f in cls.workspaces]


def make_handler(node_modules: pathlib.Path):
    shims = {"react.mjs": REACT_SHIM, "react-dom.mjs": REACT_DOM_SHIM, "react-dom-client.mjs": REACT_DOM_CLIENT_SHIM}
    umd = {"react.js": node_modules / "react/umd/react.development.js", "react-dom.js": node_modules / "react-dom/umd/react-dom.development.js"}

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_):  # quiet
            pass

        def _send(self, body: bytes, ctype: str, status: int = 200):
            self.send_response(status)
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _file(self, path: pathlib.Path):
            if not path.is_file():
                return self._send(b"not found", "text/plain", 404)
            ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            if path.suffix in (".mjs", ".js"):
                ctype = "text/javascript"
            self._send(path.read_bytes(), ctype)

        def do_POST(self):  # theme sink and friends
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            p = self.path.split("?")[0]
            if p == "/__engine/stop":
                Engine.running = False
            if p == API + "workspaces/open":
                folder = (json.loads(raw or b"{}").get("folder") or "").rstrip("/")
                if not folder.startswith("/tmp/"):
                    return self._send(json.dumps({"error": "folder does not exist: " + folder}).encode(), "application/json", 400)
                if folder not in Engine.workspaces:
                    Engine.workspaces.append(folder)
                return self._send(json.dumps({"running": True, "workspaces": Engine.rows()}).encode(), "application/json")
            if p == API + "start":
                folder = (json.loads(raw or b"{}").get("folder") or "").rstrip("/")
                if Engine.running and folder and folder not in Engine.workspaces:
                    Engine.workspaces.append(folder)
                Engine.running = True
                return self._send(json.dumps({"running": True, "workspaces": Engine.rows(), "note": "already running"}).encode(), "application/json")
            if p == API + "workspaces/close":
                folder = json.loads(raw or b"{}").get("folder")
                Engine.workspaces = [f for f in Engine.workspaces if f != folder]
                return self._send(json.dumps({"running": True, "workspaces": Engine.rows()}).encode(), "application/json")
            if p == API + "settings/idle-unload":
                minutes = int(json.loads(raw or b"{}").get("minutes"))
                Engine.idle = minutes
                Engine.idle_posts.append(minutes)
                return self._send(json.dumps({"idleUnloadMinutes": minutes}).encode(), "application/json")
            self._send(b"{}", "application/json")

        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/pane.html":
                return self._send(PANE_HTML.encode(), "text/html")
            if p == "/parent.html":
                return self._send(PARENT_HTML.encode(), "text/html")
            if p == "/local.html":
                return self._send(LOCAL_HTML.encode(), "text/html")
            if p == "/workbench.html":
                # Like the real engine: the theme variables live on `.monaco-workbench`, NOT on <body>; the title
                # bar's right part spans 20% of the width with its toolbar pushed to the far end (margin-left: auto).
                return self._send(b"<!doctype html><html><body style='background:#1e1e1e;color:#ccc'><style>.monaco-workbench{--vscode-titleBar-activeBackground:#2b2b2b;--vscode-commandCenter-background:#3a3a3a;--vscode-commandCenter-foreground:#ddd;--vscode-menu-background:#303030;--vscode-menu-foreground:#f0f0f0;--vscode-menu-selectionBackground:#04395e;--vscode-charts-green:#89d185;--vscode-charts-blue:#3794ff}</style><div class='monaco-workbench' style='position:relative;height:100vh'>workbench stand-in <span id=w>1</span><div class='part titlebar'><div class='titlebar-center' style='position:absolute;top:0;left:40%;width:30%;height:22px'><span style='display:inline-block;width:40px;height:22px'>&larr; &rarr;</span></div><div class='titlebar-right' style='position:absolute;top:0;right:0;width:20%;height:35px;display:flex;align-items:center'><div class='action-toolbar-container' style='margin-left:auto;width:112px;height:22px;margin-right:8px;background:#444'>&#9638; &#9707; &#9639; &#9704;</div></div></div></div></body></html>", "text/html")
            if p.startswith("/apps/kirocrew-ide/ui/"):
                return self._file(MOD / "app" / "ui" / p[len("/apps/kirocrew-ide/ui/"):])
            if p.startswith(SPA):
                return self._file(MOD / "spa" / p[len(SPA):])
            if p.startswith("/vendor/") and p[len("/vendor/"):] in shims:
                return self._send(shims[p[len("/vendor/"):]].encode(), "text/javascript")
            if p.startswith("/umd/") and p[len("/umd/"):] in umd:
                return self._file(umd[p[len("/umd/"):]])
            if p == API + "browse":
                return self._send(json.dumps({"path": "/tmp", "parent": "/", "entries": [{"name": "demo", "path": "/tmp/demo", "hidden": False}, {"name": "other", "path": "/tmp/other", "hidden": False}, {"name": ".cache", "path": "/tmp/.cache", "hidden": True}],
                                              "truncated": False, "suggestions": ["/tmp/recent", "/tmp/demo"]}).encode(), "application/json")
            if p == API + "status":
                if Engine.running:
                    body = {"running": True, "engine": "stand-in", "host": "dev-dsk-a", "embedUrl": Engine.rows()[0]["embedUrl"] if Engine.rows() else "/workbench.html",
                            "workspaces": Engine.rows(), "idleUnloadMinutes": Engine.idle,
                            "server": {"engine": "stand-in", "port": 1, "folder": Engine.workspaces[0] if Engine.workspaces else None}, "proxy": {"inUse": True, "base": "/kirocrew-ide/"}}
                else:
                    body = {"running": False, "engine": "stand-in", "host": "dev-dsk-a", "server": None, "embedUrl": None, "proxy": {"inUse": False}}
                return self._send(json.dumps(body).encode(), "application/json")
            if p.startswith(API):
                return self._send(b"{}", "application/json")
            return self._send(b"not found", "text/plain", 404)

    return Handler


LAYER = '[data-testid="kirocrew-ide-layer"]'
TRIGGER = '[data-testid="kirocrew-ide-hosts-trigger"]'
MENU = '[data-testid="kirocrew-ide-hosts-menu"]'
ROWS = MENU + ' [role=menuitemradio]'
TAG = '[data-testid="kirocrew-ide-tag"]'
BACK = '[data-testid="kirocrew-ide-back"]'
EXIT = '[data-testid="kirocrew-ide-exit"]'  # must NOT exist: ◁ KiroCrew is the single exit
API_EXIT = "() => window.__kirocrewIde.exitFullscreen()"
CHIP = '[data-testid="kirocrew-ide-chip"]'
DOCK = '[data-testid="kirocrew-ide-dock"]'
EXPAND = '[data-testid="kirocrew-ide-expand"]'
FRAME = 'iframe[title^="KiroCrew IDE"][data-active="true"]'
ANY_FRAME = 'iframe[title^="KiroCrew IDE"]'
WS_MENU = '[data-testid="kirocrew-ide-workspaces-menu"]'
WS_ROWS = WS_MENU + ' [data-kind="workspace"]'
OPEN_FOLDER = '[data-testid="kirocrew-ide-open-folder"]'
OPENER = '[data-testid="kirocrew-ide-opener"]'
STRIP = '[data-testid="kirocrew-ide-workspace-strip"]'

# The layer sits exactly over the App page's dock box (fixed, following its rectangle), not fullscreen.
DOCKED = f"""() => {{
  const l = document.querySelector('{LAYER}'); const d = document.querySelector('{DOCK}');
  if (!l || !d || l.dataset.mode !== 'docked' || getComputedStyle(l).display === 'none') return false;
  const a = l.getBoundingClientRect(), b = d.getBoundingClientRect();
  return Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1 && b.height > 100;
}}"""

# The bar's tag is the "IDE" segment joined flush to the host trigger: `[host ▾]IDE]`.
BAR_JOINED = f"""() => {{
  const t = document.querySelector('{TRIGGER}'); const g = document.querySelector('{TAG}');
  return !!t && !!g && g.textContent.trim().startsWith('IDE') && g.dataset.sub === 'true' && g.getAttribute('aria-current') === 'true'
    && getComputedStyle(g).borderTopLeftRadius === '0px' && getComputedStyle(t).borderTopRightRadius === '0px'
    && Math.abs(g.getBoundingClientRect().left - t.getBoundingClientRect().right) < 1;
}}"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--node-modules", default=None, help="a node_modules dir holding react/umd and react-dom/umd (React 18)")
    ap.add_argument("--shots", default=str(pathlib.Path.home() / ".pt"))
    args = ap.parse_args()
    node_modules = pathlib.Path(args.node_modules) if args.node_modules else find_react_umd()
    if not node_modules:
        print("no local React 18 UMD build found; pass --node-modules")
        return 2
    shots = pathlib.Path(args.shots)

    server = socketserver.TCPServer(("127.0.0.1", 0), make_handler(node_modules))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    failures: list[str] = []

    def check(cond, msg):
        (failures.append(msg) if not cond else None)
        print(("ok   " if cond else "FAIL ") + msg)

    def rows_of(frame):
        return frame.eval_on_selector_all(ROWS, "els => els.map(e => [e.dataset.kind, e.textContent, e.getAttribute('aria-checked')])")

    def menu_open(frame):
        return frame.evaluate(f"() => {{ const m = document.querySelector('{MENU}'); return !!m && !m.hidden; }}")

    def open_menu(frame):
        if not menu_open(frame):
            frame.click(TRIGGER)
            frame.wait_for_selector(ROWS)

    def mode(frame):
        return frame.evaluate(f"() => {{ const l = document.querySelector('{LAYER}'); return l ? l.dataset.mode || 'hidden' : 'hidden'; }}")

    def shown(frame):
        return frame.evaluate(f"() => {{ const l = document.querySelector('{LAYER}'); return !!l && l.dataset.mode === 'fullscreen' && getComputedStyle(l).display !== 'none'; }}")

    def wait_mode(frame, want):
        frame.wait_for_function(f"() => {{ const l = document.querySelector('{LAYER}'); return (l ? l.dataset.mode || 'hidden' : 'hidden') === '{want}'; }}", timeout=10000)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1200, "height": 760})
        errors: list[str] = []

        # --- embedded pane under a desktop-window stand-in ---
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(base + "/parent.html", wait_until="domcontentloaded")
        page.wait_for_selector("#pane")
        pane = page.query_selector("#pane").content_frame()
        pane.wait_for_selector(DOCK, timeout=20000)
        # The App page is open and the engine runs: the IDE docks into the page, no click needed.
        wait_mode(pane, "docked")
        pane.wait_for_function(DOCKED, timeout=10000)
        check(pane.evaluate(DOCKED), "embedded: on the App page the layer is docked exactly over the page's dock box")
        check(pane.query_selector(FRAME) is not None, "embedded: docking creates the one workbench frame")
        check(pane.evaluate("() => document.body.style.overflow !== 'hidden'"), "embedded: docked does not lock the page scroll")
        frame_id = pane.evaluate(f"() => {{ const f = document.querySelector('{FRAME}'); f.__mark = Math.random(); return f.__mark; }}")
        # No crew-chip-row in the pane stand-in: the chip falls back to the topbar surface.
        pane.wait_for_selector(CHIP, timeout=10000)
        check(pane.evaluate(f"() => document.querySelector('{CHIP}').closest('#topbar') !== null"), "embedded: with no crew bar the chip lands in the topbar surface")
        check("dev-dsk-a IDE" in (pane.text_content(CHIP) or ""), "embedded: the chip reads '<host> IDE' from the status route")
        check(pane.get_attribute(CHIP, "aria-current") == "false", "embedded: the chip is not lit while merely docked")
        # The page's dock box shrinks (a layout shift): the layer follows.
        pane.evaluate(f"() => {{ document.querySelector('{DOCK}').style.maxHeight = '300px'; }}")
        pane.wait_for_function(DOCKED, timeout=5000)
        # 300px content + the box's padding and border; DOCKED above already proved the layer matches the box.
        check(pane.evaluate(f"() => document.querySelector('{LAYER}').getBoundingClientRect().height") < 400, "embedded: the docked layer follows the box's new size")
        pane.evaluate(f"() => {{ document.querySelector('{DOCK}').style.maxHeight = ''; }}")
        # Fullscreen from the page.
        pane.click(EXPAND)
        wait_mode(pane, "fullscreen")
        check(shown(pane), "embedded: Fullscreen raises the layer over the dashboard")
        check(pane.evaluate(f"() => document.querySelector('{FRAME}').__mark") == frame_id, "embedded: fullscreen reuses the docked frame (no reload)")
        check(pane.evaluate("() => document.body.style.overflow === 'hidden'"), "embedded: fullscreen locks the page scroll")
        check(pane.is_disabled(EXPAND), "embedded: the page's Fullscreen button is disabled while fullscreen")
        pane.wait_for_function(f"() => (document.querySelector('{TRIGGER}').textContent || '').includes('desk')", timeout=10000)
        check(page.evaluate("window.__readyAsks") >= 1, "embedded: the layer asked the parent for the model with mc-embedded-ready")
        check(pane.evaluate(BAR_JOINED), "embedded: the bar's tag is the lit 'IDE' sub-tag joined flush to the host trigger ([host ▾]IDE])")
        check("dev-dsk-a IDE" in (pane.get_attribute(TAG, "aria-label") or ""), "embedded: the sub-tag still names the host for assistive tech")
        check(not menu_open(pane), "embedded: the host menu starts closed")
        bar_right = pane.evaluate("() => { const r = document.querySelector('#kirocrew-ide-layer .kide-bar').getBoundingClientRect(); const kids = [...document.querySelectorAll('#kirocrew-ide-layer .kide-bar > *')]; return Math.max(...kids.map(k => k.getBoundingClientRect().right)); }")
        check(bar_right < 520, f"embedded: the closed bar stays clear of the command centre (right edge {bar_right}px of 1200)")
        open_menu(pane)
        rows = rows_of(pane)
        check([r[0] for r in rows] == ["crew", "here", "crew", "crew"], f"embedded: menu = Local, desk (here), sandbox, lab ({[r[0] for r in rows]})")
        check(rows[1][2] == "true" and "you are here" in rows[1][1], "embedded: the current host's row is checked and marked 'you are here'")
        check(pane.evaluate(f"() => !!document.querySelector('{ROWS}[data-kind=here] .kide-here-mark')"), "embedded: the current host's row carries the home mark")
        check(pane.evaluate(f"() => getComputedStyle(document.querySelector('{ROWS}[data-kind=here]')).borderLeftWidth") == "2px", "embedded: the current host's row has the accent rule other rows lack")
        check(any("4" in r[1] and "sandbox" in r[1] for r in rows), "embedded: unread badge rendered for sandbox")
        check(any("error" in r[1] and "lab" in r[1] for r in rows), "embedded: non-ok state word shown for lab")
        menu_bg = pane.evaluate(f"() => getComputedStyle(document.querySelector('{MENU}')).backgroundColor")
        check(pane.get_attribute(CHIP, "aria-current") == "true", "embedded: the topbar chip is lit while the layer is up")
        pane.wait_for_function("() => document.querySelector('[data-testid=kirocrew-ide-layer]').dataset.ready === 'true'", timeout=30000)
        pane.wait_for_timeout(1500)  # let the theme poll read the stand-in's variables
        themed_bg = pane.evaluate(f"() => getComputedStyle(document.querySelector('{MENU}')).backgroundColor")
        check(themed_bg == "rgb(48, 48, 48)" and themed_bg != menu_bg, f"embedded: the menu takes the workbench's menu colour once read ({menu_bg} -> {themed_bg})")
        page.screenshot(path=str(shots / "layer-embedded.png"))
        # Switching crews posts the pane protocol, closes the menu, leaves the layer up.
        pane.click(ROWS + ':has-text("sandbox")')
        page.wait_for_function("() => window.__switches.length === 1")
        check(page.evaluate("window.__switches[0]") == {"type": "mc-switch-instance", "v": 1, "id": "crew-b"}, "embedded: picking sandbox posts mc-switch-instance crew-b")
        check(not menu_open(pane), "embedded: the menu closes after a pick")
        check(shown(pane), "embedded: the layer stays up after switching crews")
        open_menu(pane)
        pane.click(ROWS + ':has-text("Local")')
        page.wait_for_function("() => window.__switches.length === 2")
        check(page.evaluate("window.__switches[1].id") is None, "embedded: picking Local posts id null")
        # Escape with the menu open closes the menu, not the layer.
        open_menu(pane)
        pane.press("body", "Escape")
        pane.wait_for_timeout(150)
        check(not menu_open(pane) and shown(pane), "embedded: Escape closes the menu first and leaves the layer")
        # The 'here' row leaves fullscreen; with the App page open that lands on its dock, not off screen.
        open_menu(pane)
        pane.click(ROWS + '[data-kind="here"]')
        wait_mode(pane, "docked")
        check(pane.evaluate(DOCKED), "embedded: the 'here' row returns the IDE to the page's dock while the App page is open")
        check(pane.evaluate(f"() => document.querySelector('{FRAME}').__mark") == frame_id, "embedded: the SAME frame is docked again (no reload)")
        check(pane.get_attribute(CHIP, "aria-current") == "false", "embedded: the topbar chip unlights when not fullscreen")
        pane.click(CHIP)
        wait_mode(pane, "fullscreen")
        check(shown(pane), "embedded: the topbar chip raises fullscreen again")
        pane.press("body", "Escape")
        wait_mode(pane, "docked")
        check(pane.evaluate(DOCKED), "embedded: Escape leaves fullscreen back onto the dock")
        # No separate "Exit fullscreen" button: ◁ KiroCrew is the one way out and lands on the dock while the page is open.
        pane.click(EXPAND)
        wait_mode(pane, "fullscreen")
        check(pane.query_selector(EXIT) is None, "embedded: the bar has no 'Exit fullscreen' button")
        pane.click(BACK)
        wait_mode(pane, "docked")
        check(pane.evaluate(DOCKED), "embedded: ◁ KiroCrew returns the IDE to the App page's dock")
        # Leave the App page (the dashboard routes elsewhere): the dock is gone, the IDE goes off screen but stays mounted.
        pane.evaluate("() => window.__unmountApp()")
        wait_mode(pane, "hidden")
        check(pane.query_selector(DOCK) is None and pane.query_selector(FRAME) is not None, "embedded: leaving the App page hides the layer and keeps the workbench frame mounted")
        pane.click(CHIP)
        wait_mode(pane, "fullscreen")
        check(pane.evaluate(f"() => document.querySelector('{FRAME}').__mark") == frame_id, "embedded: from another route the chip re-shows the SAME frame (no reload)")
        # API exitFullscreen() with no App page open: the layer navigates the dashboard to /apps/kirocrew-ide and the page docks it on mount.
        pane.evaluate(API_EXIT)
        pane.wait_for_function("() => location.pathname === '/apps/kirocrew-ide'", timeout=5000)
        check(pane.evaluate("() => window.__popstates") == 1, "embedded: exitFullscreen() off the App page pushes the app route and fires popstate for the SPA router")
        pane.wait_for_selector(DOCK, timeout=10000)
        wait_mode(pane, "docked")
        check(pane.evaluate(DOCKED) and pane.evaluate(f"() => document.querySelector('{FRAME}').__mark") == frame_id, "embedded: the remounted App page docks the SAME frame")
        # Escape while docked is not a close.
        pane.press("body", "Escape")
        pane.wait_for_timeout(150)
        check(mode(pane) == "docked", "embedded: Escape does nothing while docked")

        # --- workspaces: several folders on the one engine, each its own warm document ---
        def ws_rows(frame):
            return frame.eval_on_selector_all(WS_ROWS, "els => els.map(e => [e.dataset.folder, e.getAttribute('aria-checked')])")

        def frames(frame):
            return frame.eval_on_selector_all(ANY_FRAME, "els => els.map(e => [e.dataset.folder, e.dataset.active, e.__mark || null])")

        pane.click(EXPAND)
        wait_mode(pane, "fullscreen")
        def tag_text(frame):
            return frame.evaluate(f"() => (document.querySelector('{TAG}').textContent || '').replace(/\\s+/g, '')")

        check("IDE·demo" in tag_text(pane), f"ws: the tag names the active workspace ('IDE · demo'; got {tag_text(pane)!r})")
        check(pane.get_attribute(TAG, "aria-haspopup") == "menu" and pane.evaluate(f"() => document.querySelector('{WS_MENU}').hidden"), "ws: the tag is a dropdown trigger, closed at first")
        pane.click(TAG)
        pane.wait_for_selector(WS_ROWS)
        check(ws_rows(pane) == [["/tmp/demo", "true"]], f"ws: the menu lists the open workspace, checked ({ws_rows(pane)})")
        check(pane.query_selector(OPEN_FOLDER) is not None, "ws: the menu ends with 'Open a folder…'")
        check(not menu_open(pane), "ws: opening the workspace menu keeps the host menu closed")
        pane.click(OPEN_FOLDER)
        pane.wait_for_selector(OPENER + " input")
        pane.wait_for_selector(OPENER + ' [data-dir="/tmp/recent"]', timeout=5000)
        check(pane.evaluate(f"() => document.activeElement === document.querySelector('{OPENER} input')"), "ws: the opener's path box takes focus")
        check(pane.evaluate(f"() => [...document.querySelectorAll('{OPENER} .kide-head')].map(e => e.textContent)") == ["Recent", "/tmp"], "ws: recents first, then the browsed directory")
        recent_dirs = pane.evaluate(f"() => {{ const kids = [...document.querySelector('{OPENER} .kide-dirs').children]; const second = kids.findIndex((k, i) => i > 0 && k.classList.contains('kide-head')); return kids.slice(1, second).map(k => k.dataset.dir); }}")
        check(recent_dirs == ["/tmp/recent"], f"ws: an already-open folder is not offered under Recent ({recent_dirs})")
        check(pane.evaluate(f"() => !document.querySelector('{OPENER} [data-dir=\"/tmp/.cache\"]')"), "ws: dot-directories stay hidden until typed")
        page.screenshot(path=str(shots / "layer-workspaces-menu.png"))
        # Typing survives the status poll's re-render (the box is patched, not rebuilt).
        pane.type(OPENER + " input", "/tmp/oth")
        pane.evaluate("() => window.__kirocrewIde.refresh()")
        pane.wait_for_timeout(300)
        check(pane.input_value(OPENER + " input") == "/tmp/oth" and pane.evaluate(f"() => document.activeElement === document.querySelector('{OPENER} input')"), "ws: a refresh while typing keeps the text and the caret")
        pane.fill(OPENER + " input", "")
        pane.click(OPENER + ' [data-dir="/tmp/recent"]')
        pane.wait_for_function(f"() => document.querySelectorAll('{ANY_FRAME}').length === 2", timeout=10000)
        pane.wait_for_function(f"() => document.querySelector('{WS_MENU}').hidden", timeout=5000)
        fr = frames(pane)
        check([f[0] for f in fr] == ["/tmp/demo", "/tmp/recent"] and [f[1] for f in fr] == ["false", "true"], f"ws: opening a recent folder adds a second document and shows it ({fr})")
        check(fr[0][2] == frame_id, "ws: the first document is untouched (same frame, no reload)")
        check(pane.evaluate(f"() => getComputedStyle(document.querySelectorAll('{ANY_FRAME}')[0]).display === 'none'") and pane.evaluate(f"() => getComputedStyle(document.querySelector('{FRAME}')).display !== 'none'"), "ws: only the active document is displayed, the other stays mounted")
        check("IDE·recent" in tag_text(pane) and pane.evaluate(f"() => document.querySelector('{TAG} .kide-count').textContent") == "2", f"ws: the tag names the new workspace and counts 2 ({tag_text(pane)!r})")
        check(pane.evaluate(f"() => document.querySelector('{FRAME}').src.includes('folder=/tmp/recent')"), "ws: the new document opened its own ?folder=")
        page.screenshot(path=str(shots / "layer-workspaces.png"))
        # Switch back by row: the first frame returns, still the same object.
        pane.click(TAG)
        pane.wait_for_selector(WS_ROWS)
        check(ws_rows(pane) == [["/tmp/demo", "false"], ["/tmp/recent", "true"]], f"ws: both rows, the active one checked ({ws_rows(pane)})")
        pane.click(WS_ROWS + '[data-folder="/tmp/demo"]')
        pane.wait_for_function(f"() => document.querySelector('{FRAME}').dataset.folder === '/tmp/demo'", timeout=5000)
        check(pane.evaluate(f"() => document.querySelector('{FRAME}').__mark") == frame_id, "ws: switching back shows the original frame, not a reload")
        check(pane.evaluate(f"() => document.querySelectorAll('{ANY_FRAME}').length") == 2, "ws: switching keeps both documents warm")

        # --- spec-task progress: a tiny donut + % at the title bar's top right, per workspace, with a breakdown ---
        api = "window.__kirocrewIde"
        PROG = '[data-testid="kirocrew-ide-progress"]'
        PROG_BTN = '[data-testid="kirocrew-ide-progress-trigger"]'
        PROG_MENU = '[data-testid="kirocrew-ide-progress-menu"]'
        pane.wait_for_function(f"() => {{ const w = document.querySelector('{PROG}'); return w && !w.hidden && w.dataset.folder === '/tmp/demo'; }}", timeout=5000)
        ind = pane.evaluate(f"""() => {{
          const w = document.querySelector('{PROG}'), b = document.querySelector('{PROG_BTN}');
          const svg = b.querySelector('svg.kide-donut');
          return {{ pct: w.dataset.pct, text: b.textContent.trim(), svgPct: svg && svg.dataset.pct, done: !!b.querySelector('.kide-donut-done'), active: !!b.querySelector('.kide-donut-active'),
                    doneColour: svg && getComputedStyle(b.querySelector('.kide-donut-done')).stroke, state: {api}.state().progress && {api}.state().progress.pct, title: b.title }};
        }}""")
        check(ind["pct"] == "50" and ind["text"] == "50%" and ind["svgPct"] == "50" and ind["done"] and ind["active"], f"progress: the indicator shows the workspace's combined completeness as a donut + % ({ind})")
        check(ind["state"] == 50 and "alpha: 5/11 (45%)" in ind["title"] and "beta: 2/3 (67%)" in ind["title"], f"progress: the state and tooltip carry the per-spec breakdown ({ind['title']!r})")
        pane.wait_for_function(f"() => parseInt(document.querySelector('{PROG}').style.right) < 150", timeout=5000)
        pane.wait_for_function(f"() => getComputedStyle(document.querySelector('{PROG_BTN} .kide-donut-done')).stroke === 'rgb(137, 209, 133)'", timeout=5000)
        check(True, "progress: the done arc takes the workbench theme's chart green")
        place = pane.evaluate(f"""() => {{
          const w = document.querySelector('{PROG}').getBoundingClientRect();
          const bar = document.querySelector('#kirocrew-ide-layer .kide-bar').getBoundingClientRect();
          const fd = document.querySelector('{FRAME}').contentDocument;
          const part = fd.querySelector('.titlebar-right').getBoundingClientRect();
          const tool = fd.querySelector('.action-toolbar-container').getBoundingClientRect();
          return {{ right: Math.round(w.right), toolLeft: Math.round(tool.left), partLeft: Math.round(part.left), barRight: Math.round(bar.right), left: Math.round(w.left), top: Math.round(w.top), bottom: Math.round(w.bottom), style: document.querySelector('{PROG}').style.right }};
        }}""")
        check(place["right"] <= place["toolLeft"] - 4 and place["right"] > place["partLeft"], f"progress: the indicator ends just left of the workbench's layout controls (its toolbar, not the 20% part) ({place})")
        check(place["left"] > place["barRight"] + 8 and place["top"] >= 4 and place["bottom"] <= 35, f"progress: it sits in the title bar clear of the layer's own bar ({place})")
        # Click: the breakdown, right-aligned under the indicator; one row per spec; Escape closes it.
        pane.click(PROG_BTN)
        pane.wait_for_selector(PROG_MENU + ' [data-testid="kirocrew-ide-progress-spec"]')
        brk = pane.evaluate(f"""() => {{
          const m = document.querySelector('{PROG_MENU}'), w = document.querySelector('{PROG}');
          const head = m.querySelector('[data-testid="kirocrew-ide-progress-head"]');
          const rows = [...m.querySelectorAll('[data-testid="kirocrew-ide-progress-spec"]')].map(r => [r.dataset.spec, r.querySelector('.kide-nums').textContent, r.querySelector('.kide-pct').textContent, r.querySelector('svg.kide-donut').dataset.pct, (r.querySelector('.kide-detail') || {{}}).textContent || '']);
          const mr = m.getBoundingClientRect(), wr = w.getBoundingClientRect();
          return {{ hidden: m.hidden, head: head.textContent, rows, expanded: document.querySelector('{PROG_BTN}').getAttribute('aria-expanded'),
                    aligned: Math.abs(mr.right - wr.right) < 2 && mr.top >= wr.bottom, inView: mr.right <= window.innerWidth && mr.left >= 0, foot: (m.querySelector('.kide-prog-foot') || {{}}).textContent || '' }};
        }}""")
        check(not brk["hidden"] and brk["expanded"] == "true" and "50% complete" in brk["head"] and "7/14 tasks across 2 specs" in brk["head"] and "1 running" in brk["head"] and "1 queued" in brk["head"] and "/tmp/demo" in brk["head"], f"progress: the breakdown's head gives the combined figure ({brk['head']!r})")
        check(brk["rows"] == [["alpha", "5/11", "45%", "45", "1 running · 1 queued · 2 optional"], ["beta", "2/3", "67%", "67", ""]], f"progress: one row per spec directory with its own donut and counts ({brk['rows']})")
        check(brk["aligned"] and brk["inView"] and "tasks.md" in brk["foot"], f"progress: the popover hangs right-aligned under the indicator, inside the viewport ({brk})")
        page.screenshot(path=str(shots / "layer-progress-menu.png"))
        pane.press("body", "Escape")
        pane.wait_for_function(f"() => document.querySelector('{PROG_MENU}').hidden", timeout=5000)
        check(shown(pane), "progress: Escape closes the breakdown first and leaves the layer up")
        # One popover at a time: the workspace menu closes it; its rows carry each workspace's own donut.
        pane.click(PROG_BTN)
        pane.wait_for_function(f"() => !document.querySelector('{PROG_MENU}').hidden", timeout=5000)
        pane.click(TAG)
        pane.wait_for_selector(WS_ROWS)
        check(pane.evaluate(f"() => document.querySelector('{PROG_MENU}').hidden && document.querySelector('{PROG_BTN}').getAttribute('aria-expanded') === 'false'"), "progress: opening the workspace menu closes the breakdown")
        minis = pane.evaluate(f"() => [...document.querySelectorAll('{WS_ROWS}')].map(r => [r.dataset.folder, r.querySelector('[data-testid=\"kirocrew-ide-ws-progress\"]') ? r.querySelector('[data-testid=\"kirocrew-ide-ws-progress\"]').textContent : null])")
        check(minis == [["/tmp/demo", "50%"], ["/tmp/recent", None]], f"progress: workspace rows show their own donut + %, none for a folder without specs ({minis})")
        # The workspace on screen decides: switching to one without spec tasks hides the indicator.
        pane.click(WS_ROWS + '[data-folder="/tmp/recent"]')
        pane.wait_for_function(f"() => document.querySelector('{FRAME}').dataset.folder === '/tmp/recent'", timeout=5000)
        pane.wait_for_function(f"() => document.querySelector('{PROG}').hidden", timeout=5000)
        check(pane.evaluate(f"() => {api}.state().progress") is None, "progress: a workspace without spec tasks shows no indicator")
        pane.evaluate(f"() => {api}.activate('/tmp/demo')")
        pane.wait_for_function(f"() => document.querySelector('{FRAME}').dataset.folder === '/tmp/demo' && !document.querySelector('{PROG}').hidden", timeout=5000)
        check(True, "progress: it is back with the workspace that has them")

        # --- idle unloading: the off-screen document is dropped after the host's limit, the workspace stays ---
        api = "window.__kirocrewIde"
        check(pane.evaluate(f"() => {api}.state().idleUnloadMinutes") == 15, "idle: the limit comes from status")
        check(pane.evaluate(f"() => {api}.sleepIdle(Date.now() + 14 * 60000)") == [], "idle: nothing sleeps before the limit")
        dropped = pane.evaluate(f"() => {api}.sleepIdle(Date.now() + 16 * 60000)")
        check(dropped == ["/tmp/recent"], f"idle: past the limit the off-screen document is dropped, the active one is not ({dropped})")
        check(frames(pane) == [["/tmp/demo", "true", frame_id]], f"idle: only the active document remains, untouched ({frames(pane)})")
        check(pane.evaluate(f"() => {api}.state().asleep") == ["/tmp/recent"], "idle: the state names the asleep workspace")
        check(pane.evaluate(f"() => {api}.workspaces().map(r => r.folder)") == ["/tmp/demo", "/tmp/recent"], "idle: the workspace itself stays open (engine list untouched)")
        pane.click(TAG)
        pane.wait_for_selector(WS_ROWS)
        check(pane.evaluate(f"() => {{ const r = document.querySelector('{WS_ROWS}[data-folder=\"/tmp/recent\"]'); return [r.dataset.asleep, r.querySelector('.kide-word') && r.querySelector('.kide-word').textContent]; }}") == ["true", "asleep"], "idle: the menu row reads 'asleep'")
        idle_ctl = pane.query_selector('[data-testid="kirocrew-ide-idle-control"] select')
        check(idle_ctl is not None and idle_ctl.input_value() == "15", "idle: the menu footer shows the limit")
        page.screenshot(path=str(shots / "layer-workspaces-asleep.png"))
        pane.click(WS_ROWS + '[data-folder="/tmp/recent"]')
        pane.wait_for_function(f"() => document.querySelector('{FRAME}') && document.querySelector('{FRAME}').dataset.folder === '/tmp/recent'", timeout=5000)
        check(len(frames(pane)) == 2 and pane.evaluate(f"() => {api}.state().asleep") == [], "idle: switching to an asleep workspace recreates its document and wakes it")
        # "never" through the footer select: posted to the host, then nothing sleeps however long.
        pane.click(TAG)
        pane.wait_for_selector('[data-testid="kirocrew-ide-idle-control"] select')
        pane.select_option('[data-testid="kirocrew-ide-idle-control"] select', "0")
        pane.wait_for_function(f"() => {api}.state().idleUnloadMinutes === 0", timeout=5000)
        check(Engine.idle_posts == [0], f"idle: the select writes the host setting ({Engine.idle_posts})")
        check(pane.evaluate(f"() => {api}.sleepIdle(Date.now() + 10 * 3600000)") == [], "idle: 'never' keeps every document warm")
        pane.select_option('[data-testid="kirocrew-ide-idle-control"] select', "15")
        pane.wait_for_function(f"() => {api}.state().idleUnloadMinutes === 15", timeout=5000)
        pane.press("body", "Escape")
        pane.wait_for_timeout(150)
        # Back to the pre-idle picture: demo active, recent warm.
        pane.evaluate(f"() => {api}.activate('/tmp/demo')")
        pane.wait_for_function(f"() => document.querySelector('{FRAME}').dataset.folder === '/tmp/demo'", timeout=5000)

        # --- the bar stays clear of the workbench's title-bar centre; a long folder name fades and scrolls ---
        fit = pane.evaluate(f"""() => {{
          const bar = document.querySelector('#kirocrew-ide-layer .kide-bar');
          const b = bar.getBoundingClientRect();
          const w = window.innerWidth;
          return {{ right: bar.style.right, barRight: Math.round(b.right), centre: Math.round(w * 0.40), width: w }};
        }}""")
        check(fit["right"] and fit["barRight"] <= fit["centre"], f"fit: the bar ends before the workbench's centre part ({fit})")
        long_name = "/tmp/a-very-long-workspace-folder-name-that-cannot-fit-in-the-title-bar-at-all"
        pane.evaluate(f"(f) => {api}.open(f)", long_name)
        pane.wait_for_function(f"() => document.querySelector('{FRAME}') && document.querySelector('{FRAME}').dataset.folder === {json.dumps(long_name)}", timeout=10000)
        pane.wait_for_function("() => document.querySelector('#kirocrew-ide-layer .kide-ws-name').dataset.clipped === 'end'", timeout=5000)
        clip = pane.evaluate(f"""() => {{
          const name = document.querySelector('#kirocrew-ide-layer .kide-ws-name');
          const bar = document.querySelector('#kirocrew-ide-layer .kide-bar').getBoundingClientRect();
          return {{ clipped: name.dataset.clipped, over: name.scrollWidth - name.clientWidth, barRight: Math.round(bar.right), centre: Math.round(window.innerWidth * 0.40),
                    mask: getComputedStyle(name).maskImage || getComputedStyle(name).webkitMaskImage, scrollbar: getComputedStyle(name).scrollbarWidth }};
        }}""")
        check(clip["over"] > 20 and clip["barRight"] <= clip["centre"], f"fit: the long name is the piece that shrinks; the bar still ends before the centre ({clip})")
        check("gradient" in (clip["mask"] or ""), f"fit: the cut edge is faded, not ellipsised ({clip['mask']})")
        host_name = pane.evaluate("() => { const n = document.querySelector('#kirocrew-ide-layer .kide-trigger .kide-name'); return [n.textContent, n.scrollWidth - n.clientWidth]; }")
        check(host_name[0] == "desk" and host_name[1] <= 0, f"fit: the host name is not the piece that gives way ({host_name})")
        pane.wait_for_selector(f'{FRAME}[data-ready="true"]', timeout=30000)
        page.screenshot(path=str(shots / "layer-bar-long-name.png"))
        # Resting the pointer on the chip glides the name to its end (fade moves to the start); leaving glides back.
        page.mouse.move(600, 400)  # the pointer is still on the chip from the clicks above; the glide starts on entering
        pane.hover(f"{TAG} .kide-glyph")
        pane.wait_for_function("() => document.querySelector('#kirocrew-ide-layer .kide-ws-name').dataset.clipped === 'start'", timeout=5000)
        check(True, "fit: resting the pointer on the chip glides the name to its end")
        page.mouse.move(600, 400)
        pane.wait_for_function("() => document.querySelector('#kirocrew-ide-layer .kide-ws-name').dataset.clipped === 'end'", timeout=5000)
        check(pane.evaluate("() => document.querySelector('#kirocrew-ide-layer .kide-ws-name').scrollLeft") == 0, "fit: leaving the chip glides the name back")
        # A wheel anywhere on the chip (here over the IDE glyph, not the name) scrolls the name sideways.
        pane.hover(f"{TAG} .kide-glyph")
        pane.wait_for_function("() => document.querySelector('#kirocrew-ide-layer .kide-ws-name').dataset.clipped === 'start'", timeout=5000)
        page.mouse.wheel(0, -40)
        pane.wait_for_function("() => document.querySelector('#kirocrew-ide-layer .kide-ws-name').dataset.clipped === 'both'", timeout=5000)
        check(True, "fit: a wheel anywhere on the chip scrolls the name and the fade follows")
        page.mouse.move(600, 400)
        pane.wait_for_timeout(100)
        check(pane.evaluate("() => document.querySelector('#kirocrew-ide-layer .kide-ws-name').scrollLeft") > 0, "fit: a wheel position is kept when the pointer leaves (no glide back after manual scrolling)")
        pane.evaluate(f"(f) => {api}.close(f)", long_name)
        pane.wait_for_function(f"() => document.querySelectorAll('{ANY_FRAME}').length === 2", timeout=10000)
        pane.evaluate(f"() => {api}.activate('/tmp/demo')")
        pane.wait_for_function(f"() => document.querySelector('{FRAME}').dataset.folder === '/tmp/demo'", timeout=5000)
        # Escape closes the workspace menu first, then the layer.
        pane.click(TAG)
        pane.wait_for_selector(WS_ROWS)
        pane.press("body", "Escape")
        pane.wait_for_timeout(150)
        check(pane.evaluate(f"() => document.querySelector('{WS_MENU}').hidden") and shown(pane), "ws: Escape closes the workspace menu and leaves the layer up")
        # Close the second workspace from its ×: its document goes, the first stays.
        pane.click(TAG)
        pane.wait_for_selector(WS_ROWS)
        pane.click(WS_ROWS + '[data-folder="/tmp/recent"] .kide-x')
        pane.wait_for_function(f"() => document.querySelectorAll('{ANY_FRAME}').length === 1", timeout=10000)
        check(frames(pane) == [["/tmp/demo", "true", frame_id]], f"ws: closing a workspace drops only its document ({frames(pane)})")
        pane.wait_for_function(f"() => !document.querySelector('{TAG} .kide-count')", timeout=5000)
        check("IDE·demo" in tag_text(pane), f"ws: the count badge goes with a single workspace and the tag names the one left ({tag_text(pane)!r})")
        pane.press("body", "Escape")
        pane.press("body", "Escape")
        wait_mode(pane, "docked")
        # The App page: Start reads Open on a running engine and adds the folder; the strip lists and switches.
        check(pane.text_content('[data-testid="kirocrew-ide-start"]').strip() == "Open", "ws: the App page's Start button reads 'Open' while the engine runs")
        pane.wait_for_selector(STRIP)
        pane.wait_for_function(f"() => document.querySelectorAll('{STRIP} [role=tab]').length === 1", timeout=10000)  # the page polls status every 5 s
        check(pane.eval_on_selector_all(STRIP + " [role=tab]", "els => els.map(e => [e.dataset.folder, e.getAttribute('aria-selected')])") == [["/tmp/demo", "true"]], "ws: the page's strip shows the open workspace")
        # Docked: the layer's bar is hidden but the task indicator is not; it still ends before the
        # workbench's layout controls (the frame fills the layer, so frame and layer coordinates agree).
        pane.wait_for_function(f"() => {{ const w = document.querySelector('{PROG}'); return w && !w.hidden && getComputedStyle(w).display !== 'none'; }}", timeout=5000)
        docked_ind = pane.evaluate(f"""() => {{
          const w = document.querySelector('{PROG}').getBoundingClientRect();
          const bar = document.querySelector('#kirocrew-ide-layer .kide-bar');
          const layer = document.getElementById('kirocrew-ide-layer').getBoundingClientRect();
          const tool = document.querySelector('{FRAME}').contentDocument.querySelector('.action-toolbar-container').getBoundingClientRect();
          return {{ barHidden: getComputedStyle(bar).display === 'none', right: Math.round(w.right), toolLeft: Math.round(layer.left + tool.left), top: Math.round(w.top - layer.top), inLayer: w.left > layer.left && w.right < layer.right }};
        }}""")
        check(docked_ind["barHidden"] and docked_ind["inLayer"] and docked_ind["right"] <= docked_ind["toolLeft"] - 4 and 4 <= docked_ind["top"] <= 12, f"progress: docked, the indicator shows at the workbench's top right, clear of its controls ({docked_ind})")
        tab_prog = pane.evaluate(f"() => {{ const t = document.querySelector('{STRIP} [data-folder=\"/tmp/demo\"] [data-testid=\"kirocrew-ide-tab-progress\"]'); return t && [t.textContent, !!t.querySelector('svg'), t.title.split('\\n').length, t.title.includes('alpha: 5/11')]; }}")
        check(tab_prog == ["50%", True, 3, True], f"progress: the App page's tab carries the workspace's donut + % with the breakdown in its tooltip ({tab_prog})")
        # The folder menu over the docked IDE: it opens at document.body, fixed under the field,
        # and a point inside it that overlaps the workbench hit-tests to the menu, not the layer.
        pane.click('[data-testid="kirocrew-ide-folder"] input')
        pane.wait_for_selector('[data-testid="kirocrew-ide-folder-menu"] [role=option]')
        over = pane.evaluate("""() => {
          const menu = document.querySelector('[data-testid="kirocrew-ide-folder-menu"]');
          const field = document.querySelector('[data-testid="kirocrew-ide-folder"]');
          const layer = document.getElementById('kirocrew-ide-layer');
          const m = menu.getBoundingClientRect(), f = field.getBoundingClientRect(), l = layer.getBoundingClientRect();
          const overlapTop = Math.max(m.top, l.top), overlapBottom = Math.min(m.bottom, l.bottom);
          if (overlapBottom - overlapTop < 4) return { overlap: false };
          const x = m.left + Math.min(m.width, l.right - m.left) / 2, y = (overlapTop + overlapBottom) / 2;
          const hit = document.elementFromPoint(x, y);
          return { overlap: true, portal: menu.parentElement === document.body, fixed: getComputedStyle(menu).position === 'fixed',
                   aligned: Math.abs(m.left - f.left) < 1 && Math.abs(m.top - f.bottom - 4) < 1 && Math.abs(m.width - f.width) < 1,
                   hitInMenu: !!hit && menu.contains(hit), hitTag: hit && (hit.id || hit.tagName) };
        }""")
        check(over.get("overlap") and over.get("portal") and over.get("fixed") and over.get("aligned") and over.get("hitInMenu"), f"ws: the folder menu is portaled, fixed under the field, and paints over the docked IDE ({over})")
        page.screenshot(path=str(shots / "app-folder-menu-docked.png"))
        pane.click('[data-testid="kirocrew-ide-folder-menu"] [role=option]')
        pane.wait_for_timeout(100)
        check(pane.query_selector('[data-testid="kirocrew-ide-folder-menu"]') is not None or pane.input_value('[data-testid="kirocrew-ide-folder"] input') != "", "ws: a click inside the portaled menu acts on the picker instead of closing it as an outside click")
        pane.press('[data-testid="kirocrew-ide-folder"] input', "Escape")
        pane.wait_for_function("() => !document.querySelector('[data-testid=\"kirocrew-ide-folder-menu\"]')", timeout=5000)
        pane.fill('[data-testid="kirocrew-ide-folder"] input', "/tmp/other")
        pane.click('[data-testid="kirocrew-ide-start"]')
        pane.wait_for_function(f"() => document.querySelectorAll('{STRIP} [role=tab]').length === 2", timeout=10000)
        pane.wait_for_function(f"() => document.querySelector('{FRAME}') && document.querySelector('{FRAME}').dataset.folder === '/tmp/other'", timeout=10000)
        check(pane.evaluate(f"() => [...document.querySelectorAll('{STRIP} [role=tab]')].map(e => e.getAttribute('aria-selected'))") == ["false", "true"], "ws: Open adds the folder and the strip marks it active")
        check(pane.evaluate(DOCKED), "ws: the new document is docked in the page")
        pane.click(STRIP + ' [data-folder="/tmp/demo"] button')
        pane.wait_for_function(f"() => document.querySelector('{FRAME}').dataset.folder === '/tmp/demo'", timeout=5000)
        check(pane.evaluate(f"() => document.querySelector('{FRAME}').__mark") == frame_id, "ws: the strip switches back to the original document")
        pane.click(STRIP + ' [data-folder="/tmp/other"] [aria-label^="Close"]')
        pane.wait_for_function(f"() => document.querySelectorAll('{STRIP} [role=tab]').length === 1", timeout=10000)
        check(pane.evaluate(f"() => document.querySelectorAll('{ANY_FRAME}').length") == 1, "ws: the strip's × closes the workspace and its document")
        # The tab row: tabs rest on the dock's top edge (bottom-open, like a browser), the
        # active tab is the only one with full opacity, and the + opens the folder picker.
        tabs = pane.evaluate(f"""() => {{
          const strip = document.querySelector('{STRIP}');
          const tab = strip.querySelector('[role=tab][aria-selected=true]');
          const dock = document.querySelector('[data-testid="kirocrew-ide-dock"]');
          const t = tab.getBoundingClientRect(), d = dock.getBoundingClientRect(), cs = getComputedStyle(tab);
          return {{ gap: Math.round(d.top - t.bottom), bottomOpen: cs.borderBottomColor === 'rgba(0, 0, 0, 0)',
                    topRounded: parseFloat(cs.borderTopLeftRadius) > 0 && parseFloat(cs.borderBottomLeftRadius) === 0,
                    text: strip.textContent, plus: !!strip.querySelector('[data-testid="kirocrew-ide-new-tab"]') }};
        }}""")
        check(tabs["gap"] in (-1, 0) and tabs["bottomOpen"] and tabs["topRounded"] and tabs["plus"], f"ws: tabs sit on the dock, open at the bottom, with a + tab ({tabs})")
        check("engine" not in tabs["text"] and "pick a folder" not in tabs["text"], "ws: the tab row carries no count/help sentence")
        check(pane.query_selector("text=/same-origin at/") is None, "ws: no 'served same-origin' line on the page")
        pane.click('[data-testid="kirocrew-ide-new-tab"]')
        pane.wait_for_selector('[data-testid="kirocrew-ide-folder-menu"]', timeout=5000)
        check(pane.evaluate("() => document.activeElement === document.querySelector('[data-testid=\"kirocrew-ide-folder\"] input')"), "ws: + focuses the folder field and opens its menu")
        page.screenshot(path=str(shots / "app-workspace-tabs.png"))
        pane.press('[data-testid="kirocrew-ide-folder"] input', "Escape")
        Engine.workspaces = ["/tmp/demo"]

        # --- local dashboard with KiroCrew's chip row on the page ---
        page2 = ctx.new_page()
        page2.on("pageerror", lambda e: errors.append(str(e)))
        page2.goto(base + "/local.html", wait_until="domcontentloaded")
        page2.wait_for_selector(DOCK, timeout=20000)
        page2.wait_for_selector(CHIP, timeout=10000)
        wait_mode(page2, "docked")
        joined = "() => { const c = document.querySelector('[data-testid=kirocrew-ide-chip]'); const a = c.previousElementSibling; return !!a && a.getAttribute('aria-current') === 'true' && a.classList.contains('tb-crew-active-chip') && c.dataset.sub === 'true' && c.textContent.trim() === 'IDE' && getComputedStyle(c).borderTopLeftRadius === '0px' && getComputedStyle(a).borderTopRightRadius === '0px' && Math.abs(c.getBoundingClientRect().left - a.getBoundingClientRect().right) < 1; }"
        check(page2.evaluate(joined), "local: the tag is a sub-tag joined flush to the leading current-host chip, reading 'IDE' ([host]IDE])")
        check(page2.evaluate("() => { const c = document.querySelector('[data-testid=kirocrew-ide-chip]'); return c.previousElementSibling.textContent.trim() === 'desk' && c.nextElementSibling.dataset.testid === 'crew-chip-row'; }"), "local: it sits right after 'desk', before the pinned row")
        # The host re-renders its bar: the tag comes back, on the fresh host chip.
        page2.evaluate("window.__rerenderBar()")
        page2.wait_for_selector(CHIP, timeout=5000)
        page2.wait_for_function(joined, timeout=5000)
        check(page2.evaluate(joined), "local: the sub-tag is re-attached after the bar re-renders")
        page2.click(CHIP)
        wait_mode(page2, "fullscreen")
        check(page2.evaluate(BAR_JOINED), "local: the bar's tag is the same joined 'IDE' sub-tag as the one in KiroCrew's bar")
        page2.screenshot(path=str(shots / "layer-local.png"))
        open_menu(page2)
        rows2 = rows_of(page2)
        check([r[0] for r in rows2] == ["crew", "here", "crew"], f"local: menu = Local, desk (here), sandbox ({[r[0] for r in rows2]})")
        page2.click(ROWS + ':has-text("sandbox")')
        page2.wait_for_timeout(100)
        check(page2.evaluate("window.__clicked") == ["sandbox"], "local: picking a crew clicks KiroCrew's own chip")
        page2.evaluate("() => window.__kirocrewIde.hide()")
        wait_mode(page2, "docked")
        check(page2.evaluate(DOCKED), "local: hide() from fullscreen lands on the App page's dock")
        page2.screenshot(path=str(shots / "layer-local-docked.png"))
        # The engine stops: the tag disappears, the host chip gets its corners back, the layer drops its frame.
        page2.evaluate("() => fetch('/__engine/stop', {method: 'POST'})")
        page2.evaluate("() => window.__kirocrewIde.refresh()")
        page2.wait_for_function(f"() => !document.querySelector('{CHIP}')", timeout=10000)
        check(page2.evaluate("() => document.querySelector('.tb-crew-active-chip').style.borderTopRightRadius === ''"), "local: the host chip's corners are restored when the tag goes")
        check(mode(page2) == "hidden", "local: a stopped engine hides the layer, docked or not")
        check(page2.evaluate(f"() => document.querySelector('{FRAME}') === null"), "local: a stopped engine drops the dead frame")
        check(page2.evaluate("() => document.body.style.overflow !== 'hidden'"), "local: the page scroll is unlocked afterwards")
        Engine.running = True

        real_errors = [e for e in errors if "favicon" not in e]
        check(not real_errors, f"no page errors ({real_errors[:3]})")
        browser.close()
    server.shutdown()
    print("\n" + ("ALL OK" if not failures else f"{len(failures)} FAILURE(S)"))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
