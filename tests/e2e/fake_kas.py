#!/usr/bin/env python3
"""A scripted ACP server standing in for ``kiro-cli acp --agent-engine v3``.

Speaks newline JSON-RPC 2.0 on stdio the way KAS does (measured on 2.22.1 and
3.3.0, see the spec's design §Probe results) so the hook's client and the
bridge can be exercised without a login or a model:

* ``initialize`` -> capabilities with ``loadSession``; ``session/new`` -> a new
  ``sess_fake_…`` id, the five bundled modes and the ``mode/model/autopilot``
  config options; ``session/set_mode`` / ``session/set_config_option`` accepted
  and echoed as ``current_mode_update`` / ``config_option_update``.
* ``session/prompt`` streams ``user_message_chunk``, ``agent_thought_chunk``,
  two ``agent_message_chunk``, a ``tool_call`` whose approval is asked with a
  ``session/request_permission`` request when the text says ``permission``
  (twice, 100 ms apart, like KAS's bursts), a ``_kiro/userInput`` request when
  it says ``ask``, slow chunks when it says ``slow`` (so ``session/cancel`` can
  land), then ``session_info_update`` ``turn_end`` and ``{stopReason}``.
* ``session/load`` replays the recorded history as ``user_message_chunk`` /
  ``agent_message_chunk`` and restores the mode; history lives under
  ``$FAKE_KAS_STATE`` (default ``<cwd>/.fake-kas``) so a second process loads it.
* ``_kiro/spec/resolveSession`` / ``invoke`` / ``getTaskStatuses``: ``invoke``
  returns ``{sessionId, executionId}`` at once, then streams
  ``_kiro/spec/taskStatusChanged`` queued -> running -> succeed, rewrites the
  task's box to ``[x]`` through the client's ``fs/write_text_file``, writes the
  ``~/.kiro``-style meta file under ``$FAKE_KAS_STATE/tasks/<wsHash>/`` and ends
  the turn; ``createSpec`` asks one ``_kiro/userInput`` question, writes
  ``requirements.md`` through ``fs/write_text_file`` and fires ``phaseCheckpoint``.
* ``fs/*`` are the client's; this server asks for them and waits.

Switches (environment): ``FAKE_KAS_NOT_LOGGED_IN=1`` makes ``session/new``
fail with KAS's -32000 login error; ``FAKE_KAS_CRASH_ON_PROMPT=1`` exits with
code 3 after the first chunk of a prompt; ``FAKE_KAS_HOLD=<sessionId>`` refuses
``session/prompt`` on that session with ``SessionHeldElsewhereError``.
Like kiro-cli, it does NOT exit when stdin closes unless ``FAKE_KAS_EXIT_ON_EOF``
is set. ``--version`` prints a version line; ``acp --help`` mentions
``--agent-engine``, so the hook's resolution accepts it as a kiro-cli.
Python 3.9, stdlib only, single-threaded reader with a worker thread per turn.
"""
import hashlib
import json
import os
import queue
import re
import sys
import threading
import time
import uuid

STATE = os.environ.get("FAKE_KAS_STATE") or os.path.join(os.getcwd(), ".fake-kas")
MODES = [
    {"id": "vibe", "name": "Default", "description": "General coding assistance", "_meta": {"kiro": {"source": "bundled"}}},
    {"id": "spec", "name": "Spec", "description": "Structured feature development", "_meta": {"kiro": {"source": "bundled"}}},
    {"id": "quick-spec", "name": "Quick Spec", "description": "Fast spec workflow", "_meta": {"kiro": {"source": "bundled"}}},
    {"id": "bug-fix", "name": "Bug Fix", "description": "Structured bug-fix workflow", "_meta": {"kiro": {"source": "bundled"}}},
    {"id": "plan", "name": "Plan", "description": "Plan-only mode", "_meta": {"kiro": {"source": "bundled"}}},
    {"id": "my-agent", "name": "my-agent", "description": "a user agent"},
]
LOGIN_ERROR = {"code": -32000, "message": "Authentication required. Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first. Then reconnect to start the Kiro agent."}
TASK_LINE_RE = re.compile(r"^(\s*)([-*+])\s+\[([ xX\-~])\](\\?\*?)\s+(.+)$")

_out_lock = threading.Lock()
_next_id = [1]
_pending = {}          # id -> queue for client responses to OUR requests
_sessions = {}         # sid -> {"mode", "history": [...], "autopilot", "cwd"}
_cancelled = set()


