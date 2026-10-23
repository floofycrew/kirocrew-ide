"""KiroCrew IDE — gateway-side engine supervisor.

Runs a VS Code web engine (openvscode-server by default) as a loopback-only
sidecar process and exposes a small control API to the mod's own UI parts:

    GET  status    — engine resolution, server liveness, embed URL
    POST start     — {"folder": "/abs/path"?} start (or reuse) the server
    POST stop      — terminate the server
    POST workspaces/open  — {"folder": "/abs"} one more folder on the same engine
    POST workspaces/close — {"folder": "/abs"} forget it (the engine stays up)
    GET  engines   — which engine binaries resolve on this host

Design notes (see DESIGN.md):
- The server binds 127.0.0.1 only and requires a per-start connection token,
  so nothing here opens the machine to the network.
- Server facts are persisted to <data_dir>/server.json so a gateway restart
  ADOPTS a still-running IDE instead of killing the user's editor.
- The subprocess is the mod's own child; `deactivate` leaves it running on
  purpose (a gateway reload must not close open files) — `stop` is explicit.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import hashlib
import json
import os
import platform
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile

try:
    from . import gallery  # the Loader imports this file as the `hook` package
except ImportError:  # the unit tests load it as a bare module from its path
    import importlib.util as _ilu
    _spec = _ilu.spec_from_file_location("kirocrew_ide_gallery", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gallery.py"))
    gallery = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(gallery)

STATE_FILE = "server.json"
ENGINE_LOG = "engine.log"
ENGINES_DIR = "engines"

# Same-origin proxy (see DESIGN.md "One port"): the workbench is served under
# this path ON THE DASHBOARD ORIGIN, so a remote host needs no second ssh
# forward — the dashboard port you already forward carries the IDE too. The
# engine runs with `--server-base-path <PROXY_BASE>` so every URL it emits
# lands here. Registered by `early(ctx)` through an after-hook on the host's
# own route registration, because it must be a RAW aiohttp route: the workbench
# needs a WebSocket for its extension host, and neither the mod route API nor
# the host's App Kit proxy carries an upgrade (App Kit strips `upgrade` /
# `connection` outright — apps/routes.py `_PROXY_HOP_HEADERS`).
PROXY_BASE = "/kirocrew-ide"
# armed: the import hook is in place / the host module is wrapped.
# registered: the aiohttp route actually exists on the running app.
_proxy_state = {"armed": False, "registered": False, "error": None}
# The registration outlives THIS module object: a Loader reload (`floofy
# install --now`, update) re-imports the hook with fresh globals while the raw
# route registered at gateway start stays on the aiohttp app. So the fact is
# also recorded on the host's routes module (see `_proxy_registered`), which
# lives as long as the process — otherwise a reloaded hook believed the proxy
# was gone and relaunched a working proxied engine into direct-port mode.
PROXY_RECORD_ATTR = "_floofy_kirocrew_ide_proxy"


def _proxy_registered():
    """Is the same-origin route live on the running gateway (any hook module object)?"""
    if _proxy_state["registered"]:
        return True
    host_routes = sys.modules.get(ROUTES_MODULE)
    record = getattr(host_routes, PROXY_RECORD_ATTR, None)
    if record is not None:
        return bool(record.get("registered") and record.get("base") == PROXY_BASE)
    # Upgrade path from a hook (<= 0.4.3) whose wrapper wrote no record: its
    # `__floofy_ide__` marker on the host function means the wrapper was in
    # place when the gateway built its routes, i.e. the route is live.
    wrapped = getattr(host_routes, "register_app_routes", None)
    return bool(getattr(wrapped, "__floofy_ide__", False))
# Where the early hook can find the running engine: resolved at early() time,
# because a request may arrive before/without activate().
_data_dir_hint = {"path": None}

# Engine presets: command template rendered with {port} {token} {folder}.
# `engine.command` in the mod config overrides everything (string, shlex-split).
# NOTE on the connection token (measured on openvscode-server 1.109.5):
# `--connection-token T` makes the engine answer `?tkn=T` with a 302 that sets
# `vscode-tkn=T; SameSite=Lax`. The workbench is embedded in an IFRAME whose
# origin differs from the dashboard's (different port), so that Lax cookie is
# not returned on the redirected request and the engine answers a bare
# "Forbidden." — the token makes the IDE unembeddable, which is the whole
# product. The engine binds 127.0.0.1 only, so reachability is already limited
# to local processes; that is the same posture code-server's `--auth none`
# preset has always had here. Set `engine.token: true` in the mod config to
# restore the token (useful on a shared host, at the cost of embedding, where
# the App page's link-out still works).
PRESETS = {
    "openvscode-server": (
        "openvscode-server --host 127.0.0.1 --port {port} "
        "{auth} {basepath} {extensions} --accept-server-license-terms"
    ),
    "code-server": (
        # code-server has no URL token auth; run auth=none, loopback only.
        "code-server --bind-addr 127.0.0.1:{port} --auth none {extensions}"
    ),
}

# The bridge extension (extension/ in this mod): KiroCrew chat, agents,
# sessions and the spec workflow inside the workbench. It is a WEB extension
# (browser extension host) on purpose: the workbench is served on the
# dashboard's own origin through the same-origin proxy, so the extension
# reaches the dashboard's /api/* with the user's own session cookie — the IDE
# user IS the dashboard user, no second credential, nothing to mint or store.
# Provisioned unpacked into <data>/extensions/<publisher>.<name>-<version>/ on
# every engine start (so a mod update refreshes it) and handed to the engine
# with --extensions-dir; the engine's own user data dir is untouched.
EXTENSIONS_DIR = "extensions"
EXTENSION_SRC = "extension"

# Auto-install source: openvscode-server GitHub releases (MIT). All hosts here
# are declared in the manifest's network.hosts[]; every request is https and
# re-checked on redirect (see _open_checked).
DOWNLOAD_REPO = "gitpod-io/openvscode-server"
DOWNLOAD_URL = (
    "https://github.com/{repo}/releases/download/"
    "openvscode-server-v{version}/openvscode-server-v{version}-linux-{arch}.tar.gz"
)
LATEST_API = "https://api.github.com/repos/{repo}/releases/latest"

_ctx = None
_install = {"state": "idle"}  # idle | resolving | downloading | extracting | done | error
_install_lock = threading.Lock()


# --------------------------------------------------------------- state file

def _state_path():
    base = str(_ctx.data_dir) if _ctx is not None else _data_dir_hint["path"]
    if not base:
        raise RuntimeError("no data dir known yet")
    return os.path.join(base, STATE_FILE)


def _read_state():
    try:
        with open(_state_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _write_state(state):
    tmp = _state_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    os.replace(tmp, _state_path())


def _clear_state():
    try:
        os.unlink(_state_path())
    except OSError:
        pass


# ------------------------------------------------------------------ engine

def _installed_engine():
    """Newest auto-installed engine binary under <data>/engines, or None."""
    root = os.path.join(str(_ctx.data_dir), ENGINES_DIR)
    best = None
    if os.path.isdir(root):
        for entry in sorted(os.listdir(root), reverse=True):
            binary = os.path.join(root, entry, "bin", "openvscode-server")
            if os.access(binary, os.X_OK):
                best = binary
                break
    return best


def _engine():
    """Resolve the engine: (name, template) or (None, None)."""
    configured = _ctx.config.get("engine.command")
    if configured:
        return ("custom", str(configured))
    for name, template in PRESETS.items():
        if shutil.which(name):
            return (name, template)
    installed = _installed_engine()
    if installed:
        return (
            "openvscode-server (auto-installed)",
            PRESETS["openvscode-server"].replace(
                "openvscode-server ", shlex.quote(installed) + " ", 1
            ),
        )
    return (None, None)


def _mod_dir():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _provision_extension():
    """Copy extension/ into <data>/extensions as an unpacked VS Code extension; returns the extensions dir or None.

    Older copies of the same extension are removed so the workbench never sees
    two versions. Any failure is logged and skipped: the IDE must still start
    without its bridge.
    """
    src = os.path.join(_mod_dir(), EXTENSION_SRC)
    manifest_path = os.path.join(src, "package.json")
    if not os.path.isfile(manifest_path):
        return None
    try:
        with open(manifest_path, "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
        publisher, name, version = manifest["publisher"], manifest["name"], manifest["version"]
        root = os.path.join(str(_ctx.data_dir), EXTENSIONS_DIR)
        os.makedirs(root, exist_ok=True)
        prefix = "%s.%s-" % (publisher, name)
        target = os.path.join(root, prefix + version)
        for entry in os.listdir(root):
            if entry.startswith(prefix) and entry != os.path.basename(target):
                shutil.rmtree(os.path.join(root, entry), ignore_errors=True)
        if os.path.isdir(target):
            shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(src, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules", ".git"))
        _register_extension(root, "%s.%s" % (publisher, name), version, target)
        _ctx.log.info("bridge extension provisioned: %s", target)
        return root
    except Exception as error:  # noqa: BLE001 — the IDE starts without its bridge
        _ctx.log.warning("bridge extension not provisioned: %s", error)
        return None


def _reregister_extension():
    """Rewrite our extensions.json entry for the copy ALREADY on disk; the folder is not touched.

    For a running engine the hook adopts (a Loader reload, a mod update): the
    engine keeps serving webview resources out of the provisioned folder, so it
    must not be re-copied under it, but a registry fix — 0.14.2's
    application scope — should reach the engine without a Stop/Start. Returns
    True when an entry was written.
    """
    src = os.path.join(_mod_dir(), EXTENSION_SRC)
    manifest_path = os.path.join(src, "package.json")
    if not os.path.isfile(manifest_path):
        return False
    try:
        with open(manifest_path, "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
        publisher, name, version = manifest["publisher"], manifest["name"], manifest["version"]
        root = os.path.join(str(_ctx.data_dir), EXTENSIONS_DIR)
        target = os.path.join(root, "%s.%s-%s" % (publisher, name, version))
        if not os.path.isdir(target):
            return False
        _register_extension(root, "%s.%s" % (publisher, name), version, target)
        return True
    except Exception as error:  # noqa: BLE001 — the next start re-provisions anyway
        _ctx.log.warning("bridge extension not re-registered: %s", error)
        return False


#: Machine-scope settings the engine starts with. The Machine layer sits BELOW
#: the user's own settings.json, so anything the user changes in the IDE wins;
#: keys already present in the file are never overwritten. The built-in AI
#: chat (the right-hand panel that wants a Copilot/GitHub sign-in) is turned off
#: because KiroCrew's chat takes that place; the secondary side bar is opened
#: so the KiroCrew Chat view, which the extension moves there, is visible.
MACHINE_SETTINGS = {
    "chat.disableAIFeatures": True,
    "chat.commandCenter.enabled": False,
    "workbench.secondarySideBar.defaultVisibility": "visible",
    "workbench.startupEditor": "none",
    "security.workspace.trust.startupPrompt": "once",
    "telemetry.telemetryLevel": "off",
}
MACHINE_SETTINGS_PATH = "~/.openvscode-server/data/Machine/settings.json"


def _seed_machine_settings(path=MACHINE_SETTINGS_PATH):
    """Add the missing MACHINE_SETTINGS keys to the engine's Machine settings; existing keys are kept."""
    target = os.path.expanduser(path)
    try:
        current = {}
        if os.path.isfile(target):
            with open(target, "r", encoding="utf-8") as fh:
                text = fh.read().strip()
            current = json.loads(text) if text else {}
            if not isinstance(current, dict):
                current = {}
        missing = {k: v for k, v in MACHINE_SETTINGS.items() if k not in current}
        if not missing:
            return False
        current.update(missing)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(current, fh, indent=2)
        os.replace(tmp, target)
        if _ctx is not None:
            _ctx.log.info("engine machine settings seeded: %s", ", ".join(sorted(missing)))
        return True
    except Exception as error:  # noqa: BLE001 — cosmetic defaults, never block a start
        if _ctx is not None:
            _ctx.log.warning("machine settings not seeded: %s", error)
        return False


