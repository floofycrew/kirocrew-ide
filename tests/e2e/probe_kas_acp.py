#!/usr/bin/env python3
"""Live probe of `kiro-cli acp --agent-engine v3` for the Direct KAS modes design.

    probe_kas_acp.py static        grep the installed KAS bundle: gate placement, config ids, spec methods
    probe_kas_acp.py handshake     initialize + session/new: modes, configOptions, capabilities
    probe_kas_acp.py task          executeTask on a one-task fixture spec: taskStatusChanged + tasks meta.json
    probe_kas_acp.py dual          a second process session/load's a session the first still owns
    probe_kas_acp.py login         run with HOME at an empty dir and record the not-logged-in signal
    probe_kas_acp.py all           every live check in order

Results append to ``<scratch>/results.jsonl`` (one line per fact), every JSON-RPC
frame to ``<scratch>/frames.jsonl``. ``<scratch>`` is ``$PROBE_KAS_SCRATCH`` or
``.pt-scratch/kas-probe`` under the repo root (git-ignored, on disk, not /tmp).
Needs a logged-in kiro-cli on PATH (or ``$KIRO_CLI``). Python 3.9, stdlib only.

What this is for: design.md §Probe results holds the 2.22.1 run; this script is
the same client brought into the repo so the remaining open questions (KAS 3.x
gate placement, configOptions ids, the task phase, two clients on one session,
the login signal) can be re-run on any desk and the answers recorded.
"""
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRATCH = os.environ.get("PROBE_KAS_SCRATCH") or os.path.join(REPO, ".pt-scratch", "kas-probe")
FRAMES = os.path.join(SCRATCH, "frames.jsonl")
RESULTS = os.path.join(SCRATCH, "results.jsonl")
KIRO_CLI = os.environ.get("KIRO_CLI") or shutil.which("kiro-cli") or os.path.expanduser("~/.local/bin/kiro-cli")
CALL_TIMEOUT = 60.0
KIRO_META = {"specPhaseCheckpoints": True, "requirementsAnalysis": True, "specLinks": True, "userInput": True}


def now():
    return time.strftime("%H:%M:%S") + ".%03d" % int((time.time() % 1) * 1000)


def log(msg):
    sys.stderr.write("[%s] %s\n" % (now(), msg))
    sys.stderr.flush()


def result(key, value):
    os.makedirs(SCRATCH, exist_ok=True)
    with open(RESULTS, "a") as f:
        f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "key": key, "value": value}) + "\n")
    log("RESULT %s = %s" % (key, json.dumps(value)[:500]))


def ws_hash(folder):
    """KAS's workspace key: first 16 hex of sha256 over the folder path as given to session/new."""
    return hashlib.sha256(folder.encode("utf-8")).hexdigest()[:16]


