"""The hook's ACP client against the fake KAS (tests/e2e/fake_kas.py): requirement 10.1.

Covers: id matching under concurrent requests; SessionLog caps and replay
windows; a parked permission relayed as `ask` and answered by id (the second
request of KAS's burst answered from the first answer); Autopilot auto-answer
with no `ask` relayed; a userInput question; cancel; child exit mid-turn
(pending rejected, `childState exited` to the links, index `detached`); the
not-logged-in verdict on hello; folder refusal before any process starts;
attach replay with `since`, and session/load on a fresh child after the first
one is stopped (the `clear` frame, the replayed history); the idle reaper.

Run: python tests/kas_acp_test.py
"""
import asyncio
import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
KAS = os.path.join(HERE, "..", "hook", "kas.py")
FAKE = os.path.join(HERE, "e2e", "fake_kas.py")


def _load(path, name):
    sys.modules.setdefault("floofy", types.ModuleType("floofy"))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


kas = _load(KAS, "kirocrew_ide_kas_t")


class FakeLink:
    """What dispatch_op needs of a Kas_Link: attached sessions, a child and a frame sink."""

    def __init__(self):
        self.sessions = set()
        self.child = None
        self.frames = []

    def send(self, frame):
        self.frames.append(frame)

    def kinds(self):
        return [f.get("kind") for f in self.frames]

    def of(self, kind):
        return [f for f in self.frames if f.get("kind") == kind]

    async def wait_for(self, pred, timeout=15.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            hits = [f for f in self.frames if pred(f)]
            if hits:
                return hits
            await asyncio.sleep(0.02)
        raise AssertionError("no frame matched within %ss; got kinds %s" % (timeout, self.kinds()))


class Harness:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="kas-test-")
        self.data = os.path.join(self.tmp, "data")
        self.ws = os.path.join(self.tmp, "ws")
        self.other = os.path.join(self.tmp, "other")
        os.makedirs(self.ws)
        os.makedirs(self.other)
        self.state = os.path.join(self.tmp, "fake-state")
        wrapper = os.path.join(self.tmp, "kiro-cli")
        with open(wrapper, "w") as fh:
            fh.write("#!/bin/sh\nexec %s %s \"$@\"\n" % (sys.executable, FAKE))
        os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IEXEC)
        self.wrapper = wrapper
        self.config = {}
        self.logs = []
        os.environ["FAKE_KAS_STATE"] = self.state

    def manager(self, workspaces=None):
        return kas.KasManager(self.data, lambda: workspaces if workspaces is not None else [self.ws],
                             lambda key, default=None: self.config.get(key, default), self.logs.append,
                             which=lambda name: self.wrapper if name == "kiro-cli" else None)

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


async def hello(manager, folder):
    link = FakeLink()
    await kas.dispatch_op(manager, link, {"op": "hello", "folder": folder, "ref": "h1"})
    return link


async def test_session_log():
    log = kas.SessionLog("sess_x", max_messages=5, max_bytes=10 ** 9)
    for i in range(8):
        log.append({"kind": "update", "n": i})
    assert log.last_seq == 8 and log.first_seq == 4, (log.first_seq, log.last_seq)
    assert [f["n"] for f in log.replay(0)] == [3, 4, 5, 6, 7]
    assert [f["seq"] for f in log.replay(6)] == [7, 8]
    assert log.replay(8) == []
    small = kas.SessionLog("sess_y", max_messages=10 ** 6, max_bytes=120)
    for i in range(10):
        small.append({"kind": "update", "text": "x" * 20})
    assert small.bytes <= 120 and len(small.frames) < 10 and small.first_seq > 1, (small.bytes, len(small.frames))
    # On disk: reopened log continues numbering, so a stale `since` falls below first_seq.
    path = os.path.join(tempfile.mkdtemp(prefix="kas-log-"), "a", "sess_z.ndjson")
    disk = kas.SessionLog("sess_z", path)
    disk.append({"kind": "update", "a": 1})
    disk.append({"kind": "update", "a": 2})
    disk.close()
    again = kas.SessionLog("sess_z", path)
    assert again.last_seq == 2 and again.first_seq == 3, (again.first_seq, again.last_seq)
    again.append({"kind": "update", "a": 3})
    rows = kas.SessionLog.read_file(path)
    assert [r["seq"] for r in rows] == [1, 2, 3] and all(r["sessionId"] == "sess_z" for r in rows)
    print("ok session log")