def _register_extension(root, ext_id, version, target):
    """Keep VS Code's own registry of the extensions dir in step with the folder we provisioned.

    The workbench scans the user extensions dir against `extensions.json` (the
    list its installer writes) and `.obsolete` (folders it decided to drop): a
    folder that is not in the list is "Marked extension as removed" and never
    loaded — measured on openvscode-server 1.109.5, where 0.1.0 (the first copy,
    which the scanner had registered itself) loaded and every later version was
    silently obsoleted. So write the entry the installer would have written and
    drop our folder from `.obsolete`; other extensions' entries are kept.

    The entry is APPLICATION-SCOPED (`metadata.isApplicationScoped`), VS Code's
    "in every profile" flag. `<extensions-dir>/extensions.json` is only the
    DEFAULT profile's registry: a profile the user creates or imports gets its
    own `User/profiles/<id>/extensions.json`, which lists the extensions the
    import brought and nothing else, so a bridge registered in the default file
    alone vanishes the moment the user switches profile (seen on 0.14.1: an
    imported profile had every extension but ours). The profile scanner merges
    the default registry's application-scoped entries into every other
    profile, which is what the "Apply Extension to all Profiles" action sets.
    Not `isBuiltin`: a user extension flagged builtin without a system twin is
    dropped by the engine's dedup as an "obsolete builtin extension".
    """
    registry_path = os.path.join(root, "extensions.json")
    entries = []
    try:
        with open(registry_path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        entries = [e for e in loaded if isinstance(e, dict)
                   and (e.get("identifier") or {}).get("id", "").lower() != ext_id.lower()]
    except (OSError, ValueError):
        entries = []
    entries.append({
        "identifier": {"id": ext_id},
        "version": version,
        "location": {"$mid": 1, "path": os.path.realpath(target), "scheme": "file"},
        "relativeLocation": os.path.basename(target),
        "metadata": {"installedTimestamp": int(time.time() * 1000), "source": "kirocrew-ide", "isApplicationScoped": True},
    })
    with open(registry_path, "w", encoding="utf-8") as fh:
        json.dump(entries, fh)
    obsolete_path = os.path.join(root, ".obsolete")
    try:
        with open(obsolete_path, "r", encoding="utf-8") as fh:
            obsolete = json.load(fh)
        kept = {k: v for k, v in obsolete.items() if not k.startswith(ext_id + "-")}
        with open(obsolete_path, "w", encoding="utf-8") as fh:
            json.dump(kept, fh)
    except (OSError, ValueError):
        pass


def _engines_report():
    rows = []
    for name in PRESETS:
        rows.append({"name": name, "path": shutil.which(name)})
    return {
        "presets": rows,
        "installed": _installed_engine(),
        "install": dict(_install),
        "configured": _ctx.config.get("engine.command"),
        "hint": (
            "POST engines/install downloads openvscode-server (MIT, from"
            " github.com/" + DOWNLOAD_REPO + " releases) into this mod's data"
            " dir. Or install one on PATH yourself, or set engine.command in"
            " the mod config to a full command template with"
            " {port} {token} {folder}."
        ),
    }


# ------------------------------------------------------- engine installer

def _open_checked(url, timeout=30):
    """https-only fetch honouring the manifest allowlist on every redirect."""
    class _Guard(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            _ctx.http.check(newurl)  # raises FloofyNetworkDenied if off-list
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    _ctx.http.check(url)
    opener = urllib.request.build_opener(_Guard())
    request = urllib.request.Request(url, headers={"User-Agent": "kirocrew-ide-mod"})
    return opener.open(request, timeout=timeout)


def _resolve_latest_version():
    with _open_checked(LATEST_API.format(repo=DOWNLOAD_REPO)) as reply:
        tag = json.load(reply).get("tag_name", "")
    match = re.search(r"v(\d+\.\d+\.\d+)$", tag)
    if not match:
        raise RuntimeError("cannot parse latest release tag: %r" % tag)
    return match.group(1)


def _install_engine_worker(version):
    try:
        if not version:
            _install.update(state="resolving")
            version = _resolve_latest_version()
        arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "x64"
        url = DOWNLOAD_URL.format(repo=DOWNLOAD_REPO, version=version, arch=arch)
        root = os.path.join(str(_ctx.data_dir), ENGINES_DIR)
        os.makedirs(root, exist_ok=True)
        archive = os.path.join(root, "download-v%s.tar.gz" % version)
        _install.update(state="downloading", version=version, url=url, bytes=0)
        _ctx.log.info("engine download: %s", url)
        with _open_checked(url, timeout=60) as reply, open(archive, "wb") as out:
            while True:
                chunk = reply.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                _install["bytes"] = _install.get("bytes", 0) + len(chunk)
        _install.update(state="extracting")
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(root, filter="data")
        os.unlink(archive)
        binary = _installed_engine()
        if not binary:
            raise RuntimeError("archive extracted but no engine binary found")
        _install.update(state="done", binary=binary)
        _ctx.log.info("engine installed: %s", binary)
    except Exception as error:  # noqa: BLE001 — reported through the route
        _install.update(state="error", error=str(error))
        _ctx.log.warning("engine install failed: %s", error)


def _engines_install(request):
    body = {}
    try:
        body = request.json() or {}
    except Exception:
        pass
    with _install_lock:
        if _install.get("state") in ("resolving", "downloading", "extracting"):
            return (409, {"error": "install already running", "install": dict(_install)})
        _install.clear()
        _install.update(state="resolving")
        worker = threading.Thread(
            target=_install_engine_worker,
            args=(body.get("version") or _ctx.config.get("engine.version"),),
            daemon=True,
        )
        worker.start()
    return {"started": True, "install": dict(_install),
            "note": "poll GET engines for progress"}


# A PREDICTABLE port matters: dashboards are commonly reached over an ssh
# port-forward, and the browser loads the IDE iframe from 127.0.0.1:<port> on
# the BROWSER's machine — so the user must be able to forward the engine port
# alongside the dashboard's. Default base 35476 (dashboard default 5476 + 30000),
# scanning a few upwards; `engine.port` in the mod config pins it exactly.
PORT_BASE = 35476
PORT_SCAN = 10


def _port_free(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", port))
            return True
    except OSError:
        return False


def _pick_port():
    pinned = _ctx.config.get("engine.port")
    if pinned:
        port = int(pinned)
        if not _port_free(port):
            raise RuntimeError("configured engine.port %d is in use" % port)
        return port
    for port in range(PORT_BASE, PORT_BASE + PORT_SCAN):
        if _port_free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _embed_url(state, folder=None):
    """Where the browser should load the workbench from.

    Same-origin proxy path when it is live (no extra ssh forward on a remote
    host); otherwise the engine's own loopback port, which the user must
    forward themselves. `folder` picks the workspace the document opens
    (default: the engine's first); one engine serves any number of them.
    """
    if not state:
        return None
    query = []
    if state.get("token"):
        query.append("tkn=" + state["token"])
    folder = folder or state.get("folder")
    if folder:
        query.append("folder=" + folder)
    suffix = "?" + "&".join(query) if query else ""
    if state.get("proxied") and _proxy_registered():
        return PROXY_BASE + "/" + suffix
    return "http://127.0.0.1:%d/%s" % (state["port"], suffix)


def _workspaces(state):
    """The folders open on the engine, oldest first (the start folder leads).

    One engine serves every workspace: each is just another workbench
    document with its own `?folder=`. The list lives in the engine's persisted
    state so it survives a gateway restart with the engine, and is cleared
    with it on stop.
    """
    if not state:
        return []
    out, seen = [], set()
    for folder in list(state.get("workspaces") or []) + ([state["folder"]] if state.get("folder") else []):
        if folder and _same_dir_key(folder) not in seen:
            out.append(folder)
            seen.add(_same_dir_key(folder))
    return out


def _same_dir_key(folder):
    """One key per directory however it is spelled (~, symlinked /local/home, trailing slash)."""
    return os.path.realpath(os.path.expanduser(str(folder))).rstrip("/") or "/"


def _workspace_rows(state):
    return [{"folder": f, "name": os.path.basename(f.rstrip("/")) or f, "embedUrl": _embed_url(state, f),
             "progress": _spec_progress(f)}
            for f in _workspaces(state)]


# ------------------------------------------------------------ spec progress

SPECS_DIR = os.path.join(".kiro", "specs")
TASKS_FILE = "tasks.md"
TASKS_MAX_BYTES = 2 * 1024 * 1024
# One line of tasks.md in Kiro's grammar (the extension's parseTaskLine, same regex): a list
# bullet, a box in one of the four states, an optional `*` (or `\*`) mark, then the text.
TASK_LINE_RE = re.compile(r"^(\s*)([-*+])\s+\[([ xX\-~])\](\\?\*?)\s+(.+)$")
_progress_cache = {}   # tasks.md path -> (mtime_ns, size, counts)


def _count_tasks(text):
    """Count the task boxes of one tasks.md by state: every box counts, a parent task's as much as a sub-task's.

    `done` is `[x]`; `inProgress` `[-]` and `queued` `[~]` are what Kiro's Task
    Orchestrator writes while it runs; `optional` counts the `*`-marked boxes
    (they are in `total` too — the file's own checkboxes are the measure).
    """
    counts = {"total": 0, "done": 0, "inProgress": 0, "queued": 0, "optional": 0}
    for line in str(text).splitlines():
        m = TASK_LINE_RE.match(line)
        if not m:
            continue
        counts["total"] += 1
        mark = m.group(3).lower()
        if mark == "x":
            counts["done"] += 1
        elif mark == "-":
            counts["inProgress"] += 1
        elif mark == "~":
            counts["queued"] += 1
        if m.group(4):
            counts["optional"] += 1
    return counts


def _tasks_counts(path):
    """The counts for one tasks.md, re-read only when its mtime or size changed."""
    try:
        st = os.stat(path)
    except OSError:
        _progress_cache.pop(path, None)
        return None
    key = (st.st_mtime_ns, st.st_size)
    cached = _progress_cache.get(path)
    if cached and cached[0] == key[0] and cached[1] == key[1]:
        return cached[2]
    if st.st_size > TASKS_MAX_BYTES:
        counts = {"total": 0, "done": 0, "inProgress": 0, "queued": 0, "optional": 0}
    else:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                counts = _count_tasks(fh.read())
        except OSError:
            return None
    _progress_cache[path] = (key[0], key[1], counts)
    return counts


def _spec_progress(folder):
    """Task completeness of a workspace from its `.kiro/specs/*/tasks.md` files.

    Returns {"done", "total", "inProgress", "queued", "optional", "specs": [...]} with one
    entry per spec directory that has a tasks.md (name-sorted; each with its own counts
    and the file's workspace-relative path), the top-level counts being their sum — so
    several specs combine into one percentage and the rows are its breakdown. `None`
    when the folder has no specs directory; a folder whose specs hold no boxes yet
    reports total 0. Never raises: a progress read must not break `status`.
    """
    try:
        root = os.path.join(os.path.expanduser(str(folder)), SPECS_DIR)
        if not os.path.isdir(root):
            return None
        try:
            names = sorted(os.listdir(root))
        except OSError:
            return None
        specs = []
        for name in names:
            path = os.path.join(root, name, TASKS_FILE)
            counts = _tasks_counts(path)   # None: no tasks.md there (and its stale cache entry is dropped)
            if counts is None:
                continue
            specs.append(dict(counts, name=name, dir=os.path.join(SPECS_DIR, name), tasks=os.path.join(SPECS_DIR, name, TASKS_FILE)))
        total = {"total": 0, "done": 0, "inProgress": 0, "queued": 0, "optional": 0}
        for spec in specs:
            for key in total:
                total[key] += spec[key]
        total["specs"] = specs
        return total
    except Exception:  # noqa: BLE001 - diagnostics only; status must stay up
        return None


def _add_workspace(state, folder):
    """Record `folder` on the running engine (idempotent); returns the rows."""
    folders = _workspaces(state)
    if _same_dir_key(folder) not in {_same_dir_key(f) for f in folders}:
        folders.append(folder)
    state["workspaces"] = folders
    _write_state(state)
    _remember_folder(folder)
    return _workspace_rows(state)


def _workspaces_open(request):
    """POST workspaces/open {"folder": "/abs"} — open another folder on the running engine.

    Starts the engine with that folder when none runs. The browser side gives
    the new workspace its own workbench document; nothing already open reloads.
    """
    body = {}
    try:
        body = request.json() or {}
    except Exception:
        pass
    folder = os.path.normpath(os.path.expanduser(str(body.get("folder") or "")))
    if not body.get("folder"):
        return (400, {"error": "folder is required"})
    if not os.path.isdir(folder):
        return (400, {"error": "folder does not exist: %s" % folder})
    state = _live_state()
    if not state:
        return _start(_JsonRequest({"folder": folder}))
    rows = _add_workspace(state, folder)
    _ctx.log.info("workspace opened: %s (%d open)", folder, len(rows))
    return {"running": True, "workspaces": rows, "server": state, "embedUrl": _embed_url(state)}


def _workspaces_close(request):
    """POST workspaces/close {"folder": "/abs"} — forget a folder; the engine keeps running.

    Any workspace can go, the start folder included (the engine serves folders
    per document, it is not bound to the one it was launched with); the first
    remaining one becomes the engine's lead folder. Closing the last leaves the
    engine up with nothing open, so the next open is instant.
    """
    body = {}
    try:
        body = request.json() or {}
    except Exception:
        pass
    folder = str(body.get("folder") or "")
    state = _live_state()
    if not state:
        return {"running": False, "workspaces": []}
    folders = [f for f in _workspaces(state) if _same_dir_key(f) != _same_dir_key(folder)] if folder else _workspaces(state)
    state["workspaces"] = folders
    state["folder"] = folders[0] if folders else None
    _write_state(state)
    if _ctx is not None and _ctx.state.get("server"):
        _ctx.state["server"]["folder"] = state["folder"]
    _ctx.log.info("workspace closed: %s (%d open)", folder, len(folders))
    return {"running": True, "workspaces": _workspace_rows(state), "server": state, "embedUrl": _embed_url(state)}


class _JsonRequest:
    """A stand-in request carrying a JSON body, for one route to call another."""

    def __init__(self, body):
        self._body = body
        self.query = {}

    def json(self):
        return self._body


def _live_state():
    """The persisted server, verified alive; clears stale records."""
    state = _read_state()
    if not state:
        return None
    if _pid_alive(state.get("pid")) and _port_open(state.get("port", 0)):
        return state
    _clear_state()
    return None


# ------------------------------------------------------------------ routes

def _host_label():
    """The short host name the IDE tab is labelled with ("<host> IDE")."""
    try:
        return (socket.gethostname() or "").split(".")[0] or "this host"
    except OSError:
        return "this host"


IDLE_UNLOAD_DEFAULT_MIN = 15
IDLE_UNLOAD_CHOICES = (0, 5, 15, 30, 60)


def _idle_unload_minutes():
    """Minutes an inactive workspace document stays warm before the layer unloads it (0 = never).

    A warm document is a full workbench renderer on the client and an extension
    host plus file watcher on the host; dropping the iframe frees both at once
    (the client sends the protocol disconnect on unload). The limit is a mod
    config key so every client of this host shares it.
    """
    raw = _ctx.config.get("idle_unload_minutes") if _ctx else None
    if raw is None:
        return IDLE_UNLOAD_DEFAULT_MIN
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return IDLE_UNLOAD_DEFAULT_MIN
    return max(0, value)


def _set_idle_unload(request):
    """POST settings/idle-unload {"minutes": N} — 0 = never; shared by every client of this host."""
    body = {}
    try:
        body = request.json() or {}
    except Exception:
        pass
    try:
        minutes = int(body.get("minutes"))
    except (TypeError, ValueError, AttributeError):
        return (400, {"error": "minutes must be an integer (0 = never)"})
    if minutes < 0 or minutes > 24 * 60:
        return (400, {"error": "minutes must be 0..1440"})
    _ctx.config.set("idle_unload_minutes", minutes)
    return {"idleUnloadMinutes": minutes}


def _status(_request):
    state = _live_state()
    name, _ = _engine()
    return {
        "running": bool(state),
        "engine": name,
        "host": _host_label(),
        "server": state,
        "embedUrl": _embed_url(state),
        "workspaces": _workspace_rows(state),
        "idleUnloadMinutes": _idle_unload_minutes(),
        "health": _engine_health(state) if state else {"stuck": False, "reason": None, "silentBridges": 0, "aliveAt": None, "lastConnection": None, "lastServe": None},
        "heapMb": _engine_heap_mb(),
        "gallery": _gallery_status(),
        "proxy": {
            "registered": _proxy_registered(),
            "base": PROXY_BASE,
            "error": _proxy_state["error"],
            "inUse": bool(state and state.get("proxied")),
            # Counters the layer's wake guard reads: a document it just created
            # must raise `opened` within its budget, or it is reloaded once.
            "websockets": dict(_ws_stats),
        },
    }


def _mode_mismatch(state):
    """True when a live engine serves in a mode the proxy state no longer matches.

    An engine adopted across a gateway restart may have been launched while the
    proxy was not registered (direct-port mode, no `--server-base-path`); once
    the proxy is live that engine cannot be served same-origin and the page
    would fall back to "forward that port too". The reverse (proxied engine,
    proxy gone) is just as unreachable. Either way the engine must be relaunched.
    """
    if not state:
        return False
    if bool(state.get("proxied")) != _proxy_registered():
        return True
    # The bridge extension is provisioned at launch: an engine started by an
    # older mod (or before the extension existed) runs without it, or with a
    # stale copy, until relaunched.
    return (state.get("bridge") or None) != (_extension_version() or None)


def _extension_version():
    """Version of the bundled bridge extension, or None when the mod ships none."""
    try:
        with open(os.path.join(_mod_dir(), EXTENSION_SRC, "package.json"), "r", encoding="utf-8") as fh:
            return str(json.load(fh).get("version") or "") or None
    except (OSError, ValueError):
        return None


def _start(request):
    state = _live_state()
    if state and _mode_mismatch(state):
        # Relaunch under the current mode rather than keep an unreachable engine.
        _ctx.log.info("engine pid=%s serves in %s mode but the proxy is %s; relaunching",
                      state.get("pid"), "proxied" if state.get("proxied") else "direct",
                      "live" if _proxy_registered() else "unavailable")
        _stop(None)
        state = None
    body = {}
    try:
        body = request.json() or {}
    except Exception:
        pass
    if state:
        # Already up: a folder posted now is one more workspace on the same
        # engine (the App page's Start with a new folder), never a relaunch.
        folder = body.get("folder")
        if folder:
            folder = os.path.normpath(os.path.expanduser(str(folder)))
            if not os.path.isdir(folder):
                return (400, {"error": "folder does not exist: %s" % folder})
            _add_workspace(state, folder)
        return {"running": True, "server": state, "embedUrl": _embed_url(state),
                "workspaces": _workspace_rows(state), "note": "already running"}

    folder = os.path.expanduser(
        str(body.get("folder") or _ctx.config.get("default_folder") or "~")
    )
    if not os.path.isdir(folder):
        return (400, {"error": "folder does not exist: %s" % folder})

    name, template = _engine()
    if not template:
        return (409, {"error": "no engine found", "engines": _engines_report()})

    try:
        port = _pick_port()
    except (RuntimeError, ValueError) as error:
        return (409, {"error": str(error)})
    # A token is opt-in: it breaks iframe embedding (see the PRESETS note).
    want_token = bool(_ctx.config.get("engine.token"))
    token = secrets.token_urlsafe(24) if want_token else ""
    auth = "--connection-token " + token if want_token else "--without-connection-token"
    # With the same-origin proxy live the engine must emit its URLs under the
    # proxy path; without it, it serves from its own root on the direct port.
    proxied = _proxy_registered()
    basepath = "--server-base-path " + PROXY_BASE if proxied else ""
    extensions_dir = _provision_extension()
    extensions = "--extensions-dir " + shlex.quote(extensions_dir) if extensions_dir else ""
    _seed_machine_settings()
    _apply_gallery()  # product.json is read at engine start: aim it before launching
    # Format BEFORE splitting: `{auth}`/`{basepath}`/`{extensions}` expand to two
    # argv words (or none). The folder is shell-quoted so a path with spaces survives.
    command = shlex.split(
        template.format(port=port, token=token, auth=auth, basepath=basepath,
                        extensions=extensions, folder=shlex.quote(folder))
    )
    log_path = os.path.join(str(_ctx.data_dir), ENGINE_LOG)
    with open(log_path, "ab") as log:
        log.write(("\n--- start %s ---\n" % time.strftime("%FT%T")).encode())
        proc = subprocess.Popen(
            command, stdout=log, stderr=subprocess.STDOUT,
            cwd=folder, start_new_session=True, env=_engine_env(),
        )

    deadline = time.time() + 15
    while time.time() < deadline:
        if proc.poll() is not None:
            return (500, {"error": "engine exited with %s (see %s)"
                          % (proc.returncode, log_path)})
        if _port_open(port):
            break
        time.sleep(0.25)
    else:
        proc.terminate()
        return (500, {"error": "engine did not open port %d in time" % port})

    state = {"pid": proc.pid, "port": port, "token": token, "proxied": proxied,
             "bridge": _extension_version() if extensions_dir else None,
             "folder": folder, "engine": name, "startedAt": time.time()}
    _write_state(state)
    _remember_folder(folder)
    _ctx.state["server"] = {"port": port, "folder": folder, "engine": name}
    _ctx.log.info("engine %s started: pid=%d port=%d folder=%s",
                  name, proc.pid, port, folder)
    return {"running": True, "server": state, "embedUrl": _embed_url(state),
            "workspaces": _workspace_rows(state)}


#: V8 heap ceiling (MB) for the engine and every node child it spawns — above
#: all the EXTENSION HOSTS. Node's default is ~4 GB; on 2026-10-20 the host for
#: a large folder (a home directory: CloudFormation LSP, spell checker, Java,
#: AWS Toolkit) reached it and died ("Reached heap limit", SIGABRT), after which the
#: engine kept answering HTTP but serviced no new workbench connection — the
#: blank page that survived client reloads. A ceiling, not a reservation: memory
#: is only used when a host needs it. `engine.heap_mb` in the mod config (0 = node's default).
ENGINE_HEAP_MB_DEFAULT = 8192


def _engine_heap_mb():
    raw = _ctx.config.get("engine.heap_mb") if _ctx else None
    if raw is None:
        return ENGINE_HEAP_MB_DEFAULT
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return ENGINE_HEAP_MB_DEFAULT


def _engine_env():
    """The engine's environment: ours plus the heap ceiling in NODE_OPTIONS.

    The server passes its environment to the extension hosts unchanged (it
    only remaps VSCODE_NODE_OPTIONS for terminals), so NODE_OPTIONS on the
    engine process is the one place that reaches every host. An existing
    `--max-old-space-size` in the inherited NODE_OPTIONS is replaced, anything
    else in it is kept.
    """
    env = dict(os.environ)
    heap = _engine_heap_mb()
    if not heap:
        return env
    words = [w for w in shlex.split(env.get("NODE_OPTIONS", "")) if not w.startswith("--max-old-space-size")]
    words.append("--max-old-space-size=%d" % heap)
    env["NODE_OPTIONS"] = " ".join(words)
    return env


def _stop(_request):
    state = _read_state()
    if not state:
        return {"running": False, "note": "not running"}
    pid = state.get("pid")
    if _pid_alive(pid):
        try:
            # start_new_session=True made the engine a group leader.
            os.killpg(int(pid), signal.SIGTERM)
        except OSError:
            os.kill(int(pid), signal.SIGTERM)
        for _ in range(20):
            if not _pid_alive(pid):
                break
            time.sleep(0.25)
        if _pid_alive(pid):
            try:
                os.killpg(int(pid), signal.SIGKILL)
            except OSError:
                pass
    _clear_state()
    _ctx.state.pop("server", None)
    _ctx.log.info("engine stopped (pid=%s)", pid)
    return {"running": False}


def _relaunch(_request):
    """POST relaunch — stop the engine and start it again with the same workspaces.

    The App page's remedy for a stuck engine (status.health.stuck), and the
    cure that worked by hand on 2026-10-20. Every open workbench document
    reconnects on its own once the new engine listens.
    """
    state = _read_state()
    if not state:
        return (409, {"error": "not running"})
    folders = _workspaces(state)
    first = folders[0] if folders else state.get("folder")
    _ctx.log.info("relaunching engine pid=%s on request (%d workspace(s))", state.get("pid"), len(folders))
    _stop(None)
    result = _start(_FolderRequest(first))
    if isinstance(result, tuple):
        return result
    fresh = result.get("server")
    if fresh:
        for folder in folders[1:]:
            if os.path.isdir(folder):
                _add_workspace(fresh, folder)
        result["workspaces"] = _workspace_rows(fresh)
    # The old engine's bridges and serves say nothing about the new one.
    _html_serves.clear()
    _bridges.clear()
    _engine_alive_at["t"] = None
    result["note"] = "relaunched"
    return result


# ------------------------------------------------- merged gallery (Open VSX + Marketplace)

#: See hook/gallery.py. The service lives for the gateway process: it starts on
#: activate (or the first engine start) and the auto-installed engine's
#: product.json is pointed at it. The PORT IS STABLE across Loader reloads
#: (first free of GALLERY_PORT_BASE.., or `engine.gallery_port`; deactivate
#: closes the listener so the reload binds the same one): the running engine's
#: server-side gallery client read product.json at ITS start and would keep
#: calling a dead port otherwise, and every reload used to leave the old
#: listener behind in the gateway process (four were found on 2026-10-22).
#: Only the auto-installed engine is touched: a PATH engine's product.json is
#: not ours to edit (set engine.gallery to "openvsx" to leave even ours alone).
_gallery = {"service": None, "error": None}
_gallery_lock = threading.Lock()
GALLERY_PORT_BASE = PORT_BASE + PORT_SCAN  # just above the engine's own range


def _gallery_mode():
    raw = (_ctx.config.get("engine.gallery") if _ctx else None) or "merged"
    raw = str(raw).strip().lower()
    return raw if raw in gallery.MODES else "merged"


def _gallery_port():
    """The port the gallery binds: pinned, else the first free of its range, else any."""
    pinned = _ctx.config.get("engine.gallery_port") if _ctx else None
    if pinned:
        port = int(pinned)
        if not _port_free(port):
            raise RuntimeError("configured engine.gallery_port %d is in use" % port)
        return port
    for port in range(GALLERY_PORT_BASE, GALLERY_PORT_BASE + PORT_SCAN):
        if _port_free(port):
            return port
    return 0


def _close_leaked_galleries():
    """Shut gallery listeners that earlier module instances left serving.

    Before deactivate closed the gallery, every Loader reload left the previous
    instance's server thread alive in the gateway process (its module gone, the
    socket not). The thread is the only handle left: it is named, and its target
    is the server's own serve_forever, so the server is reachable from it.
    """
    for thread in threading.enumerate():
        if thread.name != "kirocrew-ide-gallery" or not thread.is_alive():
            continue
        server = getattr(getattr(thread, "_target", None), "__self__", None)
        if server is None or not hasattr(server, "shutdown"):
            continue
        try:
            port = server.server_address[1]
            server.shutdown()
            server.server_close()
            _ctx.log.info("gallery: closed a listener left on port %d by an earlier reload", port)
        except Exception as error:  # noqa: BLE001
            _ctx.log.warning("gallery: could not close a leaked listener: %s", error)


def _gallery_fetch(url, data, headers):
    """Upstream gallery calls go through the manifest-checked opener (hosts fixed, https only)."""
    _ctx.http.check(url)
    request = urllib.request.Request(url, data=data, headers=dict(headers, **{"User-Agent": "kirocrew-ide-mod"}))
    with urllib.request.urlopen(request, timeout=gallery.UPSTREAM_TIMEOUT) as reply:
        return reply.read()


def _engine_product_json():
    binary = _installed_engine()
    if not binary:
        return None
    path = os.path.join(os.path.dirname(os.path.dirname(binary)), "product.json")
    return path if os.path.isfile(path) else None


def _apply_gallery():
    """Start the merged gallery (once) and point the auto-installed engine's product.json at it."""
    mode = _gallery_mode()
    product = _engine_product_json()
    with _gallery_lock:
        try:
            if mode == "openvsx":
                if _gallery["service"]:
                    _gallery["service"].stop()
                    _gallery["service"] = None
                if product:
                    gallery.restore_product_json(product, _ctx.log.info)
                _gallery["error"] = None
                return None
            service = _gallery["service"]
            if service and service.mode != mode:
                service.stop()
                service = None
            if not service:
                _close_leaked_galleries()
                service = gallery.Gallery(mode, _gallery_fetch, _ctx.log.warning)
                service.start(_gallery_port())
                _gallery["service"] = service
                _ctx.log.info("merged gallery (%s) listening on %s", mode, service.service_url)
            if product:
                gallery.point_product_json(product, service.product_gallery(), _ctx.log.info)
            _gallery["error"] = None
            return service.service_url
        except Exception as error:  # noqa: BLE001 — the engine still has its own store
            _gallery["error"] = str(error)
            _ctx.log.warning("merged gallery unavailable: %s", error)
            return None


def _gallery_status():
    service = _gallery["service"]
    return {"mode": _gallery_mode(), "url": service.service_url if service else None,
            "stores": [s["id"] for s in service.stores] if service else [], "error": _gallery["error"],
            "productJson": _engine_product_json(),
            # The last requests the gallery answered (method, path, status, a
            # query's text and hit count): empty after a search means the view
            # never reached it — the page's productConfiguration is then the
            # first thing to check, not the merge.
            "recent": list(service.recent) if service else []}


# ------------------------------------------------- extensions from the Marketplace

#: The engine's own store is Open VSX (its product.json), where many Marketplace
#: extensions were never published. The App page's "Install from Marketplace URL"
#: box takes a marketplace.visualstudio.com item link (or a bare publisher.name),
#: downloads that extension's VSIX from the Marketplace's public asset endpoint
#: and installs it with the engine's own CLI into the mod's extensions dir — the
#: same thing the workbench's "Install from VSIX…" does, without the detour
#: through the user's machine. The user asks for each one by hand; nothing here
#: queries the Marketplace on its own.
MARKETPLACE_HOST = "marketplace.visualstudio.com"
MARKETPLACE_QUERY = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"
MARKETPLACE_VSIX = ("https://marketplace.visualstudio.com/_apis/public/gallery/publishers/"
                    "{publisher}/vsextensions/{name}/{version}/vspackage")
_EXT_ID_RE = re.compile(r"^([A-Za-z0-9][\w-]*)\.([A-Za-z0-9][\w-]*)$")
_ext_install = {"state": "idle"}  # idle | resolving | downloading | installing | done | error
_ext_install_lock = threading.Lock()


def _parse_marketplace_ref(text):
    """`publisher.name` from a Marketplace item URL or a bare id; None when it is neither."""
    text = (text or "").strip()
    if not text:
        return None
    match = _EXT_ID_RE.match(text)
    if match:
        return match.group(1), match.group(2)
    try:
        parsed = urllib.parse.urlparse(text)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or parsed.netloc.lower() != MARKETPLACE_HOST:
        return None
    item = urllib.parse.parse_qs(parsed.query).get("itemName", [""])[0]
    match = _EXT_ID_RE.match(item)
    return (match.group(1), match.group(2)) if match else None


def _marketplace_lookup(publisher, name):
    """The extension's display name and latest version from the Marketplace, or raises."""
    body = json.dumps({"filters": [{"criteria": [{"filterType": 7, "value": "%s.%s" % (publisher, name)}]}],
                       "flags": 914}).encode("utf-8")
    _ctx.http.check(MARKETPLACE_QUERY)
    request = urllib.request.Request(MARKETPLACE_QUERY, data=body, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json;api-version=3.0-preview.1",
        "User-Agent": "kirocrew-ide-mod"})
    with urllib.request.urlopen(request, timeout=30) as reply:
        results = json.load(reply).get("results") or []
    extensions = (results[0].get("extensions") if results else None) or []
    if not extensions:
        raise RuntimeError("%s.%s is not on the Marketplace" % (publisher, name))
    ext = extensions[0]
    versions = [v for v in ext.get("versions") or [] if not v.get("targetPlatform")] or ext.get("versions") or []
    if not versions:
        raise RuntimeError("%s.%s has no downloadable version" % (publisher, name))
    return ext.get("displayName") or name, versions[0]["version"]


def _install_marketplace_worker(publisher, name):
    try:
        display, version = _marketplace_lookup(publisher, name)
        _ext_install.update(state="downloading", display=display, version=version, bytes=0)
        url = MARKETPLACE_VSIX.format(publisher=publisher, name=name, version=version)
        root = os.path.join(str(_ctx.data_dir), "vsix")
        os.makedirs(root, exist_ok=True)
        vsix = os.path.join(root, "%s.%s-%s.vsix" % (publisher, name, version))
        with _open_checked(url, timeout=60) as reply, open(vsix, "wb") as out:
            # The endpoint answers gzip-wrapped; a VSIX is a zip, so an unzipped body is kept as is.
            data = reply.read()
            if reply.headers.get("Content-Encoding", "").lower() == "gzip" or data[:2] == b"\x1f\x8b":
                import gzip
                data = gzip.decompress(data)
            out.write(data)
            _ext_install["bytes"] = len(data)
        if not zipfile.is_zipfile(vsix):
            raise RuntimeError("the download is not a VSIX (zip) file")
        _ext_install.update(state="installing")
        binary = _installed_engine()
        if not binary and shutil.which("openvscode-server"):
            binary = shutil.which("openvscode-server")
        if not binary:
            raise RuntimeError("no openvscode-server engine to install into")
        ext_dir = os.path.join(str(_ctx.data_dir), EXTENSIONS_DIR)
        os.makedirs(ext_dir, exist_ok=True)
        proc = subprocess.run([binary, "--extensions-dir", ext_dir, "--install-extension", vsix, "--force"],
                              capture_output=True, text=True, timeout=300, env=_engine_env())
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "install failed").strip()[-600:])
        _ext_install.update(state="done", id="%s.%s" % (publisher, name), vsix=vsix,
                            note="installed; reload the workbench window to activate it")
        _ctx.log.info("marketplace extension installed: %s.%s %s", publisher, name, version)
    except Exception as error:  # noqa: BLE001 — reported through the state
        _ext_install.update(state="error", error=str(error) or type(error).__name__)
        _ctx.log.warning("marketplace extension install failed: %s.%s: %s", publisher, name, error)