def send(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def update(sid, body):
    body = dict(body)
    notify("session/update", {"sessionId": sid, "update": body})


def ask_client(method, params, timeout=30.0):
    """A server->client request; blocks the calling worker until the client answers."""
    rid = _next_id[0]
    _next_id[0] += 1
    q = queue.Queue()
    _pending[rid] = q
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    try:
        return q.get(timeout=timeout)
    except queue.Empty:
        return {"error": {"code": -32603, "message": "client did not answer %s" % method}}
    finally:
        _pending.pop(rid, None)


def ws_hash(folder):
    return hashlib.sha256(folder.encode("utf-8")).hexdigest()[:16]


def _store_path(sid):
    return os.path.join(STATE, "sessions", sid + ".json")


def save_session(sid):
    s = _sessions.get(sid)
    if not s:
        return
    os.makedirs(os.path.dirname(_store_path(sid)), exist_ok=True)
    with open(_store_path(sid), "w") as fh:
        json.dump(s, fh)


def load_session(sid):
    try:
        with open(_store_path(sid)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def session_result(sid):
    s = _sessions[sid]
    return {
        "sessionId": sid,
        "modes": {"currentModeId": s["mode"], "availableModes": MODES},
        "configOptions": config_options(s),
        "_meta": {"agentMode": s["mode"], "title": s.get("title") or "", "workspacePaths": [s["cwd"]]},
    }


def config_options(s):
    return [
        {"id": "mode", "type": "select", "name": "Mode", "currentValue": s["mode"], "options": [{"value": m["id"], "name": m["name"]} for m in MODES]},
        {"id": "model", "type": "select", "name": "Model", "currentValue": s.get("model") or "auto", "options": [{"value": "auto", "name": "Auto"}, {"value": "fake-model", "name": "Fake"}]},
        {"id": "autopilot", "type": "select", "name": "Autopilot", "currentValue": "on" if s.get("autopilot") else "off", "options": [{"value": "on", "name": "Autopilot"}, {"value": "off", "name": "Supervised"}]},
    ]


def turn_frames(sid, kind, extra=None):
    body = {"sessionUpdate": "session_info_update", "_meta": {"kiro": dict({"kind": kind}, **(extra or {}))}}
    update(sid, body)


def run_prompt(sid, blocks, rid):
    s = _sessions[sid]
    text = " ".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    images = [b for b in blocks if b.get("type") == "image"]
    slow = "slow" in text
    pause = 0.6 if slow else 0.02
    s["history"].append({"role": "user", "text": text})
    if not s.get("title"):
        s["title"] = text[:60]
    save_session(sid)
    execution = str(uuid.uuid4())
    turn_frames(sid, "turn_start", {"executionId": execution, "turnId": execution})
    turn_frames(sid, "focus_update", {"status": "in_progress", "activity": {"turnActive": True}})
    update(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": text}})
    time.sleep(pause)
    update(sid, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Thinking about: " + text[:40]}})
    if os.environ.get("FAKE_KAS_CRASH_ON_PROMPT"):
        sys.stderr.write("fake-kas: crashing on purpose\n")
        sys.stderr.flush()
        os._exit(3)
    reply = "Echo (%s): %s" % (s["mode"], text)
    if images:
        reply += " [+%d image(s), %s]" % (len(images), ",".join(str(i.get("mimeType")) for i in images))
    stop = "end_turn"
    for i in range(4 if slow else 1):
        if sid in _cancelled:
            stop = "cancelled"
            break
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply[:len(reply) // 2] if i == 0 else ""}})
        time.sleep(pause)
    if stop != "cancelled":
        if "permission" in text:
            tcid = "call_" + uuid.uuid4().hex[:8]
            update(sid, {"sessionUpdate": "tool_call", "toolCallId": tcid, "title": "Write File", "kind": "edit", "status": "pending",
                         "rawInput": {"path": "hello.txt", "content": "hello"}})
            turn_frames(sid, "focus_update", {"status": "waiting_on_user", "activity": {"turnActive": True}})
            options = [{"optionId": "accept", "name": "Allow", "kind": "allow_once"}, {"optionId": "always-accept", "name": "Always allow", "kind": "allow_always"},
                       {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]
            answers = []
            for _ in range(2):   # KAS asks in bursts; both must be answered
                answers.append(ask_client("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": tcid, "title": "Write File", "kind": "edit"}, "options": options}))
                time.sleep(0.1)
            outcome = ((answers[0].get("result") or {}).get("outcome") or {})
            granted = outcome.get("outcome") == "selected" and str(outcome.get("optionId", "")).startswith(("accept", "always"))
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": tcid, "status": "completed" if granted else "failed",
                         "content": [{"type": "content", "content": {"type": "text", "text": "wrote hello.txt" if granted else "rejected by user"}}]})
            reply += " | permission=%s" % ("granted" if granted else "denied")
        if "ask" in text:
            ans = ask_client("_kiro/userInput", {"sessionId": sid, "toolCallId": "call_q", "question": "**Pick one**",
                                                 "options": [{"title": "Alpha", "description": "first"}, {"title": "Beta", "recommended": True}]})
            chosen = ((ans.get("result") or {}).get("answer")) or "(no answer)"
            reply += " | answered=%s" % chosen
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply[len(reply) // 2:]}})
    s["history"].append({"role": "agent", "text": reply if stop != "cancelled" else "(cancelled)"})
    save_session(sid)
    _cancelled.discard(sid)
    turn_frames(sid, "turn_end", {"executionId": execution, "turnId": execution, "stopReason": stop})
    turn_frames(sid, "focus_update", {"status": "idle", "activity": {"turnActive": False}})
    send({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": stop}})


def parse_tasks(path):
    try:
        with open(path) as fh:
            lines = fh.read().split("\n")
    except OSError:
        return []
    tasks = []
    for line in lines:
        m = TASK_LINE_RE.match(line)
        if m and not m.group(1):
            mark = m.group(3).lower()
            tasks.append({"taskId": m.group(5).strip(), "markdownStatus": {"x": "completed", "-": "in_progress", "~": "queued"}.get(mark, "not_started"),
                          "isLeaf": True, "isOptional": bool(m.group(4)), "subTasks": []})
    return tasks


def run_invoke(params, rid):
    sid = params["sessionId"]
    s = _sessions[sid]
    op = params.get("operation")
    execution = str(uuid.uuid4())
    send({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": sid, "executionId": execution}})
    turn_frames(sid, "turn_start", {"executionId": execution, "turnId": execution})
    turn_frames(sid, "focus_update", {"status": "in_progress", "activity": {"turnActive": True}, "title": "%s: %s" % (op, params.get("featureName") or "")})
    if op == "createSpec":
        update(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": params.get("userPrompt") or ""}})
        ans = ask_client("_kiro/userInput", {"sessionId": sid, "toolCallId": "call_spec_q", "question": "**Is this a new feature or a bugfix?**",
                                             "options": [{"title": "Build a Feature"}, {"title": "Fix a Bug"}, {"title": "Quick Spec"}]})
        feature = re.sub(r"[^a-z0-9]+", "-", (params.get("userPrompt") or "feature").lower()).strip("-")[:30] or "feature"
        path = os.path.join(s["cwd"], ".kiro", "specs", feature, "requirements.md")
        ask_client("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": "call_w1", "title": "Write File", "kind": "edit"},
                                                  "options": [{"optionId": "accept", "name": "Allow", "kind": "allow_once"}, {"optionId": "reject", "name": "Reject", "kind": "reject_once"}]})
        ask_client("fs/write_text_file", {"sessionId": sid, "path": path, "content": "# Requirements\n\n(%s) %s\n" % (((ans.get("result") or {}).get("answer")), params.get("userPrompt"))})
        notify("_kiro/spec/phaseCheckpoint", {"sessionId": sid, "featureName": feature, "phase": "requirements", "artifactPath": path})
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Requirements written to " + path}})
    elif op in ("executeTask", "runAllTasks"):
        tasks_path = params.get("tasksFilePath")
        tasks = parse_tasks(tasks_path)
        todo = [t for t in tasks if t["markdownStatus"] != "completed" and (op == "runAllTasks" or t["taskId"] == params.get("taskId"))]
        if op == "executeTask" and not todo:
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Task %r not found or already done" % params.get("taskId")}})
        meta_dir = os.path.join(STATE, "tasks", ws_hash(s["cwd"]))
        os.makedirs(meta_dir, exist_ok=True)
        meta_path = os.path.join(meta_dir, (params.get("featureName") or "feature") + ".meta.json")
        try:
            with open(meta_path) as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            meta = {"tasks": {}}
        for t in todo:
            tid = t["taskId"]
            for status in ("queued", "running"):
                notify("_kiro/spec/taskStatusChanged", {"sessionId": sid, "tasksFilePath": tasks_path,
                                                        "changes": [{"taskId": tid, "executionStatus": status, "lastSessionId": sid, "lastExecutionId": execution}]})
                meta["tasks"][tid] = {"taskId": tid, "specUri": tasks_path, "executionStatus": status, "updatedAt": int(time.time() * 1000),
                                      "executionHistory": [{"executionId": execution, "chatSessionId": sid, "timestamp": int(time.time() * 1000)}]}
                with open(meta_path, "w") as fh:
                    json.dump(meta, fh)
                time.sleep(0.05)
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Doing %s. " % tid}})
            # Tick the box through the client's fs (that is how KAS writes tasks.md).
            with open(tasks_path) as fh:
                text = fh.read()
            text = re.sub(r"^(\s*[-*+]\s+)\[[ \-~]\](\\?\*?\s+%s\s*)$" % re.escape(tid), r"\1[x]\2", text, count=1, flags=re.M)
            ask_client("fs/write_text_file", {"sessionId": sid, "path": tasks_path, "content": text})
            meta["tasks"][tid]["executionStatus"] = "succeed"
            with open(meta_path, "w") as fh:
                json.dump(meta, fh)
            notify("_kiro/spec/taskStatusChanged", {"sessionId": sid, "tasksFilePath": tasks_path,
                                                    "changes": [{"taskId": tid, "executionStatus": "succeed", "lastSessionId": sid, "lastExecutionId": execution}]})
        spec_sessions = os.path.join(STATE, "spec-sessions", ws_hash(s["cwd"]) + ".json")
        os.makedirs(os.path.dirname(spec_sessions), exist_ok=True)
        with open(spec_sessions, "w") as fh:
            json.dump({params.get("featureName") or "feature": sid}, fh)
    else:
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "fake %s done" % op}})
    s["history"].append({"role": "agent", "text": "fake %s" % op})
    save_session(sid)
    turn_frames(sid, "turn_end", {"executionId": execution, "turnId": execution, "stopReason": "end_turn"})
    turn_frames(sid, "focus_update", {"status": "idle", "activity": {"turnActive": False}})


def handle(req):
    method, params, rid = req.get("method"), req.get("params") or {}, req.get("id")

    def reply(result):
        if rid is not None:
            send({"jsonrpc": "2.0", "id": rid, "result": result})

    def fail(code, message, data=None):
        err = {"code": code, "message": message}
        if data:
            err["data"] = data
        send({"jsonrpc": "2.0", "id": rid, "error": err})

    if method == "initialize":
        reply({"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "promptCapabilities": {"image": True, "embeddedContext": True},
                                                            "sessionCapabilities": {"list": {}, "delete": {}},
                                                            "_meta": {"kiro": {"extensionMethods": ["_kiro/spec/resolveSession", "_kiro/spec/invoke", "_kiro/spec/getTaskStatuses"], "fake": True}}},
               "agentInfo": {"name": "fake-kas", "version": "0"}})
        return
    if method == "session/new":
        if os.environ.get("FAKE_KAS_NOT_LOGGED_IN"):
            sys.stderr.write("Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.\n")
            sys.stderr.flush()
            fail(LOGIN_ERROR["code"], LOGIN_ERROR["message"])
            return
        sid = "sess_fake_" + uuid.uuid4().hex[:12]
        _sessions[sid] = {"mode": "vibe", "history": [], "autopilot": False, "cwd": params.get("cwd") or os.getcwd(), "title": ""}
        save_session(sid)
        reply(session_result(sid))
        notify("_kiro/sessions/changed", {"sessionIds": [sid]})
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": []})
        return
    if method == "session/load":
        sid = params.get("sessionId")
        s = load_session(sid)
        if not s:
            fail(-32602, "Session not found: %s" % sid)
            return
        _sessions[sid] = s
        for h in s.get("history") or []:
            update(sid, {"sessionUpdate": "user_message_chunk" if h["role"] == "user" else "agent_message_chunk",
                         "content": {"type": "text", "text": h["text"]}, "_meta": {"kiro": {"replayId": uuid.uuid4().hex[:8]}}})
        update(sid, {"sessionUpdate": "current_mode_update", "currentModeId": s["mode"]})
        reply(session_result(sid))
        return
    if method == "session/delete":
        sid = params.get("sessionId")
        _sessions.pop(sid, None)
        try:
            os.remove(_store_path(sid))
        except OSError:
            pass
        reply({})
        return
    sid = params.get("sessionId")
    if method in ("session/set_mode", "session/set_config_option", "session/prompt", "session/cancel", "_kiro/spec/invoke") and sid not in _sessions:
        fail(-32602, "Session not found: %s" % sid)
        return
    if method == "session/set_mode":
        _sessions[sid]["mode"] = params.get("modeId")
        save_session(sid)
        reply({})
        update(sid, {"sessionUpdate": "current_mode_update", "currentModeId": params.get("modeId")})
        return
    if method == "session/set_config_option":
        s = _sessions[sid]
        cid, value = params.get("configId"), params.get("value")
        if cid == "autopilot":
            s["autopilot"] = value == "on"
        elif cid == "model":
            s["model"] = value
        elif cid == "mode":
            s["mode"] = value
        else:
            fail(-32602, "unknown configId %r" % cid)
            return
        save_session(sid)
        reply({"configOptions": config_options(s)})
        update(sid, {"sessionUpdate": "config_option_update", "configOptions": config_options(s)})
        return
    if method == "session/prompt":
        if os.environ.get("FAKE_KAS_HOLD") == sid:
            fail(-32000, "This session is loaded in another program, kirocrew-ide (pid 1), which owns its execution. Close the session there to drive it from here.",
                 {"errorType": "SessionHeldElsewhereError"})
            return
        threading.Thread(target=run_prompt, args=(sid, params.get("prompt") or [], rid), daemon=True).start()
        return
    if method == "session/cancel":
        _cancelled.add(sid)
        return
    if method == "_kiro/spec/resolveSession":
        feature = params.get("featureName")
        if feature and params.get("strategy") == "reuse":
            spec_sessions = os.path.join(STATE, "spec-sessions", ws_hash((params.get("workspacePaths") or [os.getcwd()])[0]) + ".json")
            try:
                with open(spec_sessions) as fh:
                    existing = json.load(fh).get(feature)
            except (OSError, ValueError):
                existing = None
            if existing and (existing in _sessions or load_session(existing)):
                _sessions[existing] = _sessions.get(existing) or load_session(existing)
                reply({"sessionId": existing})
                return
        sid = "sess_fake_" + uuid.uuid4().hex[:12]
        _sessions[sid] = {"mode": "spec", "history": [], "autopilot": False, "cwd": (params.get("workspacePaths") or [os.getcwd()])[0], "title": feature or ""}
        save_session(sid)
        reply({"sessionId": sid})
        return
    if method == "_kiro/spec/invoke":
        threading.Thread(target=run_invoke, args=(params, rid), daemon=True).start()
        return
    if method == "_kiro/spec/getTaskStatuses":
        tasks = parse_tasks(params.get("tasksFilePath") or "")
        meta_path = os.path.join(STATE, "tasks", ws_hash((params.get("workspacePaths") or [os.getcwd()])[0]), (params.get("featureName") or "feature") + ".meta.json")
        try:
            with open(meta_path) as fh:
                meta = json.load(fh).get("tasks") or {}
        except (OSError, ValueError):
            meta = {}
        for t in tasks:
            row = meta.get(t["taskId"])
            if row:
                t["executionStatus"] = row.get("executionStatus")
                t["lastSessionId"] = (row.get("executionHistory") or [{}])[-1].get("chatSessionId")
        reply({"tasks": tasks})
        return
    if rid is not None:
        fail(-32601, "Method not found: %s" % method)


def main():
    args = sys.argv[1:]
    if "--version" in args:
        print("kiro-cli 9.9.9-fake")
        return 0
    if args[:1] == ["acp"] and "--help" in args:
        print("Start Agent Client Protocol (ACP) agent\n\nOptions:\n      --agent-engine <ENGINE>  v2|v1|v3\n      --auth-method <METHOD>   cli|client")
        return 0
    os.makedirs(STATE, exist_ok=True)
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if "method" in obj:
            try:
                handle(obj)
            except Exception as error:  # noqa: BLE001
                if obj.get("id") is not None:
                    send({"jsonrpc": "2.0", "id": obj["id"], "error": {"code": -32603, "message": "%s: %s" % (type(error).__name__, error)}})
        elif "id" in obj:
            q = _pending.get(obj["id"])
            if q is not None:
                q.put(obj)
    if os.environ.get("FAKE_KAS_EXIT_ON_EOF"):
        return 0
    sys.stderr.write("error: the v3 engine did not exit within 5 seconds after ACP stdin closed\n")
    sys.stderr.flush()
    while True:   # like kiro-cli: lives until signalled
        time.sleep(3600)


if __name__ == "__main__":
    sys.exit(main())