async def test_folder_refusal(h):
    m = h.manager()
    link = FakeLink()
    try:
        await kas.dispatch_op(m, link, {"op": "hello", "folder": h.other})
        raise AssertionError("hello for a folder the engine has not open must fail")
    except kas.AcpError as error:
        assert h.other in error.message and "not open" in error.message, error.message
    assert not m.children, "no child may be spawned for a refused folder"
    # frame validation: unknown op, wrong types
    for bad in ({"op": "nope"}, {"op": "prompt", "sessionId": 3, "blocks": []}, {"op": "attach", "sessionId": "s", "since": "1"}, []):
        try:
            kas.validate_frame(bad)
            raise AssertionError("accepted %r" % (bad,))
        except kas.AcpError:
            pass
    print("ok folder refusal + frame validation")


async def test_chat_roundtrip(h):
    m = h.manager()
    link = await hello(m, h.ws)
    hi = link.of("hello")[0]
    assert hi["ref"] == "h1" and hi["login"] is True and {x["id"] for x in hi["modes"] if x["bundled"]} >= {"spec", "quick-spec", "bug-fix", "plan"}, hi
    assert "autopilot" in hi["configOptions"], hi["configOptions"]
    child = link.child
    assert child.client.alive and child.ready
    # the scratch session used to learn the modes was deleted
    assert not os.listdir(os.path.join(h.state, "sessions")), os.listdir(os.path.join(h.state, "sessions"))

    # id matching: two concurrent requests get their own answers
    a, b = await asyncio.gather(child.client.request("session/new", {"cwd": h.ws, "mcpServers": []}),
                                child.client.request("session/new", {"cwd": h.ws, "mcpServers": []}))
    assert a["sessionId"] != b["sessionId"]
    for sid in (a["sessionId"], b["sessionId"]):
        await child.client.request("session/delete", {"sessionId": sid})

    # new + prompt in plan mode
    await kas.dispatch_op(m, link, {"op": "new", "mode": "plan", "ref": "n1", "tabRef": "tab-1"})
    created = link.of("created")[0]
    sid = created["sessionId"]
    assert created["mode"] == "plan" and created["tabRef"] == "tab-1" and sid in link.sessions
    await kas.dispatch_op(m, link, {"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "hello there"}], "ref": "p1"})
    assert link.of("accepted")[0]["ref"] == "p1"
    await link.wait_for(lambda f: f.get("kind") == "turnEnd")
    updates = [f["update"]["sessionUpdate"] for f in link.of("update")]
    assert "agent_message_chunk" in updates and "agent_thought_chunk" in updates and "user_message_chunk" in updates, updates
    text = "".join(f["update"]["content"]["text"] for f in link.of("update") if f["update"]["sessionUpdate"] == "agent_message_chunk")
    assert text == "Echo (plan): hello there", text
    end = link.of("turnEnd")[0]
    assert end["stopReason"] == "end_turn" and end["sessionId"] == sid and end["seq"] > 0
    seqs = [f["seq"] for f in link.frames if "seq" in f]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), seqs
    entry = m.index[sid]
    assert entry["title"] == "hello there" and entry["mode"] == "plan" and entry["state"] == "idle", entry
    assert os.path.isfile(os.path.join(h.data, "kas", child.ws_hash, sid + ".ndjson"))
    print("ok chat roundtrip")
    return m, link, sid


async def test_attach_replay(m, link, sid):
    # attach from a second link with a `since`: only what it missed
    other = FakeLink()
    other.child = link.child
    link.child.links.add(other)
    last = max(f["seq"] for f in link.frames if "seq" in f)
    await kas.dispatch_op(m, other, {"op": "attach", "sessionId": sid, "since": last - 3, "ref": "a1"})
    att = other.of("attached")[0]
    assert att["cleared"] is False and att["lastSeq"] == last and att["mode"] == "plan", att
    replayed = [f["seq"] for f in other.frames if "seq" in f]
    assert replayed == [last - 2, last - 1, last], (replayed, last)
    # since older than the ring → cleared=true, everything
    third = FakeLink()
    third.child = link.child
    link.child.links.add(third)
    link.child.sessions[sid].log.first_seq = 5  # pretend seqs 1-4 were dropped
    await kas.dispatch_op(m, third, {"op": "attach", "sessionId": sid, "since": 2})
    assert third.of("attached")[0]["cleared"] is True
    link.child.sessions[sid].log.first_seq = 1
    print("ok attach replay windows")


async def test_permission_and_answer(m, link, sid):
    before = len(link.frames)
    await kas.dispatch_op(m, link, {"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "needs permission please"}]})
    asks = await link.wait_for(lambda f: f.get("kind") == "ask")
    ask = asks[0]
    assert ask["ask"] == "permission" and ask["title"] == "Write File" and ask["options"][0]["kind"] == "allow_once", ask
    await asyncio.sleep(0.4)  # the burst's second request must not surface as a second ask
    assert len(link.of("ask")) == 1, link.of("ask")
    assert m.index_rows()[0]["pendingAsks"] == 1
    await kas.dispatch_op(m, link, {"op": "answer", "requestId": ask["requestId"], "optionId": "accept"})
    await link.wait_for(lambda f: f.get("kind") == "turnEnd" and f["seq"] > ask["seq"])
    resolved = link.of("askResolved")
    assert resolved and resolved[-1]["requestId"] == ask["requestId"] and resolved[-1]["optionId"] == "accept"
    text = "".join(f["update"]["content"]["text"] for f in link.frames[before:] if f.get("kind") == "update" and f["update"]["sessionUpdate"] == "agent_message_chunk")
    assert "permission=granted" in text, text
    tool_updates = [f["update"] for f in link.frames[before:] if f.get("kind") == "update" and f["update"]["sessionUpdate"] == "tool_call_update"]
    assert tool_updates and tool_updates[0]["status"] == "completed"
    # answering an unknown id is an error
    try:
        await kas.dispatch_op(m, link, {"op": "answer", "requestId": 999999})
        raise AssertionError("unknown request id accepted")
    except kas.AcpError:
        pass
    print("ok permission parked, relayed, answered by id")


async def test_autopilot(m, link, sid):
    before = len(link.frames)
    await kas.dispatch_op(m, link, {"op": "config", "sessionId": sid, "autopilot": True, "ref": "c1"})
    conf = link.of("configured")[0]
    assert conf["autopilot"] is True and any(o["id"] == "autopilot" and o["currentValue"] == "on" for o in conf["configOptions"]), conf
    await kas.dispatch_op(m, link, {"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "permission again"}]})
    await link.wait_for(lambda f: f.get("kind") == "turnEnd" and link.frames.index(f) >= before)
    assert not [f for f in link.frames[before:] if f.get("kind") == "ask"], "autopilot must answer without relaying"
    text = "".join(f["update"]["content"]["text"] for f in link.frames[before:] if f.get("kind") == "update" and f["update"]["sessionUpdate"] == "agent_message_chunk")
    assert "permission=granted" in text, text
    await kas.dispatch_op(m, link, {"op": "config", "sessionId": sid, "autopilot": False})
    print("ok autopilot auto-answer")


async def test_user_input(m, link, sid):
    before = len(link.frames)
    await kas.dispatch_op(m, link, {"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "ask me"}]})
    asks = await link.wait_for(lambda f: f.get("kind") == "ask" and link.frames.index(f) >= before)
    ask = asks[0]
    assert ask["ask"] == "userInput" and ask["question"] == "**Pick one**" and [o["title"] for o in ask["options"]] == ["Alpha", "Beta"], ask
    await kas.dispatch_op(m, link, {"op": "answer", "requestId": ask["requestId"], "answer": "Beta"})
    await link.wait_for(lambda f: f.get("kind") == "turnEnd" and link.frames.index(f) >= before)
    text = "".join(f["update"]["content"]["text"] for f in link.frames[before:] if f.get("kind") == "update" and f["update"]["sessionUpdate"] == "agent_message_chunk")
    assert "answered=Beta" in text, text
    print("ok userInput question card path")


async def test_cancel(m, link, sid):
    before = len(link.frames)
    await kas.dispatch_op(m, link, {"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "slow one"}]})
    await link.wait_for(lambda f: f.get("kind") == "update" and f["update"]["sessionUpdate"] == "agent_message_chunk" and link.frames.index(f) >= before)
    await kas.dispatch_op(m, link, {"op": "cancel", "sessionId": sid})
    ends = await link.wait_for(lambda f: f.get("kind") == "turnEnd" and link.frames.index(f) >= before)
    assert ends[0]["stopReason"] == "cancelled", ends[0]
    print("ok cancel → stopReason cancelled")


async def test_spec_ops(m, link):
    ws = link.child.folder
    spec = os.path.join(ws, ".kiro", "specs", "feat")
    os.makedirs(spec, exist_ok=True)
    tasks_path = os.path.join(spec, "tasks.md")
    with open(tasks_path, "w") as fh:
        fh.write("# Plan\n\n- [ ] 1. First thing\n  - _Requirements: 1_\n- [ ] 2. Second thing\n")
    await kas.dispatch_op(m, link, {"op": "spec", "method": "_kiro/spec/resolveSession", "params": {"featureName": "feat", "strategy": "reuse"}, "ref": "s1"})
    res = link.of("specResult")[0]
    sid = res["result"]["sessionId"]
    assert res["ref"] == "s1" and sid in link.sessions
    before = len(link.frames)
    await kas.dispatch_op(m, link, {"op": "spec", "method": "_kiro/spec/invoke", "ref": "s2",
                                    "params": {"operation": "executeTask", "sessionId": sid, "featureName": "feat", "specDocuments": [tasks_path], "tasksFilePath": tasks_path, "taskId": "1. First thing"}})
    inv = [f for f in link.of("specResult") if f["ref"] == "s2"][0]
    assert inv["result"]["executionId"]
    state = link.child.sessions[sid]
    assert state.autopilot is True, "task runs turn Autopilot on"
    ends = await link.wait_for(lambda f: f.get("kind") == "turnEnd" and f.get("sessionId") == sid and link.frames.index(f) >= before)
    assert ends[0].get("source") == "invoke", ends[0]
    events = [f for f in link.frames[before:] if f.get("kind") == "specEvent"]
    statuses = [c["executionStatus"] for f in events for c in f["params"]["changes"]]
    assert statuses == ["queued", "running", "succeed"], statuses
    with open(tasks_path) as fh:
        text = fh.read()
    assert "- [x] 1. First thing" in text and "- [ ] 2. Second thing" in text, text
    assert m.index[sid]["feature"] == "feat"
    # the task metadata route reads the fake's ~/.kiro-shaped tree
    doc = kas.tasks_route(m, ws, "feat", home=None if False else _fake_home(h_state=os.environ["FAKE_KAS_STATE"]))
    assert doc["tasks"]["1. First thing"]["executionStatus"] == "succeed" and doc["specSessionId"] == sid, doc
    # The IDE may spell the folder through a symlink (a /home → /local/home desk): the route tries
    # that spelling's hash too and finds the metadata KAS filed under the real path's hash.
    alias = os.path.join(os.path.dirname(ws), "alias-to-ws")
    if not os.path.islink(alias):
        os.symlink(ws, alias)
    via_alias = kas.tasks_route(m, alias, "feat", home=_fake_home(os.environ["FAKE_KAS_STATE"]))
    assert via_alias["exists"] and via_alias["wsHash"] == doc["wsHash"] and via_alias["specSessionId"] == sid, via_alias
    assert kas.ws_hashes(alias)[0] != kas.ws_hashes(alias)[1] and kas.ws_hashes(ws) == [kas.ws_hash(ws)]
    print("ok spec passthrough + taskStatusChanged relay + autopilot for executeTask")


def _fake_home(h_state):
    """The fake writes tasks/ and spec-sessions/ under FAKE_KAS_STATE; the route expects them under <home>/.kiro."""
    home = os.path.join(os.path.dirname(h_state), "fake-home")
    kiro = os.path.join(home, ".kiro")
    os.makedirs(home, exist_ok=True)
    if not os.path.islink(kiro):
        os.symlink(h_state, kiro)
    return home


async def test_sessions_and_transcript_routes(m, link, sid):
    doc = kas.sessions_route(m, home=_fake_home(os.environ["FAKE_KAS_STATE"]))
    ids = [r["sessionId"] for r in doc["sessions"]]
    assert sid in ids and doc["count"] == len(ids)
    mine = [r for r in doc["sessions"] if r["sessionId"] == sid][0]
    assert mine["source"] == "hook" and mine["transcript"] is True and mine["mode"] == "plan", mine
    # a KAS-only session (never relayed) is listed from the fake's store with transcript=false
    fake_only = "sess_fake_kasonly01"
    folder = link.child.folder
    with open(os.path.join(os.environ["FAKE_KAS_STATE"], "sessions", fake_only + ".json"), "w") as fh:
        json.dump({"mode": "spec", "history": [], "cwd": folder, "title": "elsewhere"}, fh)
    kas_dir = os.path.join(os.environ["FAKE_KAS_STATE"], "sessions", link.child.ws_hash, fake_only)
    os.makedirs(kas_dir, exist_ok=True)
    with open(os.path.join(kas_dir, "session.json"), "w") as fh:
        json.dump({"id": fake_only, "title": "elsewhere", "agentMode": "spec", "workspacePaths": [folder], "createdAt": 1794909785047}, fh)
    doc = kas.sessions_route(m, home=_fake_home(os.environ["FAKE_KAS_STATE"]))
    row = [r for r in doc["sessions"] if r["sessionId"] == fake_only][0]
    assert row["source"] == "kas" and row["transcript"] is False and row["title"] == "elsewhere" and abs(row["created"] - 1794909785.047) < 1, row
    tr = kas.transcript_route(m, sid)
    assert tr["count"] > 0 and tr["frames"][0]["seq"] >= 1 and all(f["sessionId"] == sid for f in tr["frames"])
    missing = kas.transcript_route(m, fake_only)
    assert missing["frames"] == [] and missing["reason"]
    assert kas.transcript_route(m, "../../etc/passwd")[0] == 400
    print("ok kas/sessions + transcript routes")


async def test_restart_and_load(h, m, link, sid):
    child = link.child
    old_pid = child.client.pid
    await child.stop("test")
    assert not child.client.alive
    assert child.ws_hash not in m.children  # on_child_exit removed it
    assert m.index[sid]["state"] == "detached"
    exited = link.of("childState")
    assert exited and exited[-1]["state"] == "exited" and exited[-1]["reason"] == "test", exited
    # attach again: a fresh child, session/load, clear + replayed history
    fresh = FakeLink()
    fresh.child = child          # the link still points at the dead child, as a bridge would
    before = len(fresh.frames)
    await kas.dispatch_op(m, fresh, {"op": "attach", "sessionId": sid, "since": 999, "ref": "re"})
    assert fresh.child is not child and fresh.child.client.pid != old_pid and fresh.child.client.alive
    att = fresh.of("attached")[0]
    assert att["loaded"] is True and att["cleared"] is True and att["mode"] == "plan", att
    kinds = [f.get("kind") for f in fresh.frames[before:] if "seq" in f]
    assert kinds[0] == "clear", kinds[:3]
    users = [f["update"]["content"]["text"] for f in fresh.frames if f.get("kind") == "update" and f["update"]["sessionUpdate"] == "user_message_chunk"]
    assert "hello there" in users and "needs permission please" in users, users
    # and it still answers prompts
    n = len(fresh.frames)
    await kas.dispatch_op(m, fresh, {"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "after reload"}]})
    await fresh.wait_for(lambda f: f.get("kind") == "turnEnd" and fresh.frames.index(f) >= n)
    tr = kas.transcript_route(m, sid)
    assert tr["frames"][0]["kind"] != "clear" and any(f.get("kind") == "turnEnd" for f in tr["frames"]), [f.get("kind") for f in tr["frames"]][:5]
    print("ok child stop → attach spawns, loads, replays with clear")
    return fresh


async def test_restart_index(h):
    """4.2: a new manager over the same data dir (a gateway restart) lists the sessions detached and spawns nothing until an attach."""
    m2 = h.manager()
    # 4.2: after a hook/gateway restart the index is read, every session is `detached`, and nothing
    # is spawned until a bridge attaches.
    rows = m2.index_rows()
    assert rows and all(r["state"] == "detached" for r in rows), rows
    assert not m2.children and m2.status()["workspaces"] == []
    relink = FakeLink()
    relink.child = type("Dead", (), {"folder": h.ws, "client": type("C", (), {"alive": False})(), "ready": False, "links": set()})()
    sid0 = rows[0]["sessionId"]
    await kas.dispatch_op(m2, relink, {"op": "attach", "sessionId": sid0, "since": 0})
    assert relink.of("attached")[0]["loaded"] is True and m2.children, "attach after a restart spawns a child and loads the session"
    await m2.stop_all()
    print("ok restart: index detached, attach spawns + loads")


async def test_crash_mid_turn(h):
    os.environ["FAKE_KAS_CRASH_ON_PROMPT"] = "1"
    try:
        m = h.manager()
        link = await hello(m, h.ws)
        await kas.dispatch_op(m, link, {"op": "new", "mode": "spec"})
        sid = link.of("created")[0]["sessionId"]
        child = link.child
        await kas.dispatch_op(m, link, {"op": "prompt", "sessionId": sid, "blocks": [{"type": "text", "text": "boom"}]})
        gone = await link.wait_for(lambda f: f.get("kind") == "childState" and f.get("state") == "exited")
        assert gone[0]["code"] == 3 and gone[0]["reason"] == "exited", gone[0]
        errs = await link.wait_for(lambda f: f.get("kind") == "error" and f.get("sessionId") == sid)
        assert "exited" in errs[0]["message"], errs[0]
        ends = link.of("turnEnd")
        assert ends and ends[-1]["stopReason"] == "error"
        assert not child.client.pending and m.index[sid]["state"] == "detached" and child.ws_hash not in m.children
        assert os.path.isfile(os.path.join(h.data, "kas", child.ws_hash + ".log"))
        assert any("crashing on purpose" in line for line in child.client.stderr_tail)
    finally:
        os.environ.pop("FAKE_KAS_CRASH_ON_PROMPT", None)
    print("ok crash mid-turn → pending rejected, exited frame, detached")


async def test_not_logged_in(h):
    os.environ["FAKE_KAS_NOT_LOGGED_IN"] = "1"
    try:
        m = h.manager()
        link = await hello(m, h.ws)
        hi = link.of("hello")[0]
        assert hi["login"] is False and "kiro-cli login" in hi["message"] and hi["modes"] == [], hi
        try:
            await kas.dispatch_op(m, link, {"op": "new", "mode": "spec"})
            raise AssertionError("new must fail without a login")
        except kas.AcpError as error:
            frame = kas.error_frame({"op": "new"}, error)
            assert frame["login"] is True, frame
        await m.stop_all()
    finally:
        os.environ.pop("FAKE_KAS_NOT_LOGGED_IN", None)
    print("ok not-logged-in verdict")


async def test_idle_reaper(h):
    h.config["kas.idle_minutes"] = 1
    m = h.manager()
    link = await hello(m, h.ws)
    child = link.child
    assert await m.reap_idle() == []                     # a link is attached
    child.links.discard(link)
    child.last_idle_at = time.time() - 30
    assert await m.reap_idle() == []                     # 30 s < 1 min
    child.last_idle_at = time.time() - 61
    assert await m.reap_idle() == [child.ws_hash] and not child.client.alive and not m.children
    h.config["kas.idle_minutes"] = 0
    link = await hello(m, h.ws)
    link.child.links.clear()
    link.child.last_idle_at = time.time() - 10 ** 6
    assert await m.reap_idle() == [], "0 = never"
    await m.stop_all()
    print("ok idle reaper")


async def test_status(h):
    m = h.manager()
    st = m.status()
    assert st["available"] is True and st["kiroCli"]["version"].startswith("kiro-cli 9.9.9") and st["kiroCli"]["engineOk"], st["kiroCli"]
    assert [x["id"] for x in st["modes"]] == ["spec", "quick-spec", "bug-fix", "plan"] and st["modesSource"] == "assumed"
    link = await hello(m, h.ws)
    st = m.status()
    assert st["modesSource"] == "child" and st["workspaces"][0]["attached"] == 1 and st["workspaces"][0]["pid"] == link.child.client.pid
    await m.stop_all()
    m2 = h.manager()   # a new manager (hook reload): modes come from the index cache
    assert m2.status()["modesSource"] == "cached"
    await m2.stop_all()
    missing = kas.KasManager(h.data, lambda: [h.ws], lambda k, d=None: None, h.logs.append, which=lambda name: None)
    saved, kas.HOME_CLI = kas.HOME_CLI, os.path.join(h.tmp, "nowhere", "kiro-cli")
    try:
        st = missing.status()
    finally:
        kas.HOME_CLI = saved
    assert st["available"] is False and "not found" in st["reason"], st
    print("ok kas/status")


async def main():
    await test_session_log()
    h = Harness()
    try:
        await test_folder_refusal(h)
        await test_status(h)
        m, link, sid = await test_chat_roundtrip(h)
        await test_attach_replay(m, link, sid)
        await test_permission_and_answer(m, link, sid)
        await test_autopilot(m, link, sid)
        await test_user_input(m, link, sid)
        await test_cancel(m, link, sid)
        await test_spec_ops(m, link)
        await test_sessions_and_transcript_routes(m, link, sid)
        fresh = await test_restart_and_load(h, m, link, sid)
        await m.stop_all()
        await test_restart_index(h)
        await test_crash_mid_turn(h)
        await test_not_logged_in(h)
        await test_idle_reaper(h)
    finally:
        h.cleanup()
    print("kas_acp_test: all passed")


if __name__ == "__main__":
    asyncio.run(main())