def _extensions_install(request):
    """POST extensions/install {"ref": "<marketplace item URL or publisher.name>"} — one at a time."""
    body = {}
    try:
        body = request.json() or {}
    except Exception:
        pass
    ref = _parse_marketplace_ref(body.get("ref"))
    if not ref:
        return (400, {"error": "give a marketplace.visualstudio.com item link (…?itemName=publisher.name) or publisher.name"})
    with _ext_install_lock:
        if _ext_install.get("state") in ("resolving", "downloading", "installing"):
            return (409, {"error": "an extension install is already running", "install": dict(_ext_install)})
        _ext_install.clear()
        _ext_install.update(state="resolving", id="%s.%s" % ref)
        threading.Thread(target=_install_marketplace_worker, args=ref, daemon=True).start()
    return {"started": True, "install": dict(_ext_install), "note": "poll GET extensions/install for progress"}


def _extensions_install_status(_request):
    return {"install": dict(_ext_install)}


def _engines(_request):
    return _engines_report()


# ---------------------------------------------------------------- bridge

def _bridge_probe(request):
    """POST bridge/probe — the extension reports whether it reached the dashboard API; logged for the host side."""
    try:
        body = request.json() or {}
    except Exception:  # noqa: BLE001
        body = {}
    _ctx.log.info("bridge probe from the workbench: origin=%s status=%s error=%s",
                  body.get("origin"), body.get("status"), body.get("error"))
    _ctx.state["bridgeProbe"] = {"origin": body.get("origin"), "status": body.get("status"),
                                 "error": body.get("error"), "at": body.get("at")}
    return {"ok": True}