class AcpClient:
    """A thread-based ACP client: enough to probe, not the hook's asyncio one."""

    def __init__(self, tag, cwd, env=None, answers=None):
        self.tag = tag
        self.cwd = cwd
        self.env = env
        self.proc = None
        self.next_id = 1
        self.pending = {}
        self.lock = threading.Lock()
        self.notifications = queue.Queue()
        self.server_requests = []
        self.answers = list(answers or [])
        self.permission_seen = 0
        self.userinput_seen = 0
        self.alive = True
        self.stderr_path = os.path.join(SCRATCH, "stderr-%s.log" % tag)

    def start(self):
        os.makedirs(SCRATCH, exist_ok=True)
        self.stderr_f = open(self.stderr_path, "ab")
        self.proc = subprocess.Popen(
            [KIRO_CLI, "acp", "--agent-engine", "v3", "--auth-method", "cli"],
            cwd=self.cwd, env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.stderr_f, bufsize=0)
        log("[%s] spawned %s pid=%d cwd=%s" % (self.tag, KIRO_CLI, self.proc.pid, self.cwd))
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _frame(self, direction, obj):
        with open(FRAMES, "a") as f:
            f.write(json.dumps({"t": now(), "tag": self.tag, "dir": direction, "frame": obj}) + "\n")

    def _send(self, obj):
        self._frame("out", obj)
        try:
            self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            log("[%s] stdin write failed: %r" % (self.tag, e))

    def _read_loop(self):
        for raw in self.proc.stdout:
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                obj = json.loads(text)
            except ValueError:
                self._frame("in-unparsed", text[:2000])
                continue
            self._frame("in", obj)
            self._dispatch(obj)
        self.alive = False
        log("[%s] stdout closed rc=%s" % (self.tag, self.proc.poll()))

    def _dispatch(self, obj):
        if "method" in obj and "id" in obj:
            self._server_request(obj)
        elif "method" in obj:
            self.notifications.put(obj)
        elif "id" in obj:
            with self.lock:
                q = self.pending.get(obj["id"])
            if q is not None:
                q.put(obj)

    def _server_request(self, req):
        method, params = req["method"], req.get("params") or {}
        self.server_requests.append(req)
        if method == "session/request_permission":
            self.permission_seen += 1
            options = params.get("options") or []
            chosen = next((o for k in ("allow_always", "allow_once") for o in options if o.get("kind") == k), None) \
                or (options[0] if options else None)
            tc = params.get("toolCall") or {}
            log("[%s] permission tool=%s title=%r -> %s" % (self.tag, tc.get("kind"), str(tc.get("title"))[:80],
                                                           chosen and chosen.get("optionId")))
            res = {"outcome": {"outcome": "selected", "optionId": chosen["optionId"]}} if chosen else {"outcome": {"outcome": "cancelled"}}
            self._send({"jsonrpc": "2.0", "id": req["id"], "result": res})
        elif method == "_kiro/userInput":
            self.userinput_seen += 1
            titles = [o.get("title") for o in (params.get("options") or [])]
            answer = None
            if self.answers:
                want = self.answers.pop(0)
                answer = next((t for t in titles if t and want.lower() in t.lower()), None)
            answer = answer or (titles[0] if titles else "yes")
            result("%s.userInput.%d" % (self.tag, self.userinput_seen),
                   {"question": str(params.get("question"))[:200], "options": titles, "answered": answer})
            self._send({"jsonrpc": "2.0", "id": req["id"], "result": {"action": "answered", "answer": answer}})
        elif method == "fs/read_text_file":
            try:
                with open(params["path"], "r", encoding="utf-8") as fh:
                    lines = fh.read().split("\n")
                line, limit = params.get("line") or 0, params.get("limit")
                sel = lines[line:line + limit] if limit else lines[line:]
                self._send({"jsonrpc": "2.0", "id": req["id"], "result": {"content": "\n".join(sel)}})
            except Exception as e:  # noqa: BLE001
                self._send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32603, "message": "%s: %s" % (type(e).__name__, e)}})
        elif method == "fs/write_text_file":
            try:
                path = params["path"]
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(params.get("content") or "")
                log("[%s] fs/write_text_file %s (%d bytes)" % (self.tag, path, len(params.get("content") or "")))
                self._send({"jsonrpc": "2.0", "id": req["id"], "result": {}})
            except Exception as e:  # noqa: BLE001
                self._send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32603, "message": "%s: %s" % (type(e).__name__, e)}})
        else:
            log("[%s] unhandled server request %s" % (self.tag, method))
            self._send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "probe client: method not supported"}})

    def call_async(self, method, params):
        with self.lock:
            rid = self.next_id
            self.next_id += 1
            q = queue.Queue()
            self.pending[rid] = q
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return rid, q

    def call(self, method, params, timeout=CALL_TIMEOUT):
        rid, q = self.call_async(method, params)
        try:
            return q.get(timeout=timeout)
        except queue.Empty:
            return {"__timeout__": True, "method": method, "after_s": timeout}
        finally:
            with self.lock:
                self.pending.pop(rid, None)

    def notify(self, method, params):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def drain(self, max_wait=0.0):
        out, deadline = [], time.time() + max_wait
        while True:
            remaining = deadline - time.time()
            try:
                out.append(self.notifications.get(timeout=max(0.01, remaining) if max_wait else 0.01))
            except queue.Empty:
                if time.time() >= deadline:
                    return out

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            self.proc.terminate()  # kiro-cli does not exit on stdin close (design §Probe results, obligation 1)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        log("[%s] kiro-cli rc=%s" % (self.tag, self.proc.poll()))

    def stderr_tail(self, n=4000):
        try:
            with open(self.stderr_path, "rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - n))
                return fh.read().decode("utf-8", "replace")
        except OSError:
            return ""


def initialize(c, gate_at=("clientCapabilities", "top")):
    caps = {"fs": {"readTextFile": True, "writeTextFile": True}}
    params = {"protocolVersion": 1, "clientInfo": {"name": "kirocrew-ide", "version": "probe"}, "clientCapabilities": caps}
    if "clientCapabilities" in gate_at:
        caps["_meta"] = {"kiro": dict(KIRO_META)}
    if "top" in gate_at:
        params["_meta"] = {"kiro": dict(KIRO_META)}
    return c.call("initialize", params, timeout=30)


def summarize(n):
    p = n.get("params") or {}
    u = p.get("update") or {}
    kind = u.get("sessionUpdate")
    out = {"kind": kind, "sid": p.get("sessionId")}
    if kind in ("agent_message_chunk", "user_message_chunk", "agent_thought_chunk"):
        out["text"] = ((u.get("content") or {}).get("text") or "")[:160]
    elif kind in ("tool_call", "tool_call_update"):
        out.update(title=u.get("title"), status=u.get("status"), toolKind=u.get("kind"), toolCallId=u.get("toolCallId"))
    elif kind == "current_mode_update":
        out["currentModeId"] = u.get("currentModeId")
    else:
        out["raw"] = json.dumps(u)[:160]
    return out


def bundled_modes(new_result):
    modes = (new_result or {}).get("modes") or {}
    rows = []
    for m in modes.get("availableModes") or []:
        source = ((m.get("_meta") or {}).get("kiro") or {}).get("source")
        rows.append({"id": m.get("id"), "name": m.get("name"), "source": source})
    return {"currentModeId": modes.get("currentModeId"), "all": rows,
            "bundled": [r["id"] for r in rows if r["source"] == "bundled"],
            "unsourced": [r["id"] for r in rows if not r["source"]]}


def config_options(res):
    return [{"id": o.get("id"), "type": o.get("type"), "name": o.get("name"), "category": o.get("category"),
             "currentValue": o.get("currentValue"),
             "options": [x.get("value") for x in (o.get("options") or [])][:12]}
            for o in ((res or {}).get("configOptions") or [])]


def kas_version():
    try:
        out = subprocess.run([KIRO_CLI, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception as e:  # noqa: BLE001
        out = "error: %s" % e
    return out


def bundle_path():
    base = os.path.expanduser("~/.local/share/kiro-cli/kas")
    ver = kas_version().split()[-1] if kas_version() else ""
    try:
        for d in sorted(os.listdir(base)):
            if d.startswith(ver + "-") and os.path.isdir(os.path.join(base, d)):
                return os.path.join(base, d, "node_modules", "@kiro", "agent", "dist", "server", "acp-server.js")
    except OSError:
        pass
    return None


# ------------------------------------------------------------------ checks

def cmd_static():
    path = bundle_path()
    result("static.bundle", path)
    if not path or not os.path.isfile(path):
        return
    with open(path, "rb") as fh:
        js = fh.read().decode("utf-8", "replace")
    gates = re.findall(r".{0,60}clientCapabilities\?\._meta\?\.kiro.{0,120}", js)
    result("static.gate_reads_clientCapabilities", len(gates))
    result("static.gate_reads_top_level", len(re.findall(r"[^.]\b[a-zA-Z]\._meta\?\.kiro\b", js)))
    result("static.gate_fields", sorted(set(re.findall(r"\b(specLinks|specPhaseCheckpoints|requirementsAnalysis|userInput):n\?\.", js))))
    ids = {}
    for name, val in re.findall(r"\b([A-Za-z0-9_$]{1,5})=\"(autopilot|model|mode|effortLevel|approveForMe|thinking|contentCollection|memoryReflection|workflowLaunch)\"", js):
        ids[val] = name
    result("static.config_option_ids", sorted(ids))
    result("static.spec_methods", sorted(set(re.findall(r"_kiro/spec/[A-Za-z]+", js))))
    result("static.session_methods", sorted(set(re.findall(r"\"(session/[a-z_]+)\"", js))))


def cmd_handshake():
    ws = os.path.join(SCRATCH, "ws-handshake")
    os.makedirs(ws, exist_ok=True)
    c = AcpClient("handshake", ws)
    c.start()
    try:
        init = initialize(c)
        result("handshake.initialize_ok", "result" in init)
        caps = (init.get("result") or {}).get("agentCapabilities") or {}
        result("handshake.agentCapabilities", {"loadSession": caps.get("loadSession"), "_meta_kiro_keys": sorted(((caps.get("_meta") or {}).get("kiro") or {}).keys()),
                                               "extensionMethods_has_spec": any("spec" in m for m in (((caps.get("_meta") or {}).get("kiro") or {}).get("extensionMethods") or []))})
        new = c.call("session/new", {"cwd": ws, "mcpServers": []}, timeout=90)
        result("handshake.session_new_ok", "result" in new)
        if "result" in new:
            r = new["result"]
            result("handshake.modes", bundled_modes(r))
            result("handshake.configOptions", config_options(r))
            result("handshake.session_new_meta_keys", sorted((r.get("_meta") or {}).keys()))
            sid = r["sessionId"]
            sm = c.call("session/set_mode", {"sessionId": sid, "modeId": "plan"})
            result("handshake.set_mode_plan", sm)
            sc = c.call("session/set_config_option", {"sessionId": sid, "configId": "autopilot", "value": "on"})
            result("handshake.set_autopilot_on", {"ok": "result" in sc, "autopilot_now": next((o.get("currentValue") for o in config_options(sc.get("result")) if o["id"] == "autopilot"), None)})
            notes = c.drain(1.0)
            result("handshake.notifications_after", sorted(set(n.get("method") for n in notes)))
            result("handshake.ws_dir", {"hash": ws_hash(ws), "exists": os.path.isdir(os.path.expanduser("~/.kiro/sessions/%s" % ws_hash(ws)))})
    finally:
        c.stop()


TASK_FIXTURE = {
    "requirements.md": "# Requirements\n\n## Requirement 1\n\n**User Story:** As a user, I want a greeting file.\n\n#### Acceptance Criteria\n\n1. WHEN the task runs THEN the system SHALL create `hello.txt` containing the word `hello`.\n",
    "design.md": "# Design\n\nOne file, `hello.txt`, written at the workspace root with the single word `hello`.\n",
    "tasks.md": "# Implementation Plan\n\n- [ ] 1. Create hello.txt\n  - Write the single word `hello` into `hello.txt` at the workspace root. Do not run any shell command; use the file write tool.\n  - _Requirements: 1_\n",
}


def run_until_quiet(c, sid, label, cap_s, quiet_s=25.0, on_note=None):
    """Watch notifications for a session until the stream has been quiet for `quiet_s` or `cap_s` passes."""
    start, last = time.time(), time.time()
    kinds, events = {}, []
    while time.time() - start < cap_s and c.alive:
        notes = c.drain(0.5)
        for n in notes:
            last = time.time()
            m = n.get("method")
            if m == "session/update":
                s = summarize(n)
                kinds[s["kind"]] = kinds.get(s["kind"], 0) + 1
            else:
                kinds[m] = kinds.get(m, 0) + 1
                if m and m.startswith("_kiro/spec/"):
                    events.append({"t": round(time.time() - start, 1), "method": m, "params": n.get("params")})
            if on_note:
                on_note(n)
        if time.time() - last > quiet_s and kinds:
            break
    result(label, {"elapsed_s": round(time.time() - start, 1), "update_kinds": kinds, "spec_events": events[:20],
                   "permissions": c.permission_seen, "userInputs": c.userinput_seen})
    return events


def cmd_task():
    ws = os.path.join(SCRATCH, "ws-task-%s" % time.strftime("%H%M%S"))
    spec = os.path.join(ws, ".kiro", "specs", "hello-file")
    os.makedirs(spec, exist_ok=True)
    for name, text in TASK_FIXTURE.items():
        with open(os.path.join(spec, name), "w") as fh:
            fh.write(text)
    docs = [os.path.join(spec, n) for n in ("requirements.md", "design.md", "tasks.md")]
    c = AcpClient("task", ws)
    c.start()
    try:
        init = initialize(c)
        result("task.initialize_ok", "result" in init)
        rs = c.call("_kiro/spec/resolveSession", {"featureName": "hello-file", "strategy": "reuse", "workspacePaths": [ws]}, timeout=90)
        result("task.resolveSession", rs)
        sid = (rs.get("result") or {}).get("sessionId")
        if not sid:
            return
        ap = c.call("session/set_config_option", {"sessionId": sid, "configId": "autopilot", "value": "on"})
        result("task.set_autopilot", {"ok": "result" in ap, "error": ap.get("error")})
        gs0 = c.call("_kiro/spec/getTaskStatuses", {"featureName": "hello-file", "tasksFilePath": docs[2], "workspacePaths": [ws]}, timeout=30)
        result("task.getTaskStatuses_before", gs0)
        # `taskId` is the task's full line text as getTaskStatuses reports it ("1. Create
        # hello.txt"), not the bare number: the bare "1" was refused with "Task "1" not found"
        # on 3.3.0 (first run of this probe, 2026-11-17).
        tasks = ((gs0.get("result") or {}).get("tasks") or [])
        task_id = tasks[0]["taskId"] if tasks else "1. Create hello.txt"
        inv = c.call("_kiro/spec/invoke", {"operation": "executeTask", "sessionId": sid, "featureName": "hello-file",
                                           "specDocuments": docs, "tasksFilePath": docs[2], "taskId": task_id}, timeout=60)
        result("task.invoke_executeTask", inv)
        meta_dir = os.path.expanduser("~/.kiro/tasks/%s" % ws_hash(ws))
        run_until_quiet(c, sid, "task.stream", cap_s=6 * 60)
        hello = os.path.join(ws, "hello.txt")
        with open(docs[2]) as fh:
            tasks_md = fh.read()
        result("task.outcome", {"hello_txt": os.path.isfile(hello) and open(hello).read()[:40], "tasks_md": tasks_md,
                                "meta_dir": meta_dir, "meta_files": sorted(os.listdir(meta_dir)) if os.path.isdir(meta_dir) else None})
        for name in (sorted(os.listdir(meta_dir)) if os.path.isdir(meta_dir) else []):
            try:
                with open(os.path.join(meta_dir, name)) as fh:
                    result("task.meta." + name, json.load(fh))
            except Exception as e:  # noqa: BLE001
                result("task.meta." + name, "unreadable: %s" % e)
        ss = os.path.expanduser("~/.kiro/spec-sessions/%s.json" % ws_hash(ws))
        result("task.spec_sessions_file", {"path": ss, "content": json.load(open(ss)) if os.path.isfile(ss) else None})
        gs1 = c.call("_kiro/spec/getTaskStatuses", {"featureName": "hello-file", "tasksFilePath": docs[2], "workspacePaths": [ws]}, timeout=30)
        result("task.getTaskStatuses_after", gs1)
    finally:
        c.stop()


def cmd_dual():
    ws = os.path.join(SCRATCH, "ws-dual")
    os.makedirs(ws, exist_ok=True)
    a = AcpClient("dualA", ws)
    a.start()
    b = None
    try:
        initialize(a)
        new = a.call("session/new", {"cwd": ws, "mcpServers": []}, timeout=90)
        sid = (new.get("result") or {}).get("sessionId")
        result("dual.session", sid)
        a.call("session/set_mode", {"sessionId": sid, "modeId": "plan"})
        rid, q = a.call_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Reply with the single word ONE and nothing else."}]})
        resp = None
        start = time.time()
        while time.time() - start < 90:
            try:
                resp = q.get(timeout=0.2)
                break
            except queue.Empty:
                a.drain(0.0)
        result("dual.A_prompt", resp)
        a.drain(1.0)
        b = AcpClient("dualB", ws)
        b.start()
        initialize(b)
        rid, q = b.call_async("session/load", {"sessionId": sid, "cwd": ws, "mcpServers": []})
        load, replay = None, []
        start = time.time()
        while time.time() - start < 60:
            try:
                load = q.get(timeout=0.2)
                break
            except queue.Empty:
                replay.extend(summarize(n) for n in b.drain(0.0) if n.get("method") == "session/update")
        replay.extend(summarize(n) for n in b.drain(1.5) if n.get("method") == "session/update")
        result("dual.B_load_while_A_alive", {"ok": load is not None and "result" in load, "error": (load or {}).get("error"),
                                             "replay_count": len(replay), "replay_user_text": [r.get("text") for r in replay if r["kind"] == "user_message_chunk"],
                                             "A_alive": a.alive})
        if load and "result" in load:
            rid, q = b.call_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Reply with the single word TWO and nothing else."}]})
            resp, a_saw, b_saw = None, [], []
            start = time.time()
            while time.time() - start < 90:
                try:
                    resp = q.get(timeout=0.2)
                    break
                except queue.Empty:
                    b_saw.extend(summarize(n) for n in b.drain(0.0) if n.get("method") == "session/update")
                    a_saw.extend(summarize(n) for n in a.drain(0.0) if n.get("method") == "session/update")
            a_saw.extend(summarize(n) for n in a.drain(1.0) if n.get("method") == "session/update")
            result("dual.B_prompt_after_load", {"stop": resp, "B_chunks": [r.get("text") for r in b_saw if r["kind"] == "agent_message_chunk"],
                                                "A_saw_B_turn": [r for r in a_saw if r["kind"] in ("agent_message_chunk", "user_message_chunk")][:6]})
            # Does A still own a usable handle?
            rid, q = a.call_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Reply with the single word THREE and nothing else."}]})
            resp, a_saw = None, []
            start = time.time()
            while time.time() - start < 90:
                try:
                    resp = q.get(timeout=0.2)
                    break
                except queue.Empty:
                    a_saw.extend(summarize(n) for n in a.drain(0.0) if n.get("method") == "session/update")
            result("dual.A_prompt_after_B_took_over", {"stop": resp, "A_chunks": [r.get("text") for r in a_saw if r["kind"] == "agent_message_chunk"]})
    finally:
        a.stop()
        if b:
            b.stop()


def cmd_login():
    home = os.path.join(SCRATCH, "empty-home")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    ws = os.path.join(SCRATCH, "ws-login")
    os.makedirs(ws, exist_ok=True)
    env = dict(os.environ)
    env["HOME"] = home
    env.pop("XDG_DATA_HOME", None)
    env.pop("XDG_CONFIG_HOME", None)
    c = AcpClient("login", ws, env=env)
    c.start()
    try:
        init = initialize(c)
        result("login.initialize", {"ok": "result" in init, "error": init.get("error"), "timeout": init.get("__timeout__")})
        new = c.call("session/new", {"cwd": ws, "mcpServers": []}, timeout=60) if "result" in init else None
        result("login.session_new", {"ok": bool(new and "result" in new), "error": (new or {}).get("error"), "timeout": (new or {}).get("__timeout__")})
        sid = ((new or {}).get("result") or {}).get("sessionId")
        if sid:
            rid, q = c.call_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Reply with the single word READY."}]})
            resp, saw = None, []
            start = time.time()
            while time.time() - start < 60 and c.alive:
                try:
                    resp = q.get(timeout=0.2)
                    break
                except queue.Empty:
                    saw.extend(n for n in c.drain(0.0))
            result("login.prompt", {"stop": resp, "notifications": [(n.get("method"), json.dumps(n.get("params"))[:300]) for n in saw][:10]})
        time.sleep(2)
        result("login.process", {"alive": c.alive, "rc": c.proc.poll()})
    finally:
        c.stop()
        result("login.stderr_tail", c.stderr_tail(3000))


COMMANDS = {"static": cmd_static, "handshake": cmd_handshake, "task": cmd_task, "dual": cmd_dual, "login": cmd_login}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    os.makedirs(SCRATCH, exist_ok=True)
    result("probe.start", {"cmd": cmd, "kiro_cli": KIRO_CLI, "version": kas_version(), "host": os.uname().nodename})
    if cmd == "all":
        for name in ("static", "handshake", "task", "dual", "login"):
            COMMANDS[name]()
    elif cmd in COMMANDS:
        COMMANDS[cmd]()
    else:
        print(__doc__)
        sys.exit(2)
