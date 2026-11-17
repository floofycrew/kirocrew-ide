"""Direct KAS modes: the hook as an ACP client of ``kiro-cli acp --agent-engine v3``.

Kiro's real Spec, Quick Spec, Bug Fix and Plan engines live in KAS, the bundle
``kiro-cli`` runs. They cannot be reached through the KiroCrew gateway (it
rewrites the built-in agent ids), so this module lets the hook, which already
runs inside the gateway process, own ONE ``kiro-cli acp`` child per open
workspace and speak the Agent Client Protocol (newline-delimited JSON-RPC 2.0
over stdio) to it directly. The IDE bridge reaches it over a WebSocket on the
same-origin proxy path (``/kirocrew-ide/_kirocrew/kas/ws``, see
``handle_ws``), so no new port is forwarded and no process runs on the client.

Pieces, bottom up:

* :class:`SessionLog` -- the per-session ring of relayed frames (sequence
  numbers, 2000 messages / 4 MB) plus an ndjson copy on disk, so a bridge that
  reconnects asks for ``seq > lastSeq`` and a transcript outlives the child.
* :class:`AcpClient` -- the JSON-RPC plumbing: id counter, pending map, one
  reader task, server->client requests routed to a callback, child exit.
* :class:`Child` -- one ``kiro-cli acp`` process for one workspace: its
  sessions, parked permission/userInput requests, Autopilot auto-answers, the
  ``fs/*`` methods KAS needs when the client advertises them, the ``turnEnd``
  frames, and the fan-out to attached bridges.
* :class:`KasManager` -- children by workspace hash, folder validation against
  the engine's open workspaces, kiro-cli resolution and the version check,
  the idle timer, the session index, and the status report.
* :func:`handle_ws` -- the Kas_Link: validates each bridge frame, dispatches the
  ``hello/new/attach/prompt/cancel/config/answer/spec`` ops to the manager.

Facts this code leans on were measured, not assumed (the spec's design
§Probe results, kiro-cli 2.22.1 and 3.3.0): the spec feature gates are read
from ``clientCapabilities._meta.kiro``; ``kiro-cli acp`` does not exit when
stdin closes and must be SIGTERMed; an advertised ``fs`` capability must be
implemented or spec writes fall back to the shell and ``phaseCheckpoint``
never fires; ``session/request_permission`` can arrive in duplicate bursts and
each needs an answer; a second process may ``session/load`` a session but may
not drive it while the owner lives (``SessionHeldElsewhereError``), so a
crashed hook's orphan child blocks the next one and pids are tracked;
``_kiro/spec/invoke`` has no completion response, ``session_info_update`` with
``_meta.kiro.kind == "turn_end"`` is the signal; not-logged-in is a ``-32000``
error on ``session/new`` whose text names ``kiro-cli login``.

Security posture: the child is spawned with cwd = the workspace folder, the
gateway's own environment and ``--auth-method cli`` (KAS reads the kiro-cli
login itself; nothing is minted here and nothing crosses the bridge). The
folder is validated against the engine's open workspaces before any process
starts. The WebSocket sits under the host's session middleware (an
unauthenticated upgrade never reaches the proxy, measured 2026-11-17) and
additionally checks the upgrade's ``Origin`` against the request host. Every
bridge frame is validated (op allowlist, field types, length caps) before it
touches the child.
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import time

# ------------------------------------------------------------------ constants

#: How long ``initialize`` may take; nothing else times out (a prompt runs as long as it runs).
INIT_TIMEOUT_S = 30.0
#: Frame_Buffer caps (requirement 2.6).
BUFFER_MAX_MESSAGES = 2000
BUFFER_MAX_BYTES = 4 * 1024 * 1024
#: The on-disk copy is truncated to its newest bytes when a log is reopened.
NDJSON_MAX_BYTES = 8 * 1024 * 1024
#: Stderr tail kept per workspace.
STDERR_LOG_MAX_BYTES = 1024 * 1024
#: Minutes a child with no bridge attached and no running turn lives (``kas.idle_minutes``; 0 = never).
IDLE_MINUTES_DEFAULT = 30
#: SIGTERM -> this long -> SIGKILL.
STOP_GRACE_S = 5.0
#: Caps on what a bridge may send in one frame.
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_TEXT_FIELD = 512
#: The feature gates Kiro IDE turns on (design §Observed facts); sent at both
#: placements, KAS 2.22.1 and 3.3.0 read ``clientCapabilities._meta.kiro``.
KIRO_META = {"specPhaseCheckpoints": True, "requirementsAnalysis": True, "specLinks": True, "userInput": True}
CLIENT_INFO = {"name": "kirocrew-ide", "version": "mod"}
#: The ``session/new`` error text when kiro-cli has no login (3.3.0: "Authentication
#: required. Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.").
LOGIN_RE = re.compile(r"not logged in|authentication required|kiro-cli login", re.I)
#: KAS notifications relayed to the workspace's bridges without buffering (spec events).
SPEC_EVENTS = frozenset(("_kiro/spec/taskStatusChanged", "_kiro/spec/phaseCheckpoint"))
#: Server->client requests the hook answers itself or parks.
PERMISSION_METHOD = "session/request_permission"
USER_INPUT_METHOD = "_kiro/userInput"
#: Bridge ops and the fields each must carry (name -> expected type).
OPS = {
    "hello": {"folder": str},
    "new": {"mode": str},
    "attach": {"sessionId": str},
    "prompt": {"sessionId": str, "blocks": list},
    "cancel": {"sessionId": str},
    "config": {"sessionId": str},
    "answer": {"requestId": (int, str)},
    "spec": {"method": str, "params": dict},
    "close": {"sessionId": str},
}
SPEC_METHODS = frozenset(("_kiro/spec/resolveSession", "_kiro/spec/invoke", "_kiro/spec/getTaskStatuses"))
#: ``_kiro/spec/invoke`` operations that run tasks: the Hook turns Autopilot on first (requirement 5.3).
AUTOPILOT_OPERATIONS = frozenset(("executeTask", "runAllTasks"))
JSONRPC = "2.0"
#: Where kiro-cli's own installer puts it when PATH does not carry it.
HOME_CLI = "~/.local/bin/kiro-cli"
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


def ws_hash(folder):
    """KAS's workspace key: the first 16 hex of sha256 over the path handed to ``session/new``.

    Measured on 2.22.1 and 3.3.0 (``~/.kiro/sessions/<hash>/`` appeared for the
    probe's folder). The hook always passes the real path, so the two agree.
    """
    return hashlib.sha256(str(folder).encode("utf-8")).hexdigest()[:16]


def real_folder(folder):
    return os.path.realpath(os.path.expanduser(str(folder))).rstrip("/") or "/"


def ws_hashes(folder):
    """Every workspace hash a folder may sit under in KAS's stores, the spelling KAS was given first.

    KAS hashes the path exactly as it received it: ``session/new {cwd}`` gets the
    hook's real path, but ``_kiro/spec/resolveSession {workspacePaths}`` gets the
    IDE's own spelling, which on a desk whose home is a symlink
    (``/home/x`` → ``/local/home/x``) differs. Measured 2026-11-17 on
    dev-dsk-testing: the spec session and ``~/.kiro/tasks`` landed under the
    ``/home`` spelling while the child's sessions sat under ``/local/home``.
    """
    out = []
    for p in (os.path.expanduser(str(folder)).rstrip("/") or "/", real_folder(folder)):
        h = ws_hash(p)
        if h not in out:
            out.append(h)
    return out


def _now():
    return time.time()


class AcpError(Exception):
    """A JSON-RPC error reply, or a request the child could not answer (exit)."""

    def __init__(self, code, message, data=None):
        super().__init__("%s (%s)" % (message, code))
        self.code = code
        self.message = message
        self.data = data

    def to_dict(self):
        out = {"code": self.code, "message": self.message}
        if self.data is not None:
            out["data"] = self.data
        return out


# ---------------------------------------------------------------- SessionLog

class SessionLog:
    """One session's relayed frames: a bounded ring in memory and an ndjson copy on disk.

    ``append(frame)`` stamps the next sequence number onto the frame (a dict),
    keeps it while the ring is under both caps and writes it to the ndjson
    file. ``replay(since)`` is every kept frame with ``seq > since``;
    ``first_seq`` tells a bridge whose ``since`` is older than the ring whether
    it must redraw from scratch. The log file is append-only and truncated to
    its newest ``NDJSON_MAX_BYTES`` when reopened, so the transcript route and
    a gateway restart (which loses the ring) still have the history.
    """

    def __init__(self, session_id, path=None, max_messages=BUFFER_MAX_MESSAGES, max_bytes=BUFFER_MAX_BYTES):
        self.session_id = session_id
        self.path = path
        self.max_messages = max_messages
        self.max_bytes = max_bytes
        self.frames = collections.deque()
        self.bytes = 0
        self.first_seq = 1       # the oldest seq still in the ring (1 while nothing was dropped)
        self.last_seq = 0
        self._fh = None
        if path:
            self._open()

    def _open(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        try:
            size = os.path.getsize(self.path)
        except OSError:
            size = 0
        if size > NDJSON_MAX_BYTES:
            with open(self.path, "rb") as fh:
                fh.seek(size - NDJSON_MAX_BYTES)
                tail = fh.read()
            cut = tail.find(b"\n")
            tail = tail[cut + 1:] if cut >= 0 else tail
            with open(self.path, "wb") as fh:
                fh.write(tail)
        # A reopened log continues the numbering after what is on disk, so a bridge
        # that remembers a seq from before a gateway restart is told to redraw
        # (its seq is below first_seq) instead of being handed a clashing number.
        last = 0
        try:
            with open(self.path, "rb") as fh:
                fh.seek(max(0, os.path.getsize(self.path) - 65536))
                for line in fh.read().splitlines():
                    try:
                        last = max(last, int(json.loads(line).get("seq") or 0))
                    except (ValueError, AttributeError):
                        continue
        except OSError:
            pass
        self.last_seq = last
        self.first_seq = last + 1
        self._fh = open(self.path, "ab")

    def append(self, frame):
        self.last_seq += 1
        frame = dict(frame)
        frame["seq"] = self.last_seq
        frame.setdefault("sessionId", self.session_id)
        line = json.dumps(frame, separators=(",", ":"), default=str)
        size = len(line) + 1
        self.frames.append((frame, size))
        self.bytes += size
        while self.frames and (len(self.frames) > self.max_messages or self.bytes > self.max_bytes):
            _, dropped = self.frames.popleft()
            self.bytes -= dropped
        self.first_seq = self.frames[0][0]["seq"] if self.frames else self.last_seq + 1
        if self._fh:
            try:
                self._fh.write(line.encode("utf-8") + b"\n")
                self._fh.flush()
            except OSError:
                pass
        return frame

    def replay(self, since):
        since = int(since or 0)
        return [f for f, _ in self.frames if f["seq"] > since]

    def close(self):
        if self._fh:
            try:
                self._fh.close()
            except OSError:
                pass
            self._fh = None

    @staticmethod
    def read_file(path, limit_bytes=NDJSON_MAX_BYTES):
        """The persisted frames of one session (newest ``limit_bytes``), oldest first; ``[]`` when there is no file."""
        out = []
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                fh.seek(max(0, size - limit_bytes))
                data = fh.read()
        except OSError:
            return out
        if size > limit_bytes:
            cut = data.find(b"\n")
            data = data[cut + 1:] if cut >= 0 else data
        for line in data.splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out


# ---------------------------------------------------------------- AcpClient

class AcpClient:
    """Newline JSON-RPC 2.0 over a child's stdio, asyncio-driven.

    ``request()`` awaits the matching response (ids are a per-client counter,
    one waiter per id, rejected when the child exits); ``notify()`` sends a
    notification; the reader task hands notifications to ``on_notification``
    and server->client requests (``method`` + ``id``) to ``on_request``, whose
    return value (or :class:`AcpError`) is sent back as the response. Nothing
    here knows what the methods mean.
    """

    def __init__(self, argv, cwd, env=None, on_notification=None, on_request=None, on_exit=None, stderr_path=None, log=None):
        self.argv = list(argv)
        self.cwd = cwd
        self.env = env
        self.on_notification = on_notification
        self.on_request = on_request
        self.on_exit = on_exit
        self.stderr_path = stderr_path
        self.log = log or (lambda *a: None)
        self.proc = None
        self.pid = None
        self.next_id = 1
        self.pending = {}
        self.reader = None
        self.stderr_task = None
        self.exited = asyncio.Event()
        self.exit_code = None
        self.stderr_tail = collections.deque(maxlen=40)
        self.write_lock = asyncio.Lock()

    @property
    def alive(self):
        return self.proc is not None and self.proc.returncode is None and not self.exited.is_set()

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv, cwd=self.cwd, env=self.env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024, start_new_session=True)
        self.pid = self.proc.pid
        self.reader = asyncio.create_task(self._read_loop())
        self.stderr_task = asyncio.create_task(self._stderr_loop())
        return self.pid

    async def _send(self, obj):
        line = (json.dumps(obj, separators=(",", ":"), default=str) + "\n").encode("utf-8")
        async with self.write_lock:
            if not self.alive or self.proc.stdin is None:
                raise AcpError(INTERNAL_ERROR, "child is not running")
            self.proc.stdin.write(line)
            try:
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as error:
                raise AcpError(INTERNAL_ERROR, "child stdin closed: %s" % error)

    async def request(self, method, params=None, timeout=None):
        rid = self.next_id
        self.next_id += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        try:
            await self._send({"jsonrpc": JSONRPC, "id": rid, "method": method, "params": params if params is not None else {}})
            if timeout:
                return await asyncio.wait_for(fut, timeout)
            return await fut
        except asyncio.TimeoutError:
            raise AcpError(INTERNAL_ERROR, "%s timed out after %ss" % (method, timeout))
        finally:
            self.pending.pop(rid, None)

    async def notify(self, method, params=None):
        await self._send({"jsonrpc": JSONRPC, "method": method, "params": params if params is not None else {}})

    async def respond(self, rid, result=None, error=None):
        msg = {"jsonrpc": JSONRPC, "id": rid}
        if error is not None:
            msg["error"] = error.to_dict() if isinstance(error, AcpError) else error
        else:
            msg["result"] = result if result is not None else {}
        try:
            await self._send(msg)
        except AcpError:
            pass  # the child is gone; nothing to answer

    async def _read_loop(self):
        try:
            while True:
                raw = await self.proc.stdout.readline()
                if not raw:
                    break
                text = raw.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    obj = json.loads(text)
                except ValueError:
                    self.log("kas: unparsable line from child: %r" % text[:200])
                    continue
                if not isinstance(obj, dict):
                    continue
                try:
                    await self._dispatch(obj)
                except Exception as error:  # noqa: BLE001 — one bad frame must not kill the reader
                    self.log("kas: dispatch failed: %r" % error)
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        finally:
            await self._on_closed()

    async def _dispatch(self, obj):
        if "method" in obj and "id" in obj:
            rid = obj["id"]
            try:
                result = await self.on_request(obj["method"], obj.get("params") or {}, rid) if self.on_request \
                    else None
            except AcpError as error:
                await self.respond(rid, error=error)
                return
            except Exception as error:  # noqa: BLE001
                await self.respond(rid, error=AcpError(INTERNAL_ERROR, "%s: %s" % (type(error).__name__, error)))
                return
            if result is not _PARKED:
                await self.respond(rid, result=result if result is not None else {})
        elif "method" in obj:
            if self.on_notification:
                await self.on_notification(obj["method"], obj.get("params") or {})
        elif "id" in obj:
            fut = self.pending.get(obj["id"])
            if fut is None or fut.done():
                return
            if "error" in obj and obj["error"] is not None:
                err = obj["error"] or {}
                fut.set_exception(AcpError(err.get("code", INTERNAL_ERROR), str(err.get("message", "error")), err.get("data")))
            else:
                fut.set_result(obj.get("result"))

    async def _stderr_loop(self):
        fh = None
        try:
            if self.stderr_path:
                os.makedirs(os.path.dirname(self.stderr_path), exist_ok=True)
                try:
                    if os.path.getsize(self.stderr_path) > STDERR_LOG_MAX_BYTES:
                        os.replace(self.stderr_path, self.stderr_path + ".1")
                except OSError:
                    pass
                fh = open(self.stderr_path, "ab")
            while True:
                raw = await self.proc.stderr.readline()
                if not raw:
                    break
                self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())
                if fh:
                    fh.write(raw)
                    fh.flush()
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        finally:
            if fh:
                fh.close()

    async def _on_closed(self):
        if self.exited.is_set():
            return
        try:
            self.exit_code = await asyncio.wait_for(self.proc.wait(), 2.0)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            self.exit_code = self.proc.returncode
        self.exited.set()
        for fut in list(self.pending.values()):
            if not fut.done():
                fut.set_exception(AcpError(INTERNAL_ERROR, "child exited (code %s)" % self.exit_code))
        self.pending.clear()
        if self.on_exit:
            try:
                await self.on_exit(self.exit_code)
            except Exception as error:  # noqa: BLE001
                self.log("kas: on_exit failed: %r" % error)

    async def stop(self):
        """SIGTERM the child (kiro-cli does not exit on stdin close), SIGKILL after STOP_GRACE_S."""
        if self.proc is None:
            return
        if self.proc.returncode is None:
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    self.proc.terminate()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(self.proc.wait(), STOP_GRACE_S)
            except asyncio.TimeoutError:
                try:
                    os.killpg(self.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        self.proc.kill()
                    except ProcessLookupError:
                        pass
                try:
                    await asyncio.wait_for(self.proc.wait(), 2.0)
                except asyncio.TimeoutError:
                    pass
        if self.reader:
            try:
                await asyncio.wait_for(self.reader, 2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
                self.reader.cancel()
        if self.stderr_task:
            self.stderr_task.cancel()


#: Sentinel an ``on_request`` handler returns to say "I will answer this id later".
_PARKED = object()


# -------------------------------------------------------------------- Child

class ParkedRequest:
    __slots__ = ("request_id", "session_id", "kind", "payload", "created")

    def __init__(self, request_id, session_id, kind, payload):
        self.request_id = request_id
        self.session_id = session_id
        self.kind = kind
        self.payload = payload
        self.created = _now()


class SessionState:
    """What the hook tracks per KAS session, beyond the log."""

    def __init__(self, session_id, log, mode=None, title=None, created=None):
        self.session_id = session_id
        self.log = log
        self.mode = mode
        self.title = title or ""
        self.feature = None
        self.created = created or _now()
        self.last_activity = self.created
        self.autopilot = False
        self.prompt_pending = False      # a session/prompt awaits its response
        self.turn_active = False         # KAS says a turn runs (prompt or invoke)
        self.turn_open = False           # an invoke's turn: turn_start seen, turn_end not yet
        self.parked = {}                 # request id -> ParkedRequest
        self.answered_tool_calls = {}    # toolCallId -> chosen optionId (bursts of the same question)
        self.loaded = False

    @property
    def running(self):
        return self.prompt_pending or self.turn_active or self.turn_open


class Child:
    """One ``kiro-cli acp`` process for one workspace, with its sessions and attached bridges."""

    def __init__(self, manager, folder, argv, data_dir, log):
        self.manager = manager
        self.folder = folder
        self.ws_hash = ws_hash(folder)
        self.argv = argv
        self.data_dir = data_dir
        self.log = log
        self.client = AcpClient(argv, folder, env=dict(os.environ),
                                on_notification=self._on_notification, on_request=self._on_request,
                                on_exit=self._on_exit, stderr_path=os.path.join(data_dir, "kas", self.ws_hash + ".log"), log=log)
        self.sessions = {}               # session id -> SessionState
        self.forgotten = set()           # scratch session ids whose late notifications must not create a state
        self.links = set()               # attached Kas_Link connections (any session)
        self.capabilities = {}
        self.modes = []
        self.config_options = []
        self.started_at = None
        self.ready = False
        self.login = None                # None unknown, False when session/new said "not logged in", True once one succeeded
        self.login_message = None
        self.exited = None               # {"code", "reason"} once the process is gone
        self.last_idle_at = _now()

    # -- lifecycle ---------------------------------------------------------

    async def start(self):
        pid = await self.client.start()
        self.started_at = _now()
        self.log("kas: spawned kiro-cli pid=%s for %s" % (pid, self.folder))
        params = {
            "protocolVersion": 1,
            "clientInfo": dict(CLIENT_INFO),
            "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "_meta": {"kiro": dict(KIRO_META)}},
            "_meta": {"kiro": dict(KIRO_META)},
        }
        try:
            result = await self.client.request("initialize", params, timeout=INIT_TIMEOUT_S)
        except AcpError:
            await self.client.stop()
            raise
        self.capabilities = (result or {}).get("agentCapabilities") or {}
        self.ready = True
        return result

    async def stop(self, reason="stopped"):
        if self.exited is None:
            self.exited = {"code": None, "reason": reason, "at": _now()}
        await self.client.stop()
        self.exited["code"] = self.client.exit_code
        self._mark_exited(self.client.exit_code, reason)

    def _mark_exited(self, code, reason):
        if self.exited is None:
            self.exited = {"code": code, "reason": reason, "at": _now()}
        self.ready = False
        for state in self.sessions.values():
            state.prompt_pending = False
            state.turn_active = False
            state.turn_open = False
            state.parked.clear()
            state.log.close()

    async def _on_exit(self, code):
        intended = self.exited is not None
        reason = self.exited["reason"] if intended else "exited"
        tail = "\n".join(self.client.stderr_tail)
        if not intended and LOGIN_RE.search(tail):
            reason = "login"
        self._mark_exited(code, reason)
        self.exited["code"] = code
        self.log("kas: kiro-cli pid=%s for %s exited code=%s reason=%s" % (self.client.pid, self.folder, code, reason))
        await self.broadcast({"kind": "childState", "state": "exited", "code": code, "reason": reason,
                              "wsHash": self.ws_hash, "sessions": sorted(self.sessions)})
        self.manager.on_child_exit(self)

    # -- sessions ----------------------------------------------------------

    def _session(self, session_id, mode=None, title=None, create=True):
        state = self.sessions.get(session_id)
        if state is None and create:
            path = os.path.join(self.data_dir, "kas", self.ws_hash, session_id + ".ndjson")
            state = SessionState(session_id, SessionLog(session_id, path), mode=mode, title=title)
            self.sessions[session_id] = state
            self.manager.index_put(self, state)
        return state

    def _record_modes(self, result):
        modes = (result or {}).get("modes") or {}
        rows = []
        for m in modes.get("availableModes") or []:
            source = ((m.get("_meta") or {}).get("kiro") or {}).get("source")
            rows.append({"id": m.get("id"), "name": m.get("name") or m.get("id"), "description": m.get("description") or "",
                         "bundled": source == "bundled"})
        if rows:
            self.modes = rows
            self.manager.remember_modes(rows)
        options = (result or {}).get("configOptions")
        if options:
            self.config_options = [{"id": o.get("id"), "name": o.get("name"), "currentValue": o.get("currentValue"),
                                    "options": [x.get("value") for x in (o.get("options") or [])]} for o in options]
        return modes.get("currentModeId")

    def option_ids(self):
        return [o["id"] for o in self.config_options]

    async def _session_new(self):
        """``session/new`` with the login verdict recorded (the not-logged-in signal lives on this call)."""
        try:
            result = await self.client.request("session/new", {"cwd": self.folder, "mcpServers": []})
        except AcpError as error:
            if LOGIN_RE.search(error.message or ""):
                self.login = False
                self.login_message = error.message
            raise
        self.login = True
        self.login_message = None
        self._record_modes(result)
        return result

    async def learn_modes(self):
        """Fill ``modes`` on a child that has no session yet: a scratch ``session/new``, deleted at once.

        ``availableModes`` only comes with ``session/new`` / ``session/load``. KAS
        persists even an empty session under ``~/.kiro/sessions``, so the scratch
        one is removed with ``session/delete`` (advertised by 2.22.1 and 3.3.0);
        a failure to delete is logged, not fatal. Not logged in is recorded on
        ``login`` and not raised: hello still answers, with ``login: false``.
        """
        try:
            result = await self._session_new()
        except AcpError as error:
            if self.login is False:
                return []
            raise
        scratch = (result or {}).get("sessionId")
        if scratch:
            try:
                await self.client.request("session/delete", {"sessionId": scratch})
            except AcpError as error:
                self.log("kas: could not delete the scratch session %s: %s" % (scratch, error.message))
            self.forget(scratch)
        return self.modes

    def forget(self, session_id):
        """Drop a session the hook has no business tracking (the modes scratch session, whose own notifications created a state)."""
        self.forgotten.add(session_id)
        state = self.sessions.pop(session_id, None)
        if state is not None:
            state.log.close()
            try:
                if state.log.path and os.path.isfile(state.log.path):
                    os.remove(state.log.path)
            except OSError:
                pass
        self.manager.index_drop(session_id)

    async def new_session(self, mode, autopilot=False, model=None, effort=None, title=None):
        result = await self._session_new()
        session_id = (result or {}).get("sessionId")
        if not session_id:
            raise AcpError(INTERNAL_ERROR, "session/new returned no sessionId")
        state = self._session(session_id, mode=mode, title=title)
        notes = []
        if mode:
            await self.client.request("session/set_mode", {"sessionId": session_id, "modeId": mode})
            state.mode = mode
        notes += await self.configure(state, autopilot=autopilot, model=model, effort=effort)
        self.manager.index_put(self, state)
        return state, notes

    async def configure(self, state, autopilot=None, model=None, effort=None):
        """Apply Autopilot/model/effort through ``session/set_config_option``; absent options are reported, not fatal."""
        notes = []
        ids = self.option_ids()
        for config_id, value in (("autopilot", None if autopilot is None else ("on" if autopilot else "off")),
                                 ("model", model), ("effortLevel", effort)):
            if value in (None, ""):
                continue
            if config_id == "autopilot":
                state.autopilot = bool(autopilot)   # the hook's auto-answer is the fallback and always applies
            if ids and config_id not in ids:
                notes.append("KAS offers no %s option for this session; ignored" % config_id)
                continue
            try:
                result = await self.client.request("session/set_config_option", {"sessionId": state.session_id, "configId": config_id, "value": value})
                self._record_modes(result)
            except AcpError as error:
                notes.append("%s: %s" % (config_id, error.message))
        return notes

    async def load_session(self, session_id):
        """``session/load`` a session this child does not hold; KAS replays its history as updates."""
        state = self._session(session_id)
        state.log.append({"kind": "clear"})  # the replay redraws the transcript from the top
        result = await self.client.request("session/load", {"sessionId": session_id, "cwd": self.folder, "mcpServers": []})
        current = self._record_modes(result)
        if current:
            state.mode = current
        meta = (result or {}).get("_meta") or {}
        if meta.get("title"):
            state.title = meta["title"]
        state.loaded = True
        self.manager.index_put(self, state)
        return state

    async def prompt(self, state, blocks):
        state.prompt_pending = True
        state.turn_active = True
        state.last_activity = _now()
        if not state.title:
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                    state.title = str(block["text"]).strip().splitlines()[0][:80]
                    break
        self.manager.index_put(self, state)
        try:
            result = await self.client.request("session/prompt", {"sessionId": state.session_id, "prompt": blocks})
            stop = (result or {}).get("stopReason") or "end_turn"
        except AcpError as error:
            stop = "error"
            self._relay(state, {"kind": "error", "message": error.message, "code": error.code})
        finally:
            state.prompt_pending = False
            state.turn_active = False
            state.last_activity = _now()
        self._relay(state, {"kind": "turnEnd", "stopReason": stop})
        self.manager.index_put(self, state)
        return stop

    async def cancel(self, state):
        await self.client.notify("session/cancel", {"sessionId": state.session_id})

    async def spec(self, method, params, link=None):
        """Passthrough of the ``_kiro/spec/*`` methods with the Autopilot rule for task runs."""
        if method not in SPEC_METHODS:
            raise AcpError(INVALID_PARAMS, "not a spec method: %s" % method)
        params = dict(params or {})
        if method == "_kiro/spec/resolveSession":
            params.setdefault("workspacePaths", [self.folder])
        session_id = params.get("sessionId")
        if method == "_kiro/spec/invoke" and session_id:
            state = self._session(session_id, title=params.get("userPrompt") or params.get("featureName"))
            if params.get("featureName"):
                state.feature = params["featureName"]
            if params.get("operation") in AUTOPILOT_OPERATIONS and not state.autopilot:
                await self.configure(state, autopilot=True)
            state.turn_active = True
            state.turn_open = True
            state.last_activity = _now()
            if link is not None:
                self.links.add(link)
            self.manager.index_put(self, state)
        result = await self.client.request(method, params)
        if method == "_kiro/spec/resolveSession" and (result or {}).get("sessionId"):
            state = self._session(result["sessionId"], title=params.get("featureName"))
            state.feature = params.get("featureName") or state.feature
            self.manager.index_put(self, state)
        return result

    # -- child -> hook -----------------------------------------------------

    async def _on_notification(self, method, params):
        if method == "session/update":
            session_id = params.get("sessionId")
            update = params.get("update") or {}
            if not session_id or session_id in self.forgotten:
                return
            state = self._session(session_id)
            state.last_activity = _now()
            self._track_turn(state, update)
            self._relay(state, {"kind": "update", "update": update})
        elif method in SPEC_EVENTS:
            await self.broadcast({"kind": "specEvent", "method": method, "params": params,
                                  "sessionId": params.get("sessionId"), "wsHash": self.ws_hash})
        elif method == "_kiro/sessions/changed":
            await self.broadcast({"kind": "sessionsChanged", "wsHash": self.ws_hash})
        # everything else (_kiro/mcp/status, _kiro/tools/didChange, ...) is noise for the bridge

    def _track_turn(self, state, update):
        """Turn boundaries ride on ``session_info_update._meta.kiro.kind``: the invoke completion signal.

        KAS 3.3.0 sends ``focus_update {status: idle}`` BEFORE ``turn_end``, so the
        turn is held open from ``turn_start`` until ``turn_end`` itself
        (``turn_open``); focus updates only refine ``turn_active``.
        """
        if update.get("sessionUpdate") != "session_info_update":
            return
        kiro = ((update.get("_meta") or {}).get("kiro") or {})
        kind = kiro.get("kind")
        if kiro.get("title") and not state.title:
            state.title = str(kiro["title"])[:120]
        if kind == "turn_start":
            state.turn_active = True
            if not state.prompt_pending:
                state.turn_open = True
        elif kind == "turn_end":
            was_invoke = state.turn_open and not state.prompt_pending
            state.turn_active = False
            state.turn_open = False
            if was_invoke:
                self._relay(state, {"kind": "turnEnd", "stopReason": kiro.get("stopReason") or "end_turn", "source": "invoke"})
                self.manager.index_put(self, state)
        elif kind == "focus_update":
            status = kiro.get("status")
            if status == "idle" and not state.prompt_pending and not state.turn_open:
                state.turn_active = False
            elif status in ("in_progress", "waiting_on_user"):
                state.turn_active = True

    async def _on_request(self, method, params, rid):
        if method == PERMISSION_METHOD:
            return await self._on_permission(params, rid)
        if method == USER_INPUT_METHOD:
            session_id = params.get("sessionId")
            state = self._session(session_id) if session_id else None
            if state is None:
                raise AcpError(INVALID_PARAMS, "userInput without a session")
            parked = ParkedRequest(rid, session_id, "userInput", params)
            state.parked[rid] = parked
            self._relay(state, {"kind": "ask", "ask": "userInput", "requestId": rid, "question": params.get("question"),
                                "options": params.get("options") or [], "toolCallId": params.get("toolCallId")})
            return _PARKED
        if method == "fs/read_text_file":
            return self._fs_read(params)
        if method == "fs/write_text_file":
            return self._fs_write(params)
        raise AcpError(METHOD_NOT_FOUND, "kirocrew-ide: method not supported: %s" % method)

    async def _on_permission(self, params, rid):
        session_id = params.get("sessionId")
        state = self._session(session_id) if session_id else None
        if state is None:
            raise AcpError(INVALID_PARAMS, "permission request without a session")
        options = params.get("options") or []
        tool = params.get("toolCall") or {}
        tcid = tool.get("toolCallId")
        if state.autopilot:
            chosen = first_allow(options)
            if chosen is not None:
                return {"outcome": {"outcome": "selected", "optionId": chosen}}
        # A burst of the same question (same toolCallId, measured up to five in 500 ms)
        # is answered with the first answer the user gave.
        if tcid and tcid in state.answered_tool_calls:
            return {"outcome": {"outcome": "selected", "optionId": state.answered_tool_calls[tcid]}}
        parked = ParkedRequest(rid, session_id, "permission", params)
        state.parked[rid] = parked
        self._relay(state, {"kind": "ask", "ask": "permission", "requestId": rid, "toolCallId": tcid,
                            "title": tool.get("title") or "tool", "toolKind": tool.get("kind"), "rawInput": tool.get("rawInput"),
                            "options": [{"optionId": o.get("optionId"), "name": o.get("name"), "kind": o.get("kind")} for o in options]})
        return _PARKED

    async def answer(self, request_id, option_id=None, answer=None, cancel=False):
        """Resolve a Parked_Request from a bridge (or from Autopilot turning on)."""
        for state in self.sessions.values():
            parked = state.parked.pop(request_id, None)
            if parked is None:
                continue
            if parked.kind == "permission":
                if cancel or not option_id:
                    result = {"outcome": {"outcome": "cancelled"}}
                else:
                    result = {"outcome": {"outcome": "selected", "optionId": option_id}}
                    tcid = (parked.payload.get("toolCall") or {}).get("toolCallId")
                    if tcid:
                        state.answered_tool_calls[tcid] = option_id
            else:
                result = {"action": "cancelled"} if cancel else {"action": "answered", "answer": answer if answer is not None else ""}
            await self.client.respond(request_id, result=result)
            self._relay(state, {"kind": "askResolved", "requestId": request_id, "optionId": option_id, "answer": answer, "cancelled": bool(cancel)})
            return True
        return False

    async def set_autopilot(self, state, on):
        """Flip the flag and, when it goes on, answer every parked permission with its first allow option."""
        notes = await self.configure(state, autopilot=on)
        if on:
            for parked in [p for p in state.parked.values() if p.kind == "permission"]:
                chosen = first_allow(parked.payload.get("options") or [])
                await self.answer(parked.request_id, option_id=chosen, cancel=chosen is None)
        return notes

    def _fs_path(self, params):
        path = params.get("path")
        if not isinstance(path, str) or not path:
            raise AcpError(INVALID_PARAMS, "path required")
        real = os.path.realpath(os.path.expanduser(path))
        allowed = (self.folder + os.sep, os.path.realpath(os.path.expanduser("~/.kiro")) + os.sep)
        if not any(real.startswith(a) for a in allowed) and real != self.folder:
            raise AcpError(INVALID_PARAMS, "kirocrew-ide: path outside the workspace: %s" % path)
        return real

    def _fs_read(self, params):
        real = self._fs_path(params)
        try:
            with open(real, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.read().split("\n")
        except OSError as error:
            raise AcpError(INTERNAL_ERROR, "%s: %s" % (type(error).__name__, error))
        line = int(params.get("line") or 0)
        limit = params.get("limit")
        sel = lines[line:line + int(limit)] if limit else lines[line:]
        return {"content": "\n".join(sel)}

    def _fs_write(self, params):
        real = self._fs_path(params)
        content = params.get("content")
        if not isinstance(content, str):
            content = "" if content is None else str(content)
        try:
            os.makedirs(os.path.dirname(real), exist_ok=True)
            tmp = real + ".kirocrew-ide.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.replace(tmp, real)
        except OSError as error:
            raise AcpError(INTERNAL_ERROR, "%s: %s" % (type(error).__name__, error))
        return {}

    # -- hook -> bridges ---------------------------------------------------

    def _relay(self, state, frame):
        """Buffer a per-session frame (gets its seq) and fan it out to the bridges attached to the session."""
        stamped = state.log.append(frame)
        for link in list(self.links):
            if state.session_id in link.sessions:
                link.send(stamped)

    async def broadcast(self, frame):
        for link in list(self.links):
            link.send(frame)

    def attached_count(self):
        return len(self.links)

    def running_turns(self):
        return [sid for sid, s in self.sessions.items() if s.running]

    def facts(self):
        return {
            "wsHash": self.ws_hash, "folder": self.folder, "pid": self.client.pid, "alive": self.client.alive,
            "uptime": round(_now() - self.started_at, 1) if self.started_at else None, "ready": self.ready,
            "attached": self.attached_count(), "sessions": sorted(self.sessions), "running": self.running_turns(),
            "modes": self.modes, "configOptions": self.option_ids(), "exited": self.exited,
            "idleSince": None if (self.links or self.running_turns()) else round(_now() - self.last_idle_at, 1),
        }


def first_allow(options):
    """The optionId of the first ``allow*`` permission option (``allow_once`` before ``allow_always`` by position)."""
    for option in options or []:
        if str(option.get("kind") or "").startswith("allow"):
            return option.get("optionId")
    return None


def prompt_text(blocks):
    """The text a transcript shows for a prompt's content blocks: text blocks joined, images and resources named."""
    parts = []
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            parts.append(str(block.get("text") or ""))
        elif kind == "image":
            parts.append("[image %s]" % (block.get("mimeType") or ""))
        elif kind in ("resource", "resource_link"):
            parts.append("[%s]" % (block.get("uri") or (block.get("resource") or {}).get("uri") or kind))
    return "\n".join(p for p in parts if p)[:20000]


# --------------------------------------------------------------- KasManager

class KasManager:
    """Children by workspace, the index, kiro-cli facts and the idle timer. One per hook module."""

    def __init__(self, data_dir, workspaces, config_get, log, which=shutil.which, run=subprocess.run):
        self.data_dir = str(data_dir)
        self.workspaces = workspaces            # callable -> list of open folders (the engine's)
        self.config_get = config_get            # callable(key, default)
        self.log = log
        self.which = which
        self.run = run
        self.children = {}                      # ws_hash -> Child
        self.index = {}                         # session id -> dict (SessionIndexEntry)
        self.version_cache = {}                 # kiro-cli path -> {"version", "engineOk", "error"}
        self.idle_task = None
        self.spawn_locks = {}
        self._load_index()

    # -- kiro-cli ----------------------------------------------------------

    def kiro_cli(self):
        configured = self.config_get("kas.kiro_cli", None)
        if configured and os.path.isfile(str(configured)):
            return str(configured)
        found = self.which("kiro-cli")
        if found:
            return found
        home = os.path.expanduser(HOME_CLI)
        return home if os.path.isfile(home) else None

    def cli_facts(self, path=None):
        """``{path, version, engineOk, error}`` for the kiro-cli at ``path`` (cached per path)."""
        path = path or self.kiro_cli()
        if not path:
            return {"path": None, "version": None, "engineOk": False, "error": "kiro-cli not found on PATH or in ~/.local/bin"}
        cached = self.version_cache.get(path)
        if cached:
            return cached
        facts = {"path": path, "version": None, "engineOk": False, "error": None}
        try:
            out = self.run([path, "--version"], capture_output=True, text=True, timeout=15)
            facts["version"] = (out.stdout or out.stderr or "").strip().split("\n")[0]
            help_out = self.run([path, "acp", "--help"], capture_output=True, text=True, timeout=15)
            facts["engineOk"] = "--agent-engine" in (help_out.stdout or "") + (help_out.stderr or "")
            if not facts["engineOk"]:
                facts["error"] = "this kiro-cli (%s) does not accept --agent-engine v3" % facts["version"]
        except Exception as error:  # noqa: BLE001
            facts["error"] = "%s: %s" % (type(error).__name__, error)
        self.version_cache[path] = facts
        return facts

    def login_facts(self):
        """Login state from ``kiro-cli whoami`` (cheap, cached 60 s)."""
        cached = getattr(self, "_login", None)
        if cached and _now() - cached["at"] < 60:
            return cached["value"]
        path = self.kiro_cli()
        value = {"loggedIn": None, "detail": None}
        if path:
            try:
                out = self.run([path, "whoami"], capture_output=True, text=True, timeout=15)
                text = ((out.stdout or "") + (out.stderr or "")).strip()
                value = {"loggedIn": out.returncode == 0 and not LOGIN_RE.search(text), "detail": text.split("\n")[0][:200] if text else None}
            except Exception as error:  # noqa: BLE001
                value = {"loggedIn": None, "detail": "%s: %s" % (type(error).__name__, error)}
        self._login = {"at": _now(), "value": value}
        return value

    def idle_minutes(self):
        raw = self.config_get("kas.idle_minutes", None)
        if raw is None:
            return IDLE_MINUTES_DEFAULT
        try:
            return max(0, int(raw))
        except (TypeError, ValueError):
            return IDLE_MINUTES_DEFAULT

    # -- children ----------------------------------------------------------

    def validate_folder(self, folder):
        """The real path of ``folder`` if the engine has it open, else :class:`AcpError` (requirement 1.3 / 9.4)."""
        if not isinstance(folder, str) or not folder.strip():
            raise AcpError(INVALID_PARAMS, "folder required")
        wanted = real_folder(folder)
        open_dirs = {real_folder(f) for f in (self.workspaces() or []) if f}
        if wanted not in open_dirs:
            raise AcpError(INVALID_PARAMS, "folder is not open in the IDE engine: %s" % folder)
        return wanted

    def child_for(self, folder):
        return self.children.get(ws_hash(real_folder(folder)))

    async def get_or_spawn(self, folder):
        real = self.validate_folder(folder)
        key = ws_hash(real)
        lock = self.spawn_locks.setdefault(key, asyncio.Lock())
        async with lock:
            child = self.children.get(key)
            if child is not None and child.client.alive and child.ready:
                return child
            facts = self.cli_facts()
            if not facts["path"] or not facts["engineOk"]:
                raise AcpError(INTERNAL_ERROR, facts["error"] or "kiro-cli unavailable")
            argv = [facts["path"], "acp", "--agent-engine", "v3", "--auth-method", "cli"]
            child = Child(self, real, argv, self.data_dir, self.log)
            self.children[key] = child
            try:
                await child.start()
            except AcpError as error:
                self.children.pop(key, None)
                raise AcpError(error.code, "kiro-cli did not initialize: %s" % error.message, error.data)
            self._ensure_idle_timer()
            return child

    def on_child_exit(self, child):
        if self.children.get(child.ws_hash) is child:
            self.children.pop(child.ws_hash, None)
        for sid in child.sessions:
            entry = self.index.get(sid)
            if entry:
                entry["state"] = "detached"
        self._save_index()

    async def stop_all(self, reason="deactivate"):
        for child in list(self.children.values()):
            try:
                await child.stop(reason)
            except Exception:  # noqa: BLE001
                pass
        self.children.clear()
        if self.idle_task:
            self.idle_task.cancel()
            self.idle_task = None

    def kill_all_sync(self, reason="deactivate"):
        """SIGTERM every child from synchronous code (the hook's deactivate runs on the loop and cannot await).

        A child the next hook module does not know would hold its sessions
        (``SessionHeldElsewhereError`` for the new child), so none may outlive
        the module that spawned it. The index marks the sessions detached; a
        bridge's next attach brings a fresh child and ``session/load``s.
        """
        for child in list(self.children.values()):
            if child.exited is None:
                child.exited = {"code": None, "reason": reason, "at": _now()}
            pid = child.client.pid
            if pid and child.client.proc is not None and child.client.proc.returncode is None:
                try:
                    os.killpg(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        child.client.proc.terminate()
                    except ProcessLookupError:
                        pass
            for sid in child.sessions:
                entry = self.index.get(sid)
                if entry:
                    entry["state"] = "detached"
        self.children.clear()
        if self.idle_task:
            self.idle_task.cancel()
            self.idle_task = None
        self._save_index()

    def _ensure_idle_timer(self):
        if self.idle_task is None or self.idle_task.done():
            self.idle_task = asyncio.create_task(self._idle_loop())

    async def _idle_loop(self):
        try:
            while self.children:
                await asyncio.sleep(30)
                await self.reap_idle()
        except asyncio.CancelledError:
            pass

    async def reap_idle(self, now=None):
        """Stop every child with no bridge attached and no running turn for ``kas.idle_minutes`` (0 = never)."""
        minutes = self.idle_minutes()
        now = now if now is not None else _now()
        stopped = []
        for child in list(self.children.values()):
            busy = child.links or child.running_turns()
            if busy:
                child.last_idle_at = now
                continue
            if minutes and now - child.last_idle_at >= minutes * 60:
                self.log("kas: stopping idle kiro-cli pid=%s for %s" % (child.client.pid, child.folder))
                await child.stop("idle")
                self.children.pop(child.ws_hash, None)
                stopped.append(child.ws_hash)
        if stopped:
            self._save_index()
        return stopped

    # -- index -------------------------------------------------------------

    def _index_path(self):
        return os.path.join(self.data_dir, "kas", "index.json")

    def _load_index(self):
        self.index = {}
        self.cached_modes = []
        try:
            with open(self._index_path(), "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            return
        if not isinstance(doc, dict):
            return
        for row in doc.get("sessions") or []:
            if isinstance(row, dict) and row.get("sessionId"):
                row["state"] = "detached"   # no child survives a hook reload; a bridge's attach brings one back
                self.index[row["sessionId"]] = row
        modes = doc.get("modes")
        if isinstance(modes, list):
            self.cached_modes = [m for m in modes if isinstance(m, dict) and m.get("id")]

    def _save_index(self):
        path = self._index_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"sessions": sorted(self.index.values(), key=lambda r: r.get("lastActivity") or 0),
                           "modes": self.cached_modes}, fh, indent=1, default=str)
            os.replace(tmp, path)
        except OSError as error:
            self.log("kas: index write failed: %s" % error)

    def remember_modes(self, rows):
        """The last ``availableModes`` a child reported, kept in the index so ``kas/status`` can list them before any child runs."""
        if rows and rows != self.cached_modes:
            self.cached_modes = list(rows)
            self._save_index()

    def index_put(self, child, state):
        entry = self.index.get(state.session_id) or {"sessionId": state.session_id, "created": state.created}
        entry.update({
            "wsHash": child.ws_hash, "folder": child.folder, "mode": state.mode, "title": state.title[:120],
            "feature": state.feature, "lastActivity": state.last_activity,
            "state": "running" if state.running else ("idle" if child.client.alive else "detached"),
            "firstSeq": state.log.first_seq, "lastSeq": state.log.last_seq, "autopilot": state.autopilot,
        })
        self.index[state.session_id] = entry
        self._save_index()

    def index_drop(self, session_id):
        if self.index.pop(session_id, None) is not None:
            self._save_index()

    def index_rows(self):
        rows = []
        for entry in self.index.values():
            row = dict(entry)
            child = self.children.get(entry.get("wsHash"))
            state = child.sessions.get(entry["sessionId"]) if child else None
            if state is not None:
                row["state"] = "running" if state.running else "idle"
                row["pendingAsks"] = len(state.parked)
            else:
                row["state"] = "detached"
            rows.append(row)
        rows.sort(key=lambda r: r.get("lastActivity") or 0, reverse=True)
        return rows

    def transcript_path(self, session_id):
        entry = self.index.get(session_id)
        if not entry or not entry.get("wsHash"):
            return None
        return os.path.join(self.data_dir, "kas", entry["wsHash"], session_id + ".ndjson")

    # -- status ------------------------------------------------------------

    def status(self):
        facts = self.cli_facts()
        available = bool(facts["path"] and facts["engineOk"])
        reason = facts["error"]
        login = self.login_facts() if available else {"loggedIn": None, "detail": None}
        if available and login.get("loggedIn") is False:
            available = False
            reason = "kiro-cli is not logged in; run `kiro-cli login` on the gateway host"
        modes, modes_source = [], "none"
        for child in self.children.values():
            if child.modes:
                modes, modes_source = child.modes, "child"
                break
        if not modes and self.cached_modes:
            modes, modes_source = self.cached_modes, "cached"
        if not modes and available:
            # Never seen a child yet: the modes every KAS since 2.22.1 bundles. Verified
            # against availableModes on the first session/new (a missing one fails set_mode).
            modes, modes_source = [dict(m, bundled=True) for m in ASSUMED_MODES], "assumed"
        return {
            "available": available, "reason": reason, "kiroCli": facts, "login": login,
            "idleMinutes": self.idle_minutes(), "modes": modes, "modesSource": modes_source,
            "workspaces": [c.facts() for c in self.children.values()],
            "sessions": len(self.index),
        }


#: The spec-family modes KAS bundles (2.22.1 and 3.3.0 both list them, `_meta.kiro.source: "bundled"`).
ASSUMED_MODES = [
    {"id": "spec", "name": "Spec", "description": "Structured feature development"},
    {"id": "quick-spec", "name": "Quick Spec", "description": "Fast spec workflow: clarify, then auto-generate requirements, design, and tasks"},
    {"id": "bug-fix", "name": "Bug Fix", "description": "Structured bug-fix workflow: investigate, diagnose, and resolve bugs"},
    {"id": "plan", "name": "Plan", "description": "Plan-only mode that helps break ideas down into an implementation plan without making any changes"},
]


# ------------------------------------------------------------------ Kas_Link

class _Link:
    """One bridge WebSocket: the sessions it is attached to and a non-blocking send."""

    def __init__(self, ws, log):
        self.ws = ws
        self.log = log
        self.sessions = set()
        self.child = None
        self.queue = asyncio.Queue()
        self.writer = asyncio.create_task(self._drain())

    def send(self, frame):
        self.queue.put_nowait(frame)

    async def _drain(self):
        try:
            while True:
                frame = await self.queue.get()
                if frame is None:
                    break
                await self.ws.send_str(json.dumps(frame, separators=(",", ":"), default=str))
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 — the socket is gone
            pass

    async def close(self):
        self.queue.put_nowait(None)
        try:
            await asyncio.wait_for(self.writer, 2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
            self.writer.cancel()
        if self.child is not None:
            self.child.links.discard(self)
            self.child.last_idle_at = _now()


def validate_frame(frame):
    """The bridge's frame as a dict with a known ``op`` and typed fields, or :class:`AcpError`."""
    if not isinstance(frame, dict):
        raise AcpError(INVALID_PARAMS, "frame must be an object")
    op = frame.get("op")
    if op not in OPS:
        raise AcpError(INVALID_PARAMS, "unknown op: %r" % (op,))
    for name, typ in OPS[op].items():
        value = frame.get(name)
        if value is None or not isinstance(value, typ) or isinstance(value, bool):
            raise AcpError(INVALID_PARAMS, "%s needs %s" % (op, name))
        if isinstance(value, str) and len(value) > MAX_TEXT_FIELD and name != "folder":
            raise AcpError(INVALID_PARAMS, "%s.%s too long" % (op, name))
    if "since" in frame and not isinstance(frame["since"], int):
        raise AcpError(INVALID_PARAMS, "since must be an integer")
    ref = frame.get("ref")
    if ref is not None and not isinstance(ref, (str, int)):
        raise AcpError(INVALID_PARAMS, "ref must be a string or number")
    return frame


def same_origin(request):
    """The upgrade's Origin names this host (or is absent, as from a non-browser client on the same session)."""
    origin = request.headers.get("Origin")
    if not origin:
        return True
    host = request.headers.get("X-Forwarded-Host") or request.headers.get("Host") or request.host or ""
    try:
        from urllib.parse import urlsplit
        return urlsplit(origin).netloc.lower() == host.lower()
    except Exception:  # noqa: BLE001
        return False


async def handle_ws(request, manager, log=None):
    """The Kas_Link WebSocket handler (dispatched from the proxy by path prefix)."""
    import aiohttp
    from aiohttp import web

    log = log or manager.log
    if not same_origin(request):
        return web.Response(status=403, text="KiroCrew IDE: cross-origin WebSocket refused")
    ws = web.WebSocketResponse(max_msg_size=MAX_FRAME_BYTES, heartbeat=30.0)
    await ws.prepare(request)
    link = _Link(ws, log)
    try:
        async for message in ws:
            if message.type != aiohttp.WSMsgType.TEXT:
                if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
                continue
            try:
                frame = validate_frame(json.loads(message.data))
            except (ValueError, AcpError) as error:
                link.send({"kind": "error", "message": getattr(error, "message", str(error)), "code": INVALID_PARAMS})
                continue
            try:
                await dispatch_op(manager, link, frame)
            except AcpError as error:
                link.send(error_frame(frame, error))
            except Exception as error:  # noqa: BLE001
                log("kas: op %s failed: %r" % (frame.get("op"), error))
                link.send(error_frame(frame, AcpError(INTERNAL_ERROR, "%s: %s" % (type(error).__name__, error))))
    finally:
        await link.close()
    return ws


def error_frame(frame, error):
    """The ``error`` reply to one bridge frame; ``login: true`` when the message is kiro-cli's not-logged-in text."""
    return {"kind": "error", "ref": frame.get("ref"), "op": frame.get("op"), "sessionId": frame.get("sessionId"),
            "message": error.message, "code": error.code, "data": error.data, "login": bool(LOGIN_RE.search(error.message or ""))}


async def dispatch_op(manager, link, frame):
    """One validated bridge frame against the manager; replies go through ``link.send``."""
    op = frame["op"]
    ref = frame.get("ref")
    if op == "hello":
        child = await manager.get_or_spawn(frame["folder"])
        if link.child is not None and link.child is not child:
            link.child.links.discard(link)
        link.child = child
        child.links.add(link)
        if not child.modes:
            await child.learn_modes()
        link.send({"kind": "hello", "ref": ref, "wsHash": child.ws_hash, "folder": child.folder, "pid": child.client.pid,
                   "login": child.login is not False, "message": child.login_message,
                   "capabilities": child.capabilities, "modes": child.modes, "configOptions": child.option_ids(),
                   "sessions": [s for s in manager.index_rows() if s.get("wsHash") == child.ws_hash]})
        return
    child = link.child
    if child is None:
        raise AcpError(INVALID_PARAMS, "say hello first (no child for this link)")
    if not child.client.alive or not child.ready:
        # The child died (or was reaped idle) since hello: attach brings a fresh one, the rest cannot proceed.
        if op != "attach":
            raise AcpError(INTERNAL_ERROR, "the kiro-cli child for this workspace is gone; reload the session")
        child = await manager.get_or_spawn(child.folder)
        link.child = child
        child.links.add(link)
    if op == "new":
        state, notes = await child.new_session(frame["mode"], autopilot=bool(frame.get("autopilot")),
                                              model=frame.get("model") or None, effort=frame.get("effort") or None,
                                              title=frame.get("title") or None)
        link.sessions.add(state.session_id)
        link.send({"kind": "created", "ref": ref, "sessionId": state.session_id, "mode": state.mode, "wsHash": child.ws_hash,
                   "notes": notes, "modes": child.modes, "configOptions": child.option_ids(), "tabRef": frame.get("tabRef")})
        return
    if op == "attach":
        session_id = frame["sessionId"]
        since = int(frame.get("since") or 0)
        state = child.sessions.get(session_id)
        loaded = False
        if state is None:
            state = await child.load_session(session_id)
            loaded = True
        link.sessions.add(session_id)
        # A `since` older than the ring (or a fresh load, which begins with a `clear`) means the
        # bridge must redraw from the top; otherwise it gets exactly what it missed.
        cleared = loaded or since < state.log.first_seq - 1
        replay_from = 0 if cleared else since
        link.send({"kind": "attached", "ref": ref, "sessionId": session_id, "cleared": cleared, "firstSeq": state.log.first_seq,
                   "lastSeq": state.log.last_seq, "mode": state.mode, "running": state.running, "autopilot": state.autopilot,
                   "pendingAsks": [p.request_id for p in state.parked.values()], "loaded": loaded, "title": state.title})
        for stamped in state.log.replay(replay_from):
            link.send(stamped)
        return
    if op == "prompt":
        state = child.sessions.get(frame["sessionId"])
        if state is None:
            raise AcpError(INVALID_PARAMS, "unknown session (attach first): %s" % frame["sessionId"])
        if state.prompt_pending:
            raise AcpError(INVALID_PARAMS, "a turn is already running in this session")
        blocks = [b for b in frame["blocks"] if isinstance(b, dict) and isinstance(b.get("type"), str)]
        if not blocks:
            raise AcpError(INVALID_PARAMS, "prompt needs at least one content block")
        link.sessions.add(state.session_id)
        asyncio.create_task(child.prompt(state, blocks))   # resolves at turn end; the turnEnd frame reports it
        link.send({"kind": "accepted", "ref": ref, "sessionId": state.session_id, "op": "prompt"})
        # KAS does not echo a live prompt as `user_message_chunk` (3.3.0, measured), so the
        # buffer carries the prompt itself; a bridge draws it only on replay (the sender drew
        # its bubble locally). Text only: images and files are named, not stored twice.
        child._relay(state, {"kind": "userPrompt", "text": prompt_text(blocks)})
        return
    if op == "cancel":
        state = child.sessions.get(frame["sessionId"])
        if state is None:
            raise AcpError(INVALID_PARAMS, "unknown session: %s" % frame["sessionId"])
        await child.cancel(state)
        link.send({"kind": "accepted", "ref": ref, "sessionId": state.session_id, "op": "cancel"})
        return
    if op == "config":
        state = child.sessions.get(frame["sessionId"])
        if state is None:
            raise AcpError(INVALID_PARAMS, "unknown session: %s" % frame["sessionId"])
        notes = []
        mode = frame.get("mode")
        if isinstance(mode, str) and mode and mode != state.mode:
            await child.client.request("session/set_mode", {"sessionId": state.session_id, "modeId": mode})
            state.mode = mode
            manager.index_put(child, state)
        if "autopilot" in frame and frame["autopilot"] is not None:
            notes += await child.set_autopilot(state, bool(frame["autopilot"]))
        notes += await child.configure(state, model=frame.get("model") or None, effort=frame.get("effort") or None)
        link.send({"kind": "configured", "ref": ref, "sessionId": state.session_id, "autopilot": state.autopilot, "mode": state.mode,
                   "notes": notes, "configOptions": child.config_options})
        return
    if op == "answer":
        rid = frame["requestId"]
        ok = await child.answer(rid, option_id=frame.get("optionId") or None, answer=frame.get("answer"), cancel=bool(frame.get("cancel")))
        if not ok:
            raise AcpError(INVALID_PARAMS, "no pending request %r" % (rid,))
        return
    if op == "spec":
        result = await child.spec(frame["method"], frame["params"], link=link)
        session_id = (result or {}).get("sessionId") or frame["params"].get("sessionId")
        if session_id:
            link.sessions.add(session_id)
        link.send({"kind": "specResult", "ref": ref, "method": frame["method"], "result": result, "sessionId": session_id})
        return
    if op == "close":
        link.sessions.discard(frame["sessionId"])
        return
    raise AcpError(INVALID_PARAMS, "unknown op")


# ------------------------------------------------------------ JSON routes

def status_route(manager):
    """``GET kas/status``."""
    return manager.status()


def sessions_route(manager, home=None):
    """``GET kas/sessions``: the hook's index merged with what KAS persisted under ``~/.kiro/sessions/<wsHash>/``."""
    home = home or os.path.expanduser("~")
    rows = {r["sessionId"]: r for r in manager.index_rows()}
    known_hashes = {r.get("wsHash") for r in rows.values()} | set(manager.children)
    for folder in manager.workspaces() or []:
        known_hashes.update(ws_hashes(folder))
    base = os.path.join(home, ".kiro", "sessions")
    for h in sorted(x for x in known_hashes if x):
        wsdir = os.path.join(base, h)
        try:
            names = os.listdir(wsdir)
        except OSError:
            continue
        for name in names:
            if not name.startswith("sess_") or name in rows:
                continue
            meta_path = os.path.join(wsdir, name, "session.json")
            try:
                with open(meta_path, "r", encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, ValueError):
                continue
            paths = meta.get("workspacePaths") or []
            rows[name] = {
                "sessionId": name, "wsHash": h, "folder": paths[0] if paths else None, "mode": meta.get("agentMode"),
                "title": meta.get("title") or "", "feature": None, "created": _ms_to_s(meta.get("createdAt")),
                "lastActivity": _ms_to_s(meta.get("lastModifiedAt")) or _mtime(meta_path), "state": "detached",
                "source": "kas", "transcript": False,
            }
    for row in rows.values():
        row.setdefault("source", "hook")
        row.setdefault("transcript", bool(manager.transcript_path(row["sessionId"]) and os.path.isfile(manager.transcript_path(row["sessionId"]))))
    out = sorted(rows.values(), key=lambda r: r.get("lastActivity") or 0, reverse=True)
    return {"sessions": out, "count": len(out)}


def transcript_route(manager, session_id):
    """``GET kas/sessions/{id}/transcript``: the persisted relayed frames, or ``[]`` with a reason."""
    if not isinstance(session_id, str) or not re.match(r"^sess_[A-Za-z0-9_-]{4,80}$", session_id):
        return (400, {"frames": [], "reason": "not a session id"})
    path = manager.transcript_path(session_id)
    if not path:
        return {"sessionId": session_id, "frames": [], "reason": "the hook never relayed this session (opened outside KiroCrew IDE)"}
    frames = SessionLog.read_file(path)
    if not frames:
        return {"sessionId": session_id, "frames": [], "reason": "no transcript on disk for this session"}
    # Everything before the last `clear` was redrawn by a session/load replay.
    last_clear = max((i for i, f in enumerate(frames) if f.get("kind") == "clear"), default=-1)
    return {"sessionId": session_id, "frames": frames[last_clear + 1:], "count": len(frames) - last_clear - 1}


def tasks_route(manager, folder, feature, home=None):
    """``GET kas/tasks?folder&feature``: KAS's task metadata for one spec plus the feature's spec session."""
    home = home or os.path.expanduser("~")
    if not isinstance(folder, str) or not folder or not isinstance(feature, str) or not re.match(r"^[A-Za-z0-9._-]{1,120}$", feature):
        return (400, {"error": "folder and a kebab-case feature are required"})
    # The spec session and its task metadata sit under the hash of the path the IDE passed to
    # resolveSession (see ws_hashes); the first hash whose metadata or spec-session file exists wins.
    hashes = ws_hashes(folder)
    h = hashes[0]
    for cand in hashes:
        if os.path.isfile(os.path.join(home, ".kiro", "tasks", cand, feature + ".meta.json")) or os.path.isfile(os.path.join(home, ".kiro", "spec-sessions", cand + ".json")):
            h = cand
            break
    meta_path = os.path.join(home, ".kiro", "tasks", h, feature + ".meta.json")
    meta = _read_json_retry(meta_path)
    sessions_path = os.path.join(home, ".kiro", "spec-sessions", h + ".json")
    spec_sessions = _read_json_retry(sessions_path) or {}
    tasks = {}
    for task_id, row in ((meta or {}).get("tasks") or {}).items():
        if isinstance(row, dict):
            history = row.get("executionHistory") or []
            last = history[-1] if history else {}
            tasks[task_id] = {"executionStatus": row.get("executionStatus"), "lastSessionId": last.get("chatSessionId"),
                              "lastExecutionId": last.get("executionId"), "updatedAt": row.get("updatedAt")}
    return {"wsHash": h, "feature": feature, "tasks": tasks, "specSessionId": spec_sessions.get(feature) if isinstance(spec_sessions, dict) else None,
            "metaPath": meta_path, "exists": meta is not None, "mtime": _mtime(meta_path)}


def _read_json_retry(path):
    """A JSON file KAS may be rewriting: one retry after a parse error, ``None`` when absent."""
    for attempt in (0, 1):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except OSError:
            return None
        except ValueError:
            if attempt:
                return None
            time.sleep(0.05)
    return None


def _ms_to_s(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v / 1000.0 if v > 1e11 else v


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None