# ---------------------------------------------------------------- browse

BROWSE_LIMIT = 200
#: Names hidden from the picker unless the user types them: tool caches and VCS internals.
BROWSE_SKIP = frozenset({".git", ".hg", ".svn", "node_modules", "__pycache__", ".cache", ".venv", "venv"})


def _browse(request):
    """GET browse?path=<dir> — the directories inside `path` (default: home), for the folder picker.

    Read-only, same user as the gateway (the engine will open the folder with
    exactly these permissions anyway), dot-directories included but well-known
    caches skipped; `..` resolves through realpath so a picker can walk up.
    Also reports `suggestions`: recent workspaces (the engine's own list when it
    has one, else the last folders this mod opened) so the common case is one click.
    """
    values = (getattr(request, "query", None) or {}).get("path") or []
    raw = values[0] if isinstance(values, list) and values else (values if isinstance(values, str) else "")
    path = os.path.realpath(os.path.expanduser(str(raw or "~")))
    if not os.path.isdir(path):
        return (404, {"error": "not a directory: %s" % path, "path": path})
    entries = []
    truncated = False
    try:
        with os.scandir(path) as it:
            for entry in sorted(it, key=lambda e: e.name.lower()):
                if entry.name in BROWSE_SKIP:
                    continue
                try:
                    if not entry.is_dir(follow_symlinks=True):
                        continue
                except OSError:
                    continue
                entries.append({"name": entry.name, "path": os.path.join(path, entry.name),
                                "hidden": entry.name.startswith(".")})
                if len(entries) >= BROWSE_LIMIT:
                    truncated = True
                    break
    except PermissionError:
        return (403, {"error": "permission denied: %s" % path, "path": path})
    parent = os.path.dirname(path) if path != "/" else None
    return {"path": path, "parent": parent, "entries": entries, "truncated": truncated,
            "suggestions": _recent_folders()}


GITDIFF_LIMIT = 36000  # chars; the host caps a context entry at 40000


def _gitdiff(request):
    """GET gitdiff?path=<dir> — `git status --short` plus the working-tree diff against HEAD.

    For the chat's "# Git Diff" context: the bridge runs in the browser and
    cannot spawn git, so the mod runs it here, read-only, as the gateway user
    (the same user the engine edits the tree as). Output is truncated to fit a
    host context entry and reports whether it was.
    """
    import subprocess
    values = (getattr(request, "query", None) or {}).get("path") or []
    raw = values[0] if isinstance(values, list) and values else (values if isinstance(values, str) else "")
    path = os.path.realpath(os.path.expanduser(str(raw or "")))
    if not raw or not os.path.isdir(path):
        return (404, {"error": "not a directory: %s" % path, "path": path})

    def run(args):
        try:
            done = subprocess.run(["git", "-C", path, "-P", *args], capture_output=True, text=True, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            return "", "git %s: %s" % (" ".join(args), error)
        return done.stdout, (done.stderr.strip() if done.returncode else "")

    status, err = run(["status", "--short", "--branch"])
    if err and "not a git repository" in err:
        return (409, {"error": "not a git repository: %s" % path, "path": path})
    diff, derr = run(["diff", "HEAD", "--stat", "--patch", "--no-color"])
    text = "$ git status --short --branch\n" + status + "\n$ git diff HEAD\n" + diff
    truncated = len(text) > GITDIFF_LIMIT
    if truncated:
        text = text[:GITDIFF_LIMIT] + "\n… (truncated)\n"
    return {"path": path, "text": text, "truncated": truncated, "error": err or derr or None}


def _recent_folders():
    """Folders the user opened before (mod memory + the engine's own recent list), newest first, existing only."""
    seen = []
    mine = _ctx.state.get("recentFolders") if _ctx is not None else None
    for folder in list(mine or []):
        if folder not in seen and os.path.isdir(folder):
            seen.append(folder)
    # openvscode-server keeps its recently-opened list in the user data dir's storage.json.
    for storage in (os.path.expanduser("~/.openvscode-server/data/User/globalStorage/storage.json"),):
        try:
            with open(storage, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            raw = doc.get("history.recentlyOpenedPathsList", "")
            recent = json.loads(raw) if isinstance(raw, str) else (raw or {})
            for entry in recent.get("entries", []):
                uri = entry.get("folderUri") or ""
                if uri.startswith("file://"):
                    folder = urllib.parse.unquote(uri[len("file://"):])
                    if folder not in seen and os.path.isdir(folder):
                        seen.append(folder)
        except Exception:  # noqa: BLE001 — optional source
            pass
    return seen[:12]


def _remember_folder(folder):
    if _ctx is None:
        return
    recent = [f for f in list(_ctx.state.get("recentFolders") or []) if f != folder]
    _ctx.state["recentFolders"] = [folder] + recent[:11]


# ------------------------------------------------- same-origin proxy (raw route)

_HOP_HEADERS = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
    "content-encoding", "host",
})


def _engine_origin():
    """`http://127.0.0.1:<port>` of the running engine, or None."""
    state = _read_state()
    if not state:
        return None
    return "http://127.0.0.1:%d" % state["port"]


_LETTERPRESS_RE = re.compile(r"/media/letterpress-(dark|light|hcDark|hcLight)\.svg$")
_letterpress_cache = {}


def _fox_letterpress(variant):
    """The fox mark with the chat empty-state treatment, as the empty-editor watermark.

    Exactly what the chat webview does to the same art with CSS
    (``filter: grayscale(1)`` at low opacity): every palette fill mapped to its
    luminance grey, whole mark at 0.27 opacity, identical for all four theme
    variants. The greys keep the art's internal contrast, which the earlier
    single-grey outline lost.
    """
    cached = _letterpress_cache.get(variant)
    if cached is not None:
        return cached
    try:
        with open(os.path.join(_mod_dir(), "app", "ui", "art", "fox.svg"), "r", encoding="utf-8") as fh:
            svg = fh.read()
    except OSError:
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"/>'

    def _grey(match):
        rgb = match.group(1)
        r, g, b = (int(rgb[i:i + 2], 16) for i in (0, 2, 4))
        # CSS grayscale(1) luminance coefficients, applied to sRGB values as-is
        y = round(0.2126 * r + 0.7152 * g + 0.0722 * b)
        return 'fill="#%02x%02x%02x"' % (y, y, y)

    svg = re.sub(r'fill="#([0-9A-Fa-f]{6})"', _grey, svg)
    svg = re.sub(r"<defs>.*?</defs>", "", svg, flags=re.S)
    svg = svg.replace("<svg ", '<svg opacity="0.27" ', 1)
    body = svg.encode("utf-8")
    _letterpress_cache[variant] = body
    return body


#: The workbench settings key the endpoint is spliced in front of. serverBasePath
#: is engine-injected on every render, so it is a stable anchor.
_SETTINGS_ANCHOR = "&quot;serverBasePath&quot;"


def _inject_webview_endpoint(html, scheme, host):
    """Add ``webviewEndpoint`` to the workbench's settings meta, same-origin.

    The value must be an absolute URL (the client parses scheme+authority out
    of it); ``{{commit}}`` is left for the client to substitute. Idempotent: a
    document already carrying the key, or without the anchor, passes through
    unchanged.
    """
    marker = "&quot;webviewEndpoint&quot;"
    if marker in html or _SETTINGS_ANCHOR not in html or not host:
        return html
    endpoint = "%s://%s%s/stable-{{commit}}/static/out/vs/workbench/contrib/webview/browser/pre/" % (
        scheme, host, PROXY_BASE)
    return html.replace(_SETTINGS_ANCHOR, marker + ":&quot;" + endpoint + "&quot;," + _SETTINGS_ANCHOR, 1)


_WEB_CONFIG_RE = re.compile(r'(<meta id="vscode-workbench-web-configuration"[^>]*?data-settings=")([^"]*)(")')


def _inject_gallery(html):
    """Point the BROWSER's gallery client at the merged gallery.

    The Extensions view searches from the browser, and the browser's product
    configuration is baked into the web bundle at build time (Open VSX): the
    engine's product.json never reaches it, because openvscode-server 1.109
    serves ``productConfiguration: {}`` in the page. The workbench deep-merges
    that object over the baked product, so the page is the one place to say
    otherwise. Without this the merged gallery served only the engine's own
    (server-side) client and a Marketplace-only search in the view stayed
    empty — seen 2026-10-22 with "ikki". Idempotent; a page without the meta,
    or no gallery running, passes through unchanged.
    """
    service = _gallery["service"]
    if not service:
        return html
    match = _WEB_CONFIG_RE.search(html)
    if not match:
        return html
    try:
        config = json.loads(match.group(2).replace("&quot;", '"'))
    except ValueError:
        return html
    product = config.get("productConfiguration") or {}
    product["extensionsGallery"] = service.product_gallery()
    product["linkProtectionTrustedDomains"] = gallery.TRUSTED_DOMAINS
    config["productConfiguration"] = product
    # The engine's own encoding: JSON with the quotes entity-escaped, nothing else.
    encoded = json.dumps(config, separators=(",", ":")).replace('"', "&quot;")
    return html[:match.start(2)] + encoded + html[match.end(2):]


#: Dashboard colour scheme -> the workbench's stock theme of the same polarity.
#: Only the light/dark half is synced (the palettes differ by design); a theme
#: the user picked themselves is never touched — see the bridge's syncTheme.
SCHEME_THEMES = {"dark": "Default Dark Modern", "light": "Default Light Modern"}
THEME_FILE = "theme.json"


def _theme_path():
    return os.path.join(os.path.dirname(_state_path()), THEME_FILE)


def _read_scheme():
    """The dashboard scheme the App last reported ('dark' | 'light'), or None."""
    try:
        with open(_theme_path(), "r", encoding="utf-8") as fh:
            scheme = json.load(fh).get("scheme")
        return scheme if scheme in SCHEME_THEMES else None
    except Exception:
        return None


def _theme_get(_request):
    """GET theme — the dashboard scheme the App last reported, for the bridge's live sync."""
    return {"scheme": _read_scheme(), "themes": SCHEME_THEMES}


def _theme_set(request):
    """POST theme {scheme} — the App reports the dashboard's resolved light/dark (system already resolved)."""
    try:
        body = request.json() or {}
    except Exception:
        body = {}
    scheme = body.get("scheme") if isinstance(body, dict) else None
    if scheme not in SCHEME_THEMES:
        return (400, {"error": "scheme must be one of %s" % sorted(SCHEME_THEMES)})
    tmp = _theme_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"scheme": scheme, "at": time.time()}, fh)
    os.replace(tmp, _theme_path())
    return {"ok": True, "scheme": scheme, "theme": SCHEME_THEMES[scheme]}


def _inject_theme_default(html, scheme):
    """Make the workbench's DEFAULT colour theme match the dashboard's scheme.

    Spliced into the settings meta as ``configurationDefaults`` — a default,
    not a setting: a profile whose user picked a theme keeps it, and a stock
    profile paints in the dashboard's polarity from the first frame instead of
    flashing dark and switching once the bridge activates. Idempotent.
    """
    theme = SCHEME_THEMES.get(scheme or "")
    if not theme or "&quot;configurationDefaults&quot;" in html or _SETTINGS_ANCHOR not in html:
        return html
    block = "&quot;configurationDefaults&quot;:{&quot;workbench.colorTheme&quot;:&quot;" + theme + "&quot;},"
    return html.replace(_SETTINGS_ANCHOR, block + _SETTINGS_ANCHOR, 1)


#: Places the KiroCrew container right after the Explorer in the activity bar.
#: The order is CLIENT state (IndexedDB vscode-web-state-db-global / ItemTable /
#: workbench.activity.pinnedViewlets2), not a server setting, and the workbench
#: reads it once at boot and writes its in-memory copy back on every change —
#: so the only place a seed sticks is the served document's <head>, BEFORE the
#: workbench loads. (An extension-side write lands after the read and is
#: overwritten by the next save; that is what 0.8.2 shipped.) Seeds exactly
#: once per store, marked in the same store, so a later drag by the user is
#: respected. The engine's document carries no CSP.
#:
#: One store per VS Code PROFILE: the default profile's is
#: vscode-web-state-db-global, any other's is that plus "-<profile id>" (a
#: profile sharing UI state with the default — useDefaultFlags.globalState —
#: reads the default store). In the web workbench the profile list is owned by
#: the BROWSER, in two localStorage keys: "userDataProfiles" is the list
#: ([{location, name, icon, useDefaultFlags}], the id being the last segment
#: of location), "profileAssociations" maps workspaces to profiles
#: ({workspaces: {"<folder uri>": "<profile id>"}}). The engine's storage.json
#: is a mirror that also keeps every profile any browser ever made. The
#: profile for a load is picked from ?payload=[["profile","<name>"]] (the
#: workbench's own switch-profile reload), else the association of the folder
#: (?folder=/abs is vscode-remote://<host>/abs to the workbench), else the
#: default. The script makes the same choice from the same data, before the
#: workbench does; the server cannot (two browsers can each own a "vscode"
#: profile with different ids).
ACTIVITY_ORDER_MARK = "kirocrew-ide.activityOrderSeeded.v2"
ACTIVITY_ORDER_SCRIPT = """<script id="kirocrew-ide-order">
(function () {
  var OURS = "workbench.view.extension.kirocrew";
  var BUILTINS = ["workbench.view.explorer", "workbench.view.search", "workbench.view.scm",
                  "workbench.view.debug", "workbench.view.extensions"];
  var KEY = "workbench.activity.pinnedViewlets2";
  var MARK = "%s";
  var DB = "vscode-web-state-db-global";
  try {
    // Same choice the workbench makes at boot, from the same browser-owned list.
    var params = new URLSearchParams(location.search);
    var name = null;
    try {
      (JSON.parse(params.get("payload") || "[]") || []).forEach(function (pair) {
        if (Array.isArray(pair) && pair[0] === "profile") name = String(pair[1]);
      });
    } catch (e) { name = null; }
    var profiles = [];
    try { profiles = JSON.parse(localStorage.getItem("userDataProfiles") || "[]") || []; } catch (e) { profiles = []; }
    var assoc = {};
    try { assoc = JSON.parse(localStorage.getItem("profileAssociations") || "{}") || {}; } catch (e) { assoc = {}; }
    // A stored profile has no id field: it is the last segment of its location.
    var idOf = function (p) {
      var loc = p && p.location;
      var s = typeof loc === "string" ? loc : (loc && (loc.path || loc.external)) || "";
      return s.replace(/\\/+$/, "").split("/").pop() || null;
    };
    var chosen = null;
    if (name) {
      profiles.forEach(function (p) { if (p && p.name === name) chosen = p; });
    } else if (params.get("folder")) {
      var folder = params.get("folder").replace(/\\/+$/, "");
      var byId = {};
      profiles.forEach(function (p) { var pid = idOf(p); if (pid) byId[pid] = p; });
      Object.keys(assoc.workspaces || {}).forEach(function (key) {
        // Key is a URI string: strip scheme://authority, decode the path.
        var path = key, at = key.indexOf("://");
        if (at >= 0) { var rest = key.slice(at + 3), slash = rest.indexOf("/"); path = slash >= 0 ? rest.slice(slash) : ""; }
        try { path = decodeURIComponent(path); } catch (e) { /* keep raw */ }
        if (path.replace(/\\/+$/, "") === folder && byId[assoc.workspaces[key]]) chosen = byId[assoc.workspaces[key]];
      });
    }
    var id = idOf(chosen);
    if (id && !(chosen.useDefaultFlags && chosen.useDefaultFlags.globalState)) DB = DB + "-" + id;
  } catch (e) { DB = "vscode-web-state-db-global"; }
  try {
    var open = indexedDB.open(DB);
    // A fresh profile has no database yet: create the store exactly as the
    // workbench does (out-of-line keys), so the seed works on the FIRST boot
    // and the workbench simply finds its store already there.
    open.onupgradeneeded = function () {
      var db = open.result;
      if (!db.objectStoreNames.contains("ItemTable")) db.createObjectStore("ItemTable");
    };
    open.onsuccess = function () {
      var db = open.result;
      if (!db.objectStoreNames.contains("ItemTable")) { db.close(); return; }
      var tx = db.transaction("ItemTable", "readwrite");
      var store = tx.objectStore("ItemTable");
      var seen = store.get(MARK);
      seen.onsuccess = function () {
        if (seen.result) return;
        var get = store.get(KEY);
        get.onsuccess = function () {
          var entries = [];
          try { entries = JSON.parse(get.result || "[]"); } catch (e) { entries = []; }
          if (!Array.isArray(entries)) entries = [];
          var byId = {};
          entries.forEach(function (e) { if (e && e.id) byId[e.id] = e; });
          var order = 0;
          var out = [];
          var push = function (id) {
            var e = byId[id] || { id: id, pinned: true, visible: true };
            e.order = order++;
            out.push(e);
            delete byId[id];
          };
          push(BUILTINS[0]);        // Explorer first
          push(OURS);               // KiroCrew second
          BUILTINS.slice(1).forEach(push);
          Object.keys(byId).forEach(function (id) { var e = byId[id]; e.order = order++; out.push(e); });
          store.put(JSON.stringify(out), KEY);
          store.put("1", MARK);
        };
      };
      tx.oncomplete = function () { db.close(); };
    };
  } catch (e) { /* never break the workbench over a cosmetic order */ }
})();
</script>""" % ACTIVITY_ORDER_MARK


def _inject_activity_order(html):
    """Seed the activity-bar order in the root document's <head>. Idempotent."""
    if 'id="kirocrew-ide-order"' in html or "</head>" not in html:
        return html
    return html.replace("</head>", ACTIVITY_ORDER_SCRIPT + "</head>", 1)


#: The web workbench keeps the PROFILE LIST in the browser (localStorage
#: "userDataProfiles", per origin); the engine's storage.json is only a mirror.
#: So a profile the user imported in one client is gone from the picker in
#: another origin (browser vs desktop app, a new tunnel port) or after the
#: browser's storage is wiped (the desktop app's userData move on rename), while
#: its data sits intact under data/User/profiles/<id>/. This seed makes the list
#: origin-independent: the server reads the mirror, keeps the profiles whose
#: folder still exists (the mirror also holds ghosts of every re-creation), and
#: the browser merges those into its own list before the workbench boots —
#: adding only ids and names it does not already have, never removing. It runs
#: BEFORE the activity-order seed, which reads the same list synchronously.
#: Associations (folder -> profile) are not merged: the browser may have
#: deliberately unlinked one.
PROFILE_STORAGE_PATH = os.path.expanduser("~/.openvscode-server/data/User/globalStorage/storage.json")
PROFILE_DIRS_PATH = os.path.expanduser("~/.openvscode-server/data/User/profiles")
PROFILE_SEED_SCRIPT = """<script id="kirocrew-ide-profiles">
(function () {
  var MIRROR = %s;
  if (!MIRROR.length) return;
  try {
    var KEY = "userDataProfiles";
    var list = [];
    try { list = JSON.parse(localStorage.getItem(KEY) || "[]") || []; } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    var idOf = function (p) {
      var loc = p && p.location;
      var s = typeof loc === "string" ? loc : (loc && (loc.path || loc.external)) || "";
      return s.replace(/\\/+$/, "").split("/").pop() || null;
    };
    var ids = {}, names = {};
    list.forEach(function (p) { var i = idOf(p); if (i) ids[i] = true; if (p && p.name) names[p.name] = true; });
    var added = 0;
    MIRROR.forEach(function (p) {
      var i = idOf(p);
      if (!i || ids[i] || !p.name || names[p.name]) return;
      list.push(p); ids[i] = true; names[p.name] = true; added++;
    });
    if (added) localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) { /* storage unavailable: the workbench boots with its own list */ }
})();
</script>"""


def _mirrored_profiles(storage_path=PROFILE_STORAGE_PATH, dirs_path=PROFILE_DIRS_PATH):
    """The engine's mirrored profile list, limited to profiles whose data folder exists.

    Each entry is the stored shape ({location, name, icon?, useDefaultFlags?})
    with the location reduced to the bare id, as the workbench stores it.
    """
    try:
        with open(storage_path, encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return []
    raw = doc.get("userDataProfiles") if isinstance(doc, dict) else None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    out = []
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        loc = entry.get("location")
        if isinstance(loc, dict):
            loc = loc.get("path") or loc.get("external") or ""
        pid = str(loc or "").rstrip("/").rsplit("/", 1)[-1]
        if not pid or not os.path.isdir(os.path.join(dirs_path, pid)):
            continue
        kept = {"location": pid, "name": str(entry["name"])}
        for key in ("icon", "useDefaultFlags"):
            if entry.get(key) is not None:
                kept[key] = entry[key]
        out.append(kept)
    return out


def _inject_profile_seed(html, profiles=None):
    """Merge the engine's mirrored profiles into the browser's list, in <head>. Idempotent."""
    if 'id="kirocrew-ide-profiles"' in html or "</head>" not in html:
        return html
    if profiles is None:
        profiles = _mirrored_profiles()
    if not profiles:
        return html
    # The list lands inside a <script>: keep "</" out of the JSON text.
    payload = json.dumps(profiles, separators=(",", ":")).replace("</", "<\\/")
    return html.replace("</head>", (PROFILE_SEED_SCRIPT % payload) + "</head>", 1)


#: The profile a workspace opens in. The web workbench decides it from the URL
#: (?payload=[["profile","<name>"]], its own switch-profile reload), else from
#: the folder's association, else it is the Default profile — and nothing
#: else. The Profiles editor's "Use for New Windows" toggle writes the SETTING
#: `window.newWindowProfile` (the desktop's main process reads it when it
#: opens a window), which the web boot never consults; so a profile marked as
#: the default for new windows was ignored by every folder opened from the
#: mod. This seed reads that setting the way the workbench stores it in a web
#: client — the Default profile's `/User/settings.json` in the browser's own
#: IndexedDB user-data store (vscode-web-db / vscode-userdata-store; there is
#: no settings.json on the server) — and, for a folder with no explicit profile,
#: rewrites the URL to the payload form the workbench already understands,
#: synchronously, before the (deferred) workbench module reads location.href.
#: IndexedDB is asynchronous, so the setting is cached in localStorage
#: ("kirocrew-ide.newWindowProfile") on every load: the first load after the
#: toggle (or after the cache went stale) finishes its read and, when the answer
#: differs from the profile the page is booting into, replaces the location once
#: — one early reload, then never again for that setting. A name no profile in
#: the browser's list carries (two clients can disagree) is left alone; the
#: workbench falls back to Default as before.
NEW_WINDOW_PROFILE_KEY = "kirocrew-ide.newWindowProfile"
NEW_WINDOW_PROFILE_SCRIPT = """<script id="kirocrew-ide-new-window-profile">
(function () {
  var KEY = "%s";
  try {
    var url = new URL(location.href);
    var params = url.searchParams;
    var folder = params.get("folder") || params.get("workspace");
    if (!folder) return;
    var payload = [];
    try { payload = JSON.parse(params.get("payload") || "[]") || []; } catch (e) { payload = []; }
    if (!Array.isArray(payload)) payload = [];
    var explicit = payload.some(function (pair) { return Array.isArray(pair) && pair[0] === "profile"; });
    if (explicit) return;
    var profiles = [], assoc = {};
    try { profiles = JSON.parse(localStorage.getItem("userDataProfiles") || "[]") || []; } catch (e) { profiles = []; }
    try { assoc = JSON.parse(localStorage.getItem("profileAssociations") || "{}") || {}; } catch (e) { assoc = {}; }
    var want = folder.replace(/\\/+$/, "");
    var associated = Object.keys((assoc && assoc.workspaces) || {}).some(function (key) {
      var path = key, at = key.indexOf("://");
      if (at >= 0) { var rest = key.slice(at + 3), slash = rest.indexOf("/"); path = slash >= 0 ? rest.slice(slash) : ""; }
      try { path = decodeURIComponent(path); } catch (e) { /* keep raw */ }
      return path.replace(/\\/+$/, "") === want;
    });
    if (associated) return;  // the user chose a profile for this folder: that wins
    var known = function (name) { return !!name && profiles.some(function (p) { return p && p.name === name; }); };
    var withProfile = function (name) {
      var u = new URL(location.href);
      u.searchParams.set("payload", JSON.stringify(payload.concat([["profile", name]])));
      return u.toString();
    };
    var cached = localStorage.getItem(KEY) || "";
    var booting = "";  // the profile this document will boot into after this script
    if (known(cached)) { history.replaceState(history.state, "", withProfile(cached)); booting = cached; }
    // Refresh the cache from the Default profile's settings in the browser's user-data store.
    var open = indexedDB.open("vscode-web-db");
    open.onsuccess = function () {
      var db = open.result;
      try {
        if (!db.objectStoreNames.contains("vscode-userdata-store")) { db.close(); return; }
        var store = db.transaction("vscode-userdata-store", "readonly").objectStore("vscode-userdata-store");
        var keys = store.getAllKeys();
        keys.onsuccess = function () {
          var key = (keys.result || []).filter(function (k) { return typeof k === "string" && /^\\/User\\/settings\\.json$/.test(k); })[0];
          if (!key) { settle(""); return; }
          var get = store.get(key);
          get.onsuccess = function () {
            var raw = get.result, text = "";
            try { text = typeof raw === "string" ? raw : new TextDecoder().decode(raw); } catch (e) { text = ""; }
            // settings.json is JSONC: pick the one key out without parsing the whole file.
            var m = /"window\\.newWindowProfile"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|null)/.exec(text);
            settle(m && m[1] ? m[1] : "");
          };
          get.onerror = function () { settle(null); };
        };
        keys.onerror = function () { settle(null); };
      } catch (e) { settle(null); }
      function settle(name) {
        try { db.close(); } catch (e) { /* closed */ }
        if (name === null) return;  // could not read: keep the cache as it was
        if (name) localStorage.setItem(KEY, name); else localStorage.removeItem(KEY);
        var target = known(name) ? name : "";
        if (target === booting) return;
        // The setting disagrees with what this page booted into: boot again, once, the right way.
        location.replace(target ? withProfile(target) : (function () { var u = new URL(location.href); if (payload.length) u.searchParams.set("payload", JSON.stringify(payload)); else u.searchParams.delete("payload"); return u.toString(); })());
      }
    };
    open.onerror = function () { /* no store yet (first visit): nothing to read */ };
  } catch (e) { /* never break the workbench over the profile choice */ }
})();
</script>""" % NEW_WINDOW_PROFILE_KEY


def _inject_new_window_profile(html):
    """Honour the Profiles editor's "Use for New Windows" choice for folders opened here. Idempotent."""
    if 'id="kirocrew-ide-new-window-profile"' in html or "</head>" not in html:
        return html
    return html.replace("</head>", NEW_WINDOW_PROFILE_SCRIPT + "</head>", 1)


#: The webview host page, served same-origin once _inject_webview_endpoint is in
#: effect. Its parent-origin validation only knows the hashed-subdomain scheme.
_PRE_INDEX_SUFFIX = "/static/out/vs/workbench/contrib/webview/browser/pre/index.html"

_PRE_GUARD_OLD = "if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {"
_PRE_GUARD_NEW = "if (parentOrigin === location.origin || " \
                 "hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {"

#: The webview host registers its service worker as a MODULE worker. Per the
#: Service Worker spec a module worker's main-script fetch is made with
#: credentials mode "omit", and Chromium (so the KiroCrew desktop app) does
#: exactly that: the request for service-worker.js carries NO cookie. Behind
#: the dashboard, a cookie-less GET on a non-API path is answered with the SPA
#: shell (200, text/html), and the browser reports "Could not register service
#: worker: ... unsupported MIME type ('text/html')" — every webview blank. A
#: CLASSIC registration fetches the script with same-origin credentials, so the
#: session cookie rides along and the proxy serves the real script. The engine's
#: worker uses no module syntax (upstream's own version-mismatch fallback
#: already re-registers it classic), so nothing else changes.
_PRE_REGISTER_OLD = "navigator.serviceWorker.register(swPath, { type: 'module' })"
_PRE_REGISTER_NEW = "navigator.serviceWorker.register(swPath)"


_PRE_SCRIPT_RE = re.compile(r"(<script async type=\"module\">)(.*?)(</script>)", re.S)


def _inject_preindex_bypass(html):
    """Let the webview host page accept a SAME-ORIGIN parent.

    Upstream validates that the page is served from a hostname derived by
    hashing the embedder's origin — the cross-origin (vscode-cdn.net) scheme.
    Served same-origin, that can never hold, so webviews die with "Expected
    <hash> as hostname or subdomain". The added clause accepts the case where
    the declared parent origin IS this page's own origin. It grants nothing an
    attacker can use: ``parentOrigin`` is only ever used as the targetOrigin of
    the ready postMessage, so a foreign page embedding this frame and CLAIMING
    our origin gets a message the browser refuses to deliver to it.

    The same pass turns the module service-worker registration into a classic
    one (see _PRE_REGISTER_OLD): a module worker's script fetch omits
    credentials, so behind the dashboard's cookie auth it receives the SPA
    shell instead of the script.

    The page's own CSP meta pins the inline module script by sha256, so the
    edit re-pins it: the old hash (computed from the original script text) is
    replaced with the hash of the edited text. No CSP change beyond that.
    """
    match = _PRE_SCRIPT_RE.search(html)
    if not match or _PRE_GUARD_OLD not in match.group(2):
        return html
    original = match.group(2)
    edited = original.replace(_PRE_GUARD_OLD, _PRE_GUARD_NEW, 1)
    edited = edited.replace(_PRE_REGISTER_OLD, _PRE_REGISTER_NEW, 1)

    def _csp_hash(text):
        return "'sha256-%s'" % base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")

    html = html[:match.start(2)] + edited + html[match.end(2):]
    return html.replace(_csp_hash(original), _csp_hash(edited), 1)


# ---------------------------------------------------------- proxy request log

#: Last proxied requests (newest last): what the workbench actually asked for
#: through the same-origin route — the wait-and-click diagnostic for anything
#: that renders blank in a real browser. Read via GET debug/proxylog.
_proxy_log = collections.deque(maxlen=300)

#: WebSocket bridge counters since this module loaded (status.proxy.websockets):
#: `opened` upgrades that reached the engine, `failed` ones the engine refused
#: or never answered, `live` bridges open right now.
_ws_stats = {"opened": 0, "failed": 0, "live": 0}


def _log_proxied(method, path, status, note=""):
    _proxy_log.append({"ts": round(time.time(), 3), "method": method, "path": path[:200],
                       "status": status, "note": note})


#: Stuck-engine detection. An engine whose extension host died (OOM → SIGABRT,
#: 2026-10-20) kept answering HTTP — `status.running` stayed true, the workbench
#: HTML and assets were served — but serviced no new WebSocket: its log gained no
#: "New connection established" for any later load, and the page stayed blank
#: through every client reload. The signal is therefore: a workbench document
#: was served (the proxy sees the HTML) and, STUCK_AFTER_S later, the engine's
#: own log still records no connection newer than that serve. Read from the
#: engine log on each status poll (tail only), never from the socket: a healthy
#: engine and a stuck one look identical at handshake time.
STUCK_AFTER_S = 25.0
_ENGINE_CONN_RE = re.compile(rb"^\[(\d\d):(\d\d):(\d\d)\] \[[^\]]*\]\[[^\]]*\]\[ManagementConnection\] New connection established\.", re.M)
_ENGINE_TAIL_BYTES = 256 * 1024
#: Wall-clock stamps of workbench HTML serves since the engine started (newest last).
_html_serves = collections.deque(maxlen=50)
#: One record per WebSocket bridge the proxy carried (newest last): when it opened,
#: frames each way, and how it ended. THIS is what the stuck verdict reads. The
#: first cut read the engine log for "New connection established" and raised
#: false alarms: a workbench that reconnects after a relaunch is logged as
#: "Unknown reconnection token" (alive, answering, not matched), a background tab
#: or a wake-reload can fetch the HTML and never connect, and the log is only
#: written when something happens. The bridge sees the truth directly: a live
#: engine answers a client's first frames within a second; the 2026-10-20 engine
#: accepted the handshake and then sent nothing, ever.
_bridges = collections.deque(maxlen=64)
#: Last moment the engine proved alive on any bridge (a frame to a client, or
#: closing a socket itself); None since this module loaded / the last relaunch.
_engine_alive_at = {"t": None}


def _last_engine_connection(log_path, now=None):
    """Epoch seconds of the newest 'New connection established' in the engine log's tail, or None.

    The engine stamps lines with a local wall-clock HH:MM:SS only; the date is
    taken from the file's mtime (the line is within the tail of what was last
    written), with a midnight wrap when the stamp is later than the mtime's time.
    """
    try:
        size = os.path.getsize(log_path)
        with open(log_path, "rb") as fh:
            fh.seek(max(0, size - _ENGINE_TAIL_BYTES))
            tail = fh.read()
        mtime = os.path.getmtime(log_path)
    except OSError:
        return None
    # The log is appended across engine restarts (`_start` writes a "--- start"
    # marker): only the current engine's section counts, or a connection the
    # previous engine accepted would pass for one of this engine's.
    marker = tail.rfind(b"\n--- start ")
    if marker >= 0:
        tail = tail[marker:]
    matches = _ENGINE_CONN_RE.findall(tail)
    if not matches:
        return None
    h, m, s = (int(x) for x in matches[-1])
    day = time.localtime(mtime)
    stamp = time.mktime((day.tm_year, day.tm_mon, day.tm_mday, h, m, s, 0, 0, -1))
    if stamp > mtime + 5:  # the line was written before midnight, the mtime after
        stamp -= 86400
    return stamp


def _engine_health(state, now=None):
    """{'stuck', 'reason', 'silentBridges', 'aliveAt', 'lastConnection', 'lastServe'}.

    Stuck when some bridge opened since the engine started is STUCK_AFTER_S old,
    still open, has carried frames FROM the client and none back, and the engine
    has shown no life on any bridge (a frame down, or closing a socket itself)
    for STUCK_AFTER_S. A bridge the engine closed is a live engine's answer; a
    bridge whose client never spoke proves nothing. Bridges from before the
    engine started are ignored (a relaunch clears the condition by itself).
    `lastConnection` (engine log) and `lastServe` ride along as diagnostics only.
    """
    now = time.time() if now is None else now
    started = float(state.get("startedAt") or 0) if state else 0
    serves = [t for t in _html_serves if t >= started]
    last_serve = serves[-1] if serves else None
    alive_at = _engine_alive_at["t"]
    if alive_at is not None and alive_at < started:
        alive_at = None
    silent = [b for b in _bridges
              if b["opened"] >= started and not b["closed"] and now - b["opened"] >= STUCK_AFTER_S
              and b["up"] > 0 and b["down"] == 0]
    stuck = bool(silent) and (alive_at is None or now - alive_at >= STUCK_AFTER_S)
    reason = None
    if stuck:
        oldest = min(b["opened"] for b in silent)
        reason = ("the workbench connected %ds ago and the engine has not answered it since; "
                  "its extension host may have died (see engine.log). Relaunch the engine." % int(now - oldest))
    last_conn = _last_engine_connection(os.path.join(str(_ctx.data_dir), ENGINE_LOG)) if _ctx else None
    return {"stuck": stuck, "reason": reason, "silentBridges": len(silent), "aliveAt": alive_at,
            "lastConnection": last_conn, "lastServe": last_serve}


def _debug_proxylog(_request):
    return {"entries": list(_proxy_log), "count": len(_proxy_log),
            "hint": "newest last; note=ws marks websocket upgrades, letterpress the served watermark"}


#: How long the engine gets to accept a WebSocket upgrade before the browser is
#: told the proxy could not reach it (a loopback connect is milliseconds).
WS_UPSTREAM_TIMEOUT_S = 10.0

#: Request headers that belong to THIS hop's upgrade handshake; aiohttp's client
#: writes its own for the upstream one.
_WS_HANDSHAKE_HEADERS = frozenset(("sec-websocket-key", "sec-websocket-version",
                                   "sec-websocket-extensions", "upgrade", "connection"))


async def _proxy_websocket(request, target, headers):
    """Bridge one browser WebSocket to the engine, failing LOUDLY.

    Order matters: the engine side is connected FIRST, and only then is the
    browser's upgrade accepted. The previous shape accepted the browser first
    and swallowed every error, so an upstream connect that failed or hung
    became a socket that opened and silently closed — the workbench then sat
    on a blank page with no error and no reconnect, and the proxy log recorded
    the upgrade as a 101 success. Now an unreachable engine answers 502 before
    any upgrade (the workbench's own connection-failure path shows its error
    and retries), and the log carries what actually happened:
    `ws` on success with the session's duration on close, `ws-upstream-failed`
    with the error otherwise.
    """
    import aiohttp
    from aiohttp import web

    ws_target = "ws://" + target.split("://", 1)[1]
    upstream_headers = {k: v for k, v in headers.items() if k.lower() not in _WS_HANDSHAKE_HEADERS}
    session = aiohttp.ClientSession()
    try:
        upstream = await asyncio.wait_for(
            session.ws_connect(ws_target, headers=upstream_headers, max_msg_size=0, autoping=True),
            timeout=WS_UPSTREAM_TIMEOUT_S,
        )
    except Exception as error:  # noqa: BLE001 — reported, not swallowed
        await session.close()
        _ws_stats["failed"] += 1
        _log_proxied(request.method, request.path, 502, note="ws-upstream-failed: %s" % (error or type(error).__name__))
        _ctx.log.warning("websocket upstream %s failed: %r", ws_target.split("?")[0], error)
        return web.Response(status=502, content_type="text/plain",
                            text="KiroCrew IDE proxy: the engine did not accept the connection (%s)" % (error or type(error).__name__))

    client_ws = web.WebSocketResponse(protocols=("vscode",), max_msg_size=0)
    started = time.time()
    _ws_stats["opened"] += 1
    _ws_stats["live"] += 1
    bridge = {"opened": started, "up": 0, "down": 0, "closed": None, "closedBy": None}
    _bridges.append(bridge)
    _log_proxied(request.method, request.path, 101, note="ws")
    try:
        await client_ws.prepare(request)

        async def pump(source, sink, direction):
            async for message in source:
                if message.type == aiohttp.WSMsgType.TEXT:
                    await sink.send_str(message.data)
                elif message.type == aiohttp.WSMsgType.BINARY:
                    await sink.send_bytes(message.data)
                else:
                    break
                bridge[direction] += 1
                if direction == "down":
                    _engine_alive_at["t"] = time.time()
            # The source ended: whoever stopped talking closed this bridge.
            if bridge["closedBy"] is None:
                bridge["closedBy"] = "engine" if direction == "down" else "client"
                if direction == "down":
                    _engine_alive_at["t"] = time.time()

        pumps = [asyncio.create_task(pump(upstream, client_ws, "down")), asyncio.create_task(pump(client_ws, upstream, "up"))]
        _, pending = await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        # The surviving pump is cancelled and awaited: left alone it would later
        # raise into nobody's hands ("Task exception was never retrieved" with
        # ClientConnectionResetError, the recurring crash.log entry).
        for task in pending:
            task.cancel()
        for task in pumps:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 — a dropped socket is normal
                pass
    except Exception:  # noqa: BLE001 — a dropped socket is normal
        pass
    finally:
        try:
            await upstream.close()
        except Exception:  # noqa: BLE001
            pass
        await session.close()
        if not client_ws.closed:
            try:
                await client_ws.close()
            except Exception:  # noqa: BLE001
                pass
        _ws_stats["live"] = max(0, _ws_stats["live"] - 1)
        bridge["closed"] = time.time()
        _log_proxied(request.method, request.path, 101, note="ws-closed after %.1fs by %s (%d up, %d down)"
                     % (bridge["closed"] - started, bridge["closedBy"] or "proxy", bridge["up"], bridge["down"]))
    return client_ws


async def _proxy(request):
    """Reverse-proxy the workbench, WebSockets included, on the dashboard origin."""
    import aiohttp
    from aiohttp import web

    origin = _engine_origin()
    if not origin:
        return web.Response(
            status=503, content_type="text/plain",
            text="KiroCrew IDE: no engine running — start it from the KiroCrew IDE app.",
        )
    # The empty-editor watermark ("letterpress"): the workbench fetches one of
    # four SVGs from out/media/; answer those with the greyscale FloofyCrew fox
    # instead. Served here, not patched into the engine, so an engine update
    # changes nothing and nothing of the engine's is modified.
    letterpress = _LETTERPRESS_RE.search(request.path)
    if letterpress:
        # no-cache: the engine served these with an immutable cache before this
        # feature existed, and a cached copy must not pin the old artwork again.
        _log_proxied(request.method, request.path, 200, note="letterpress")
        return web.Response(body=_fox_letterpress(letterpress.group(1)), content_type="image/svg+xml",
                            headers={"Cache-Control": "no-cache"})
    target = origin + request.raw_path  # raw: keeps the base path and query verbatim
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_HEADERS}

    # The workbench ROOT document: fetch whole, point its webviews at OUR
    # origin, serve rewritten. The engine's product.json aims webviews at
    # https://{{uuid}}.vscode-cdn.net — a third-party origin that browsers with
    # strict storage partitioning (and the KiroCrew desktop app) refuse to run
    # a service worker in, which renders every webview blank. The workbench
    # honours options.webviewEndpoint over that template, and the engine serves
    # the same pre/ files itself, so same-origin is strictly more robust.
    if request.method == "GET" and request.path.rstrip("/") == PROXY_BASE:
        session = aiohttp.ClientSession()
        try:
            upstream = await session.get(target, headers=headers, allow_redirects=False)
            status = upstream.status
            ctype = upstream.headers.get("Content-Type", "text/html")
            body = await upstream.text()
        except Exception as error:  # noqa: BLE001
            await session.close()
            return web.Response(status=502, content_type="text/plain",
                                text="KiroCrew IDE proxy: %s" % error)
        await session.close()
        if status == 200 and "html" in ctype:
            scheme = request.headers.get("X-Forwarded-Proto") or request.scheme
            body = _inject_webview_endpoint(body, scheme, request.headers.get("Host") or request.host)
            body = _inject_gallery(body)  # the browser's gallery client reads the page, not product.json
            body = _inject_profile_seed(body)  # before the order seed: it reads the merged list
            body = _inject_new_window_profile(body)  # after the list seed (it needs the names), before the order seed (it reads the payload)
            body = _inject_activity_order(body)
            # The App passes the dashboard's scheme on the frame URL (fresh at
            # every load); the file it also posts to is the fallback.
            body = _inject_theme_default(body, request.query.get("kideScheme") or _read_scheme())
        _log_proxied(request.method, request.path, status, note="workbench-html")
        if status == 200:
            _html_serves.append(time.time())  # the stuck-engine check's "a document loaded" mark
        return web.Response(status=status, text=body, content_type=ctype.split(";")[0].strip() or "text/html",
                            headers={"Cache-Control": "no-cache"})

    # The webview host page (see _inject_preindex_bypass): fetched whole so the
    # same-origin parent check can be added; everything else it needs
    # (service-worker.js, fake.html, main.js) streams through untouched.
    if request.method == "GET" and request.path.endswith(_PRE_INDEX_SUFFIX):
        session = aiohttp.ClientSession()
        try:
            upstream = await session.get(target, headers=headers, allow_redirects=False)
            status = upstream.status
            body = await upstream.text()
        except Exception as error:  # noqa: BLE001
            await session.close()
            return web.Response(status=502, content_type="text/plain",
                                text="KiroCrew IDE proxy: %s" % error)
        await session.close()
        if status == 200:
            body = _inject_preindex_bypass(body)
        _log_proxied(request.method, request.path, status, note="webview-pre")
        return web.Response(status=status, text=body, content_type="text/html",
                            headers={"Cache-Control": "no-cache"})

    # WebSocket (the workbench's extension-host channel)
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await _proxy_websocket(request, target, headers)

    # Plain HTTP, streamed both ways
    session = aiohttp.ClientSession(auto_decompress=False)
    try:
        upstream = await session.request(
            request.method, target, headers=headers,
            data=request.content, allow_redirects=False,
        )
    except Exception as error:  # noqa: BLE001
        await session.close()
        return web.Response(status=502, content_type="text/plain",
                            text="KiroCrew IDE proxy: %s" % error)
    _log_proxied(request.method, request.path, upstream.status)
    response = web.StreamResponse(status=upstream.status, reason=upstream.reason)
    for key, value in upstream.headers.items():
        if key.lower() not in _HOP_HEADERS:
            response.headers[key] = value
    await response.prepare(request)
    try:
        async for chunk in upstream.content.iter_chunked(64 * 1024):
            await response.write(chunk)
        await response.write_eof()
    finally:
        upstream.release()
        await session.close()
    return response


async def _proxy_trampoline(request):
    """Dispatch to the NEWEST hook module's `_proxy`.

    The aiohttp route is registered once, at gateway start, and captures its
    handler for the process's lifetime — but a `floofy install --now` re-imports
    this module with new code. Resolving `_proxy` through `sys.modules` at call
    time means a mod update takes effect on the next request instead of waiting
    for the next gateway restart (the 0.8.0 letterpress/order features would
    otherwise sit dormant). Falls back to this module's own `_proxy`.
    """
    handler = _proxy
    for name, module in list(sys.modules.items()):
        if name.startswith("floofy_mods.") and name.endswith(".hook") and "kirocrew" in name:
            candidate = getattr(module, "_proxy", None)
            if callable(candidate):
                handler = candidate
    return await handler(request)


def _add_proxy_route(result, *args, **kwargs):
    """`after` hook on the host's app-route registration: add our raw route.

    The host passes the aiohttp application; the router is still open at that
    point, so this is the one place a mod can add a WebSocket-capable route.
    """
    app = args[0] if args else kwargs.get("app")
    try:
        app.router.add_route("*", PROXY_BASE, _proxy_trampoline)
        app.router.add_route("*", PROXY_BASE + "/{path:.*}", _proxy_trampoline)
        _proxy_state["registered"] = True
        host_routes = sys.modules.get(ROUTES_MODULE)
        if host_routes is not None:      # survives a reload of this module
            setattr(host_routes, PROXY_RECORD_ATTR,
                    {"registered": True, "base": PROXY_BASE, "pid": os.getpid()})
    except Exception as error:  # noqa: BLE001 — never break host startup
        _proxy_state["error"] = str(error)
    return result


#: The host module whose route registration we wrap.
ROUTES_MODULE = "kiro_crew.apps.routes"


def _wrap_register(module):
    """Replace `register_app_routes` on an already-executed host module."""
    original = getattr(module, "register_app_routes", None)
    if original is None or getattr(original, "__floofy_ide__", False):
        return

    def wrapper(app, *args, **kwargs):
        result = original(app, *args, **kwargs)
        _add_proxy_route(result, app)
        return result

    wrapper.__floofy_ide__ = True
    wrapper.__wrapped__ = original      # the original stays recoverable
    module.register_app_routes = wrapper


class _LazyArmer:
    """A meta-path finder that wraps `ROUTES_MODULE` as the HOST imports it.

    Importing a host module from `early()` is unsafe: at that moment the host's
    package graph is only half-initialised, so pulling
    `kiro_crew.apps.routes` (→ bridges → cron_sdk → … → platform) raises a
    circular ImportError AND leaves partially initialised modules in
    `sys.modules`, which then breaks the host's own later imports — it takes
    down the `kirocrew` CLI, not just this mod. So nothing is imported here.
    This finder only reacts when the host itself imports that module, at which
    point its parent package is already in `sys.modules` and `path` is the
    parent's `__path__` — so `PathFinder` resolves it without importing
    anything. It wraps the loader's `exec_module` to patch the module the
    instant it finishes executing, then removes itself. One shot, fail-open.
    """

    def __init__(self, log):
        self._log = log
        self._busy = False

    def find_spec(self, fullname, path=None, target=None):
        if fullname != ROUTES_MODULE or self._busy:
            return None
        try:
            from importlib.machinery import PathFinder

            self._busy = True
            try:
                spec = PathFinder.find_spec(fullname, path)
            finally:
                self._busy = False
            if spec is None or spec.loader is None:
                return None
            loader = spec.loader
            original_exec = loader.exec_module

            def exec_module(module, _original=original_exec):
                _original(module)
                try:
                    _wrap_register(module)
                    _proxy_state["armed"] = True
                    self._log("same-origin proxy armed at %s" % PROXY_BASE)
                except Exception as error:  # noqa: BLE001
                    _proxy_state["error"] = "wrap failed: %s" % error
                finally:
                    self._remove()

            loader.exec_module = exec_module
            return spec
        except Exception as error:  # noqa: BLE001 — never break a host import
            _proxy_state["error"] = "armer failed: %s" % error
            self._remove()
            return None

    def _remove(self):
        try:
            sys.meta_path.remove(self)
        except ValueError:
            pass


def early(ctx):
    """Runs before the host composes the gateway (part `"early": true`).

    The early shim's context is deliberately minimal — `mod_id`, `mod_dir`,
    `host_home`, `data_home`, `bootstrap`, `state` and a `log(message)`
    CALLABLE (no `ctx.hooks`, no `ctx.data_dir`; those belong to `activate`).
    This function imports NO host module: see `_LazyArmer`.
    """
    _data_dir_hint["path"] = os.path.join(
        str(ctx.data_home), "mods", ctx.mod_id, ".floofy"
    )
    try:
        already = sys.modules.get(ROUTES_MODULE)
        if already is not None:          # host got there first: patch in place
            _wrap_register(already)
            _proxy_state["armed"] = True
            ctx.log("same-origin proxy armed at %s (module present)" % PROXY_BASE)
            return
        sys.meta_path.insert(0, _LazyArmer(ctx.log))
        ctx.log("same-origin proxy will arm when the host builds its routes")
    except Exception as error:  # noqa: BLE001 — must never break host startup
        _proxy_state["error"] = "early failed: %s" % error
        ctx.log("same-origin proxy NOT armed: %s" % error)


# --------------------------------------------------------------- lifecycle

def activate(ctx):
    global _ctx
    _ctx = ctx
    ctx.routes.add("GET", "status", _status)
    ctx.routes.add("POST", "start", _start)
    ctx.routes.add("POST", "stop", _stop)
    ctx.routes.add("POST", "relaunch", _relaunch)
    ctx.routes.add("POST", "workspaces/open", _workspaces_open)
    ctx.routes.add("POST", "workspaces/close", _workspaces_close)
    ctx.routes.add("POST", "settings/idle-unload", _set_idle_unload)
    ctx.routes.add("GET", "engines", _engines)
    ctx.routes.add("POST", "engines/install", _engines_install)
    ctx.routes.add("POST", "extensions/install", _extensions_install)
    ctx.routes.add("GET", "extensions/install", _extensions_install_status)
    ctx.routes.add("GET", "browse", _browse)
    ctx.routes.add("GET", "gitdiff", _gitdiff)
    ctx.routes.add("GET", "theme", _theme_get)
    ctx.routes.add("POST", "theme", _theme_set)
    ctx.routes.add("POST", "bridge/probe", _bridge_probe)
    ctx.routes.add("GET", "debug/proxylog", _debug_proxylog)
    state = _live_state()
    if state and _mode_mismatch(state):
        # Typically: the engine predates the gateway restart that armed the
        # proxy. Relaunch it in the same folder so the page never has to ask
        # for a second port forward. The workbench itself reconnects.
        folder = state.get("folder")
        ctx.log.info("adopted engine pid=%s serves in %s mode but the proxy is %s; relaunching in %s",
                     state.get("pid"), "proxied" if state.get("proxied") else "direct",
                     "live" if _proxy_registered() else "unavailable", folder)
        _stop(None)
        result = _start(_FolderRequest(folder))
        state = result[1].get("server") if isinstance(result, tuple) else result.get("server")
        if not state:
            ctx.log.warning("relaunch failed: %s", result)
    if state:
        ctx.state["server"] = {"port": state["port"], "folder": state["folder"],
                               "engine": state.get("engine")}
        ctx.log.info("adopted running engine: pid=%s port=%s proxied=%s",
                     state["pid"], state["port"], state.get("proxied"))
        # The registry entry is rewritten with the current hook's metadata so a
        # fix to it (0.14.2: application scope, without which the bridge is
        # missing from every non-default profile) applies to the adopted engine
        # too; the extension folder itself is left alone.
        if _reregister_extension():
            ctx.log.info("bridge extension re-registered for the adopted engine")
    # The gallery's port is per gateway process; a running engine read the old
    # one from product.json at ITS start. Re-point the file now (the Extensions
    # view reads serviceUrl from the server's product on each window load), and
    # let the status say whether a relaunch is still needed.
    _apply_gallery()
    ctx.log.info("KiroCrew IDE hook active (engine=%s)", _engine()[0])


class _FolderRequest:
    """The minimal request `_start` reads when the hook relaunches an engine itself."""

    def __init__(self, folder):
        self._folder = folder

    def json(self):
        return {"folder": self._folder} if self._folder else {}


def deactivate(ctx):
    # Deliberately leaves a running engine alone: a Loader reload or host
    # update must not close the user's editor. `POST stop` is the off switch.
    # The gallery listener IS closed: it belongs to this module instance, and
    # the reloaded one rebinds the same port (product.json stays valid).
    global _ctx
    with _gallery_lock:
        service = _gallery["service"]
        _gallery["service"] = None
    if service:
        try:
            service.stop()
        except Exception:  # noqa: BLE001
            pass
    _ctx = None
