// node --test: the Kiro-mode (KAS) side of the bridge, pure parts (requirement 10.2).
// The Adapter kasFramesToMessages: one table row per ACP update kind of design §Adapter,
// sequence de-duplication and the attach/clear replay window, replayed user rows vs the
// live echo of a locally sent prompt, approval and question cards, turnEnd stop reasons,
// errors and a child exit. Also kasPicks (the picker group and its unavailable hint),
// kasPromptBlocks (contexts and attachments as ACP content blocks), kasPermissionChoice,
// the tab-state record round trip, and the webview script's new cases.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

class EventEmitter {
  constructor() { this._listeners = []; this.event = (fn) => { this._listeners.push(fn); return { dispose: () => { this._listeners = this._listeners.filter((l) => l !== fn); } }; }; }
  fire(e) { for (const l of this._listeners.slice()) l(e); }
  dispose() { this._listeners = []; }
}
const stub = {
  EventEmitter,
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  FileType: { Directory: 2 },
  Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }), parse: (s) => ({ toString: () => s }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
  window: { createOutputChannel: () => ({ appendLine() {} }) },
  commands: {},
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1 },
};
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode-stub";
  return originalResolve.call(this, request, ...rest);
};
require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: stub };
const ext = require(path.join(here, "..", "extension", "extension.js")).__test;
const { kasFramesToMessages, kasTabState, kasTabRecord, modePicks, MODES_SECTION, kasPromptBlocks, kasPermissionChoice, kasToolOutput, isKasTab, KAS_MODES, KAS_SECTION, chatHtml } = ext;

const upd = (seq, update, sessionId = "sess_1") => ({ kind: "update", seq, sessionId, update });
const text = (t) => ({ type: "text", text: t });

test("de-dup: a frame at or below lastSeq yields nothing; a newer one advances lastSeq", () => {
  const ts = kasTabState({ lastSeq: 5 });
  assert.deepEqual(kasFramesToMessages(upd(5, { sessionUpdate: "agent_message_chunk", content: text("x") }), ts), []);
  assert.deepEqual(kasFramesToMessages(upd(3, { sessionUpdate: "agent_message_chunk", content: text("x") }), ts), []);
  const out = kasFramesToMessages(upd(6, { sessionUpdate: "agent_message_chunk", content: text("hi") }), ts);
  assert.deepEqual(out, [{ type: "chunk", text: "hi", seq: 6 }]);
  assert.equal(ts.lastSeq, 6);
});

test("attached: cleared → clear + numbering restarts; the replay window is the attach's lastSeq", () => {
  const ts = kasTabState({ lastSeq: 40 });
  const out = kasFramesToMessages({ kind: "attached", sessionId: "sess_1", cleared: true, firstSeq: 1, lastSeq: 3, mode: "plan", running: false, autopilot: true, title: "Hello" }, ts);
  assert.equal(out[0].type, "clear");
  assert.deepEqual(out[1], { type: "_attached", running: false, mode: "plan", title: "Hello" });
  assert.equal(ts.lastSeq, 0);
  assert.equal(ts.replayUntil, 3);
  assert.equal(ts.mode, "plan");
  assert.equal(ts.autopilot, true);
  assert.equal(ts.state, "live");
  // not cleared: lastSeq is kept, nothing redrawn
  const ts2 = kasTabState({ lastSeq: 40 });
  const out2 = kasFramesToMessages({ kind: "attached", cleared: false, firstSeq: 1, lastSeq: 44, running: true }, ts2);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].type, "_attached");
  assert.equal(ts2.lastSeq, 40);
  assert.equal(ts2.running, true);
});

test("replayed user_message_chunks become one user row per message; the live echo of a local send is consumed", () => {
  const ts = kasTabState();
  kasFramesToMessages({ kind: "attached", cleared: true, firstSeq: 1, lastSeq: 4 }, ts);
  // replay (seq ≤ 4): two chunks of one user message, then the agent's answer
  assert.deepEqual(kasFramesToMessages(upd(1, { sessionUpdate: "user_message_chunk", content: text("hello ") }), ts), []);
  assert.deepEqual(kasFramesToMessages(upd(2, { sessionUpdate: "user_message_chunk", content: text("there") }), ts), []);
  const out = kasFramesToMessages(upd(3, { sessionUpdate: "agent_message_chunk", content: text("Hi!") }), ts);
  assert.equal(out[0].type, "row");
  assert.equal(out[0].row.role, "user");
  assert.equal(out[0].row.content, "hello there");
  assert.deepEqual(out[1], { type: "chunk", text: "Hi!", seq: 3 });
  const end = kasFramesToMessages({ kind: "turnEnd", seq: 4, stopReason: "end_turn" }, ts);
  assert.deepEqual(end, [{ type: "done" }]);
  // live: the bridge sent the prompt (accepted) → KAS's echo is not drawn again
  kasFramesToMessages({ kind: "accepted", op: "prompt" }, ts);
  assert.equal(ts.running, true);
  assert.deepEqual(kasFramesToMessages(upd(5, { sessionUpdate: "user_message_chunk", content: text("second") }), ts), []);
  const live = kasFramesToMessages(upd(6, { sessionUpdate: "agent_message_chunk", content: text("ok") }), ts);
  assert.deepEqual(live, [{ type: "chunk", text: "ok", seq: 6 }]);
  // live from another window (nothing sent here): the user row IS drawn
  kasFramesToMessages({ kind: "turnEnd", seq: 7, stopReason: "end_turn" }, ts);
  kasFramesToMessages(upd(8, { sessionUpdate: "user_message_chunk", content: text("from elsewhere") }), ts);
  const other = kasFramesToMessages(upd(9, { sessionUpdate: "agent_message_chunk", content: text("…") }), ts);
  assert.equal(other[0].row.content, "from elsewhere");
});

test("userPrompt (the hook's record of a prompt): drawn on replay, skipped live after a local send, and KAS's echo right after it is not drawn twice", () => {
  const ts = kasTabState();
  kasFramesToMessages({ kind: "attached", cleared: true, firstSeq: 1, lastSeq: 3 }, ts);
  assert.deepEqual(kasFramesToMessages({ kind: "userPrompt", seq: 1, text: "count to 40" }, ts), []);
  assert.deepEqual(kasFramesToMessages(upd(2, { sessionUpdate: "user_message_chunk", content: text("count to 40") }), ts), []);
  const out = kasFramesToMessages(upd(3, { sessionUpdate: "agent_message_chunk", content: text("1") }), ts);
  assert.equal(out.length, 2);
  assert.equal(out[0].row.role, "user");
  assert.equal(out[0].row.content, "count to 40");
  // live, sent from this window: neither the record nor the echo is drawn
  kasFramesToMessages({ kind: "accepted", op: "prompt" }, ts);
  assert.deepEqual(kasFramesToMessages({ kind: "userPrompt", seq: 4, text: "next" }, ts), []);
  assert.deepEqual(kasFramesToMessages(upd(5, { sessionUpdate: "user_message_chunk", content: text("next") }), ts), []);
  assert.deepEqual(kasFramesToMessages(upd(6, { sessionUpdate: "agent_message_chunk", content: text("ok") }), ts), [{ type: "chunk", text: "ok", seq: 6 }]);
  // live from another window: the record is drawn once
  kasFramesToMessages({ kind: "turnEnd", seq: 7, stopReason: "end_turn" }, ts);
  kasFramesToMessages({ kind: "userPrompt", seq: 8, text: "elsewhere" }, ts);
  const other = kasFramesToMessages(upd(9, { sessionUpdate: "agent_message_chunk", content: text("…") }), ts);
  assert.equal(other[0].row.content, "elsewhere");
  assert.equal(other.length, 2);
});

test("agent_thought_chunk → thinking; plan → status checklist; current_mode_update → _mode", () => {
  const ts = kasTabState();
  assert.deepEqual(kasFramesToMessages(upd(1, { sessionUpdate: "agent_thought_chunk", content: text("hmm") }), ts), [{ type: "thinking", text: "hmm" }]);
  const plan = kasFramesToMessages(upd(2, { sessionUpdate: "plan", entries: [{ content: "read", status: "completed" }, { content: "write", status: "in_progress" }, { content: "test", status: "pending" }] }), ts);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].type, "status");
  assert.equal(plan[0].text, "Plan:\n☑ read\n◐ write\n☐ test");
  assert.deepEqual(kasFramesToMessages(upd(3, { sessionUpdate: "current_mode_update", currentModeId: "bug-fix" }), ts), [{ type: "_mode", mode: "bug-fix" }]);
  assert.equal(ts.mode, "bug-fix");
  assert.deepEqual(kasFramesToMessages(upd(4, { sessionUpdate: "available_commands_update", availableCommands: [] }), ts), []);
});

test("tool_call → tool row with meta; tool_call_update → toolUpdate / toolResult; failed → ❌", () => {
  const ts = kasTabState();
  const call = kasFramesToMessages(upd(1, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Write File", kind: "edit", status: "pending", rawInput: { path: "a.txt" } }), ts);
  assert.equal(call.length, 1);
  assert.equal(call[0].type, "row");
  assert.equal(call[0].row.role, "tool");
  assert.equal(call[0].row.content, "Write File");
  assert.equal(call[0].row.meta.tool_call_id, "tc1");
  assert.equal(call[0].row.meta.tool_name, "edit");
  assert.deepEqual(call[0].row.meta.input, { path: "a.txt" });
  assert.equal(call[0].row.meta.done, false);
  assert.equal(call[0].row.meta.mid, "kas:1");
  const up = kasFramesToMessages(upd(2, { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "in_progress", title: "Write File a.txt" }), ts);
  assert.deepEqual(up, [{ type: "toolUpdate", tcid: "tc1", title: "Write File a.txt", input: undefined }]);
  const done = kasFramesToMessages(upd(3, { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", content: [{ type: "content", content: text("wrote 5 bytes") }] }), ts);
  assert.deepEqual(done, [{ type: "toolResult", tcid: "tc1", output: "wrote 5 bytes" }]);
  const failed = kasFramesToMessages(upd(4, { sessionUpdate: "tool_call_update", toolCallId: "tc2", status: "failed", content: [{ type: "content", content: text("denied") }] }), ts);
  assert.deepEqual(failed, [{ type: "toolResult", tcid: "tc2", output: "❌ denied" }]);
  // a tool_call that arrives already completed (a session/load replay) carries its result at once
  const replayed = kasFramesToMessages(upd(5, { sessionUpdate: "tool_call", toolCallId: "tc3", title: "Read", kind: "read", status: "completed", rawOutput: { lines: 3 } }), ts);
  assert.equal(replayed.length, 2);
  assert.equal(replayed[1].type, "toolResult");
  assert.match(replayed[1].output, /"lines": 3/);
  // a streaming answer is closed (segment) before a tool row
  const ts2 = kasTabState();
  kasFramesToMessages(upd(1, { sessionUpdate: "agent_message_chunk", content: text("Let me") }), ts2);
  const seg = kasFramesToMessages(upd(2, { sessionUpdate: "tool_call", toolCallId: "t", title: "x", status: "pending" }), ts2);
  assert.equal(seg[0].type, "segment");
  assert.equal(seg[1].type, "row");
  assert.equal(kasToolOutput([{ type: "diff", path: "/w/a.txt", newText: "new" }]), "edit /w/a.txt\nnew");
});

test("agent_message_chunk with an image → an assistant row carrying the data URL", () => {
  const ts = kasTabState();
  const out = kasFramesToMessages(upd(1, { sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "AAAA" } }), ts);
  assert.equal(out.length, 1);
  assert.equal(out[0].row.role, "assistant");
  assert.equal(out[0].row.content, "![image](data:image/png;base64,AAAA)");
});

test("ask permission → approval card row with request_id and options; askResolved → permissionResolved", () => {
  const ts = kasTabState();
  const options = [{ optionId: "accept", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
  const out = kasFramesToMessages({ kind: "ask", ask: "permission", seq: 1, requestId: 7, title: "Write File", toolKind: "edit", rawInput: { path: "/w/x" }, options }, ts);
  assert.equal(out.length, 1);
  const row = out[0].row;
  assert.equal(row.role, "permission");
  assert.equal(row.meta.request_id, "7");
  assert.equal(row.meta.tool_title, "Write File");
  assert.match(row.meta.tool_input, /"path": "\/w\/x"/);
  assert.deepEqual(row.meta.options, options);
  assert.deepEqual(ts.asks[7], { kind: "permission", options });
  assert.equal(kasPermissionChoice(options, "approved"), "accept");
  assert.equal(kasPermissionChoice(options, "rejected"), "reject");
  assert.equal(kasPermissionChoice([{ optionId: "a", kind: "allow_once" }], "rejected"), null);
  assert.deepEqual(kasFramesToMessages({ kind: "askResolved", seq: 2, requestId: 7, optionId: "accept" }, ts), [{ type: "permissionResolved", requestId: "7" }]);
  assert.equal(ts.asks[7], undefined);
});

test("ask userInput → question card with kas:<id>; askResolved → questionResolved", () => {
  const ts = kasTabState();
  const out = kasFramesToMessages({ kind: "ask", ask: "userInput", seq: 1, requestId: 9, question: "**Pick one**", options: [{ title: "Alpha", description: "first" }, { title: "Beta", recommended: true }] }, ts);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "question");
  assert.equal(out[0].card.ask_id, "kas:9");
  assert.equal(out[0].card.questions[0].question, "Pick one");
  assert.deepEqual(out[0].card.questions[0].options, [{ label: "Alpha", value: "Alpha", description: "first" }, { label: "Beta", value: "Beta", description: "recommended" }]);
  assert.deepEqual(kasFramesToMessages({ kind: "askResolved", seq: 2, requestId: 9, answer: "Beta" }, ts), [{ type: "questionResolved", qid: "kas:9" }]);
});

test("turnEnd: end_turn → done; any other stop reason adds a status naming it; running clears", () => {
  const ts = kasTabState();
  ts.running = true;
  assert.deepEqual(kasFramesToMessages({ kind: "turnEnd", seq: 1, stopReason: "end_turn" }, ts), [{ type: "done" }]);
  assert.equal(ts.running, false);
  assert.deepEqual(kasFramesToMessages({ kind: "turnEnd", seq: 2, stopReason: "cancelled" }, ts), [{ type: "done" }, { type: "status", text: "Turn ended: cancelled" }]);
  assert.deepEqual(kasFramesToMessages({ kind: "turnEnd", seq: 3, stopReason: "max_tokens", source: "invoke" }, ts), [{ type: "done" }, { type: "status", text: "Turn ended: max_tokens" }]);
});

test("error frames: the message as an error row; a prompt error releases the pane; login adds the command", () => {
  const ts = kasTabState();
  ts.running = true;
  assert.deepEqual(kasFramesToMessages({ kind: "error", op: "prompt", message: "child exited (code 3)", code: -32603 }, ts), [{ type: "error", text: "child exited (code 3)" }, { type: "done" }]);
  assert.equal(ts.running, false);
  const login = kasFramesToMessages({ kind: "error", op: "new", message: "Authentication required. Not logged in.", login: true }, ts);
  assert.match(login[0].text, /kiro-cli login/);
});

test("childState exited → done, an error row with the code, and a Reload card", () => {
  const ts = kasTabState();
  ts.running = true;
  ts.asks[3] = { kind: "permission", options: [] };
  const out = kasFramesToMessages({ kind: "childState", state: "exited", code: 3, reason: "exited", wsHash: "h", sessions: ["sess_1"] }, ts);
  assert.deepEqual(out.map((m) => m.type), ["done", "error", "interrupted"]);
  assert.equal(out[1].text, "kiro-cli exited (code 3).");
  assert.equal(out[2].resume, true);
  assert.equal(out[2].label, "Reload session");
  assert.equal(ts.state, "exited");
  assert.equal(ts.running, false);
  assert.deepEqual(ts.asks, {});
  const login = kasFramesToMessages({ kind: "childState", state: "exited", code: 1, reason: "login" }, kasTabState());
  assert.match(login[1].text, /kiro-cli login/);
  assert.deepEqual(kasFramesToMessages({ kind: "childState", state: "spawned" }, kasTabState()), []);
});

test("config_option_update → _config with autopilot/model/effort/mode; session_info_update title → _title", () => {
  const ts = kasTabState();
  const out = kasFramesToMessages(upd(1, { sessionUpdate: "config_option_update", configOptions: [{ id: "autopilot", currentValue: "on" }, { id: "model", currentValue: "auto" }, { id: "effortLevel", currentValue: "high" }, { id: "mode", currentValue: "spec" }] }), ts);
  assert.deepEqual(out, [{ type: "_config", autopilot: true, model: "", effort: "high", mode: "spec" }]);
  assert.equal(ts.autopilot, true);
  assert.equal(ts.mode, "spec");
  assert.deepEqual(kasFramesToMessages(upd(2, { sessionUpdate: "session_info_update", title: "Execute Task: 1" }), ts), [{ type: "_title", title: "Execute Task: 1" }]);
  assert.deepEqual(kasFramesToMessages(upd(3, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "turn_start" } } }), ts), []);
  assert.equal(ts.running, true);
  assert.deepEqual(kasFramesToMessages(upd(4, { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "context_usage" } } }), ts), []);
});

test("modePicks: one Workflows group; a mode KAS advertises runs on Kiro's engine, the rest on the mod's prompts", () => {
  const status = { available: true, modes: [{ id: "vibe", name: "Default" }, { id: "plan", name: "Plan", description: "p" }, { id: "spec", name: "Spec", description: "s" }, { id: "my-agent", name: "my-agent" }, { id: "bug-fix", name: "Bug Fix" }] };
  const picks = modePicks(status);
  // Always the same four rows, in the same order, whatever the engine behind each one.
  assert.deepEqual(picks.map((p) => p.id), ["kas:spec", "workflow:quick-spec", "kas:bug-fix", "kas:plan"]);
  assert.deepEqual(picks.map((p) => p.label), ["Spec", "Quick Spec", "Bug Fix", "Plan"]);
  assert.ok(picks.every((p) => p.section === MODES_SECTION), "one section: picking a mode is not picking an engine");
  assert.ok(picks.every((p) => !p.hint), "no hint row to choose an engine from");
  // The mod's own wording, so the list reads the same either way.
  assert.match(picks[0].description, /Structured feature development/);
  assert.deepEqual(KAS_MODES, ["spec", "quick-spec", "bug-fix", "plan"]);
});

test("modePicks: kiro-cli unusable → the same four rows on the mod's prompts, each naming the reason", () => {
  const picks = modePicks({ available: false, reason: "kiro-cli not found on PATH or in ~/.local/bin" });
  assert.deepEqual(picks.map((p) => p.id), ["workflow:spec", "workflow:quick-spec", "workflow:bug-fix", "workflow:plan"]);
  assert.ok(picks.every((p) => p.section === MODES_SECTION && !p.kas));
  assert.match(picks[0].description, /not found/);
  // Before the first status read: the mod's own workflows, with nothing to explain yet.
  const early = modePicks(null);
  assert.deepEqual(early.map((p) => p.id), ["workflow:spec", "workflow:quick-spec", "workflow:bug-fix", "workflow:plan"]);
  assert.ok(early.every((p) => !/kiro-cli/.test(p.description)));
  assert.deepEqual(modePicks({ available: true, modes: [] }).map((p) => p.id), ["workflow:spec", "workflow:quick-spec", "workflow:bug-fix", "workflow:plan"]);
});

test("kasPromptBlocks: contexts first as labelled text blocks, images inline, other files by path, then the text", () => {
  const blocks = kasPromptBlocks("do it", [{ label: "file src/a.js", kind: "file", content: "const a = 1;" }], [
    { name: "shot.png", image: true, mime: "image/png", data: "QUJD" },
    { name: "notes.txt", image: false, path: "/uploads/notes.txt" },
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "[file src/a.js]\nconst a = 1;" },
    { type: "image", mimeType: "image/png", data: "QUJD" },
    { type: "text", text: "[attached_file] /uploads/notes.txt" },
    { type: "text", text: "do it" },
  ]);
  assert.deepEqual(kasPromptBlocks("  ", [], [{ name: "x", image: false, path: "/p" }]).pop(), { type: "text", text: "See the attached file(s)." });
  assert.deepEqual(kasPromptBlocks("", [{ label: "c", content: "v" }], []).pop(), { type: "text", text: "See the context provided." });
  assert.deepEqual(kasPromptBlocks("", [], []), []);
});

test("isKasTab and the tab-state record round trip (nothing transient persisted)", () => {
  assert.equal(isKasTab({ kind: "kas" }), true);
  assert.equal(isKasTab({ settings: { engine: "kas" } }), true);
  assert.equal(isKasTab({ kind: "spec", settings: { engine: "" } }), false);
  assert.equal(isKasTab(null), false);
  const ts = kasTabState({ sessionId: "sess_1", mode: "plan", wsHash: "h", lastSeq: 12, state: "live", autopilot: true, noticeShown: true, running: true, asks: { 1: {} } });
  assert.equal(ts.running, false);
  assert.deepEqual(ts.asks, {});
  assert.deepEqual(kasTabRecord(ts), { sessionId: "sess_1", mode: "plan", wsHash: "h", lastSeq: 12, state: "live", autopilot: true, noticeShown: true });
  assert.equal(kasTabRecord(null), null);
  assert.equal(kasTabState(undefined).lastSeq, 0);
});

test("the webview script knows the Kiro-mode pick, permissionResolved and the Reload label", () => {
  const html = chatHtml("");
  assert.match(html, /engine==='kas'/);
  assert.ok(!/kind==='kashint'/.test(html), "no engine-choice hint row in the picker");
  assert.match(html, /case 'permissionResolved'/);
  assert.match(html, /box\.dataset\.requestId=/);
  assert.match(html, /m\.label\|\|'Resume run'/);
  assert.match(html, /runs in kiro-cli on the gateway host/);
  // The hint names the engine from the session KEY, not from the pick: a gateway
  // session read "Kiro-mode session kirocrew-ide-spec-…" before 0.38.0.
  assert.match(html, /const kas = st && st\.key \? \/\^kas:\/\.test\(st\.key\) : picked;/);
});

test("spec actions on Kiro's engine: specDocuments are the existing documents' absolute paths; a task link remembers engine kas", () => {
  const { ChatView, normalizeLink } = ext;
  const spec = { dir: { path: "/w/.kiro/specs/feat" }, present: { "requirements.md": true, "bugfix.md": false, "design.md": true, "tasks.md": false } };
  assert.deepEqual(ChatView.kasSpecDocuments(spec), { specDocuments: ["/w/.kiro/specs/feat/requirements.md", "/w/.kiro/specs/feat/design.md"], tasksFilePath: "/w/.kiro/specs/feat/tasks.md" });
  const link = normalizeLink({ feature: "feat", taskIds: ["1. A"], engine: "kas", startedAt: 5 });
  assert.equal(link.engine, "kas");
  assert.equal(normalizeLink({ feature: "feat", engine: "gateway" }).engine, undefined);
});

test("task state merge table (box × executionStatus): the box wins when it says anything; a [ ] task takes KAS's live status", () => {
  const { mergeKasTaskState } = ext;
  const table = [
    ["completed", "running", "completed"], ["queued", "failed", "queued"], ["in_progress", "succeed", "in_progress"],
    ["not_started", "queued", "queued"], ["not_started", "running", "in_progress"], ["not_started", "in_progress", "in_progress"],
    ["not_started", "failed", "failed"], ["not_started", "error", "failed"], ["not_started", "cancelled", "aborted"], ["not_started", "aborted", "aborted"],
    ["not_started", "succeed", "not_started"], ["not_started", undefined, "not_started"], ["not_started", "weird", "not_started"], [undefined, "RUNNING", "in_progress"],
  ];
  for (const [box, exec, want] of table) assert.equal(mergeKasTaskState(box, exec), want, box + " × " + exec);
});

test("taskState consults kasExec for a [ ] task before the run links", () => {
  const { taskState } = ext;
  const task = { id: "1. A", status: "not_started" };
  assert.equal(taskState(task, [], { feature: "f", dir: "/w/.kiro/specs/f", kasExec: () => "running" }), "in_progress");
  assert.equal(taskState(task, [], { feature: "f", kasExec: () => "succeed" }), "not_started");
  assert.equal(taskState({ id: "1. A", status: "completed" }, [], { feature: "f", kasExec: () => "running" }), "completed");
  const links = [{ id: "l", feature: "f", taskIds: ["1. A"], sessionId: "s", outcome: "error", startedAt: 1 }];
  assert.equal(taskState(task, links, { feature: "f", kasExec: () => undefined }), "failed", "no KAS status → the link decides as before");
});

test("KasTaskStore: taskStatusChanged events apply at once, the route's file replaces them, View session resolves to the task's session", async () => {
  const { KasTaskStore, resolveKasViewSession, kasFeatureOfPath } = ext;
  assert.equal(kasFeatureOfPath("/w/.kiro/specs/feat/tasks.md"), "feat");
  assert.equal(kasFeatureOfPath("/w/.kiro/specs/feat/design.md"), null);
  const fetched = [];
  let doc = { exists: false, tasks: {}, specSessionId: null };
  const store = new KasTaskStore("/w", { fetch: async (feature) => { fetched.push(feature); return doc; } });
  const events = [];
  store.onDidChange((e) => events.push(e));
  const frame = { kind: "specEvent", method: "_kiro/spec/taskStatusChanged", params: { sessionId: "sess_run", tasksFilePath: "/w/.kiro/specs/feat/tasks.md", changes: [{ taskId: "1. A", executionStatus: "running", lastSessionId: "sess_run", lastExecutionId: "x1" }] } };
  assert.equal(store.applyEvent(frame), true);
  assert.equal(store.statusOf("feat", "/w/.kiro/specs/feat", "1. A"), "running");
  assert.equal(store.statusOf("feat", "/w/.kiro/specs/feat", "2. B"), undefined);
  assert.equal(store.sessionOf("feat", "/w/.kiro/specs/feat", "1. A"), "sess_run");
  assert.equal(store.sessionOf("feat", "/w/.kiro/specs/feat", "2. B"), "sess_run", "the feature's spec session when the task has none");
  assert.equal(events.length, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(fetched, ["feat"], "an event triggers one read of kas/tasks");
  assert.equal(store.applyEvent({ kind: "specEvent", method: "_kiro/spec/phaseCheckpoint", params: {} }), false);
  // the file (the authority) says succeed and names another session for task 2
  doc = { exists: true, tasks: { "1. A": { executionStatus: "succeed", lastSessionId: "sess_run" }, "2. B": { executionStatus: "running", lastSessionId: "sess_two" } }, specSessionId: "sess_spec" };
  await store.fetch("feat");
  assert.equal(store.statusOf("feat", null, "1. A"), "succeed");
  assert.equal(events.length, 2);
  await store.fetch("feat");
  assert.equal(events.length, 2, "an unchanged file fires nothing");
  assert.deepEqual(resolveKasViewSession({ feature: "feat", dir: "/w/.kiro/specs/feat", taskId: "2. B" }, store, []), { sessionId: "sess_two", engine: "kas" });
  assert.deepEqual(resolveKasViewSession({ feature: "feat", taskId: "9. none" }, store, []), { sessionId: "sess_spec", engine: "kas" });
  // no store entry: a kas task link still answers; a gateway link does not
  const links = [{ id: "a", feature: "other", taskIds: ["1. X"], sessionId: "sess_gw", startedAt: 1 }, { id: "b", feature: "other", taskIds: ["1. X"], sessionId: "sess_kas", startedAt: 2, engine: "kas" }];
  assert.deepEqual(resolveKasViewSession({ feature: "other", taskId: "1. X" }, store, links), { sessionId: "sess_kas", engine: "kas" });
  assert.equal(resolveKasViewSession({ feature: "other", taskId: "1. X" }, store, [links[0]]), null);
  assert.equal(resolveKasViewSession(null, store, links), null);
  store.dispose();
});

test("History: Kiro-mode rows of this workspace, newest first as given, with mode/spec/state/age and the open check", () => {
  const { kasHistoryItems } = ext;
  const rows = [
    { sessionId: "sess_a", folder: "/home/u/w", mode: "plan", title: "Plan it", state: "running", lastActivity: Date.now() / 1000 - 30 },
    { sessionId: "sess_b", folder: "/local/home/u/w", mode: "spec", feature: "feat", title: "", state: "idle", pendingAsks: 1, lastActivity: Date.now() / 1000 - 7200 },
    { sessionId: "sess_c", folder: "/elsewhere", mode: "spec", title: "other ws", state: "detached" },
    { sessionId: "sess_d", folder: "/local/home/u/w/", mode: "bug-fix", title: "kas only", state: "detached", source: "kas" },
    { nope: true },
  ];
  const items = kasHistoryItems(rows, "/home/u/w", (sid) => sid === "sess_b");
  assert.deepEqual(items.map((i) => i.kas), ["sess_a", "sess_b", "sess_d"]);
  assert.equal(items[0].label, "Plan it");
  assert.match(items[0].description, /kiro-cli plan.*running.*(just now|1 min ago)/);
  assert.equal(items[1].label, "$(check) sess_b");
  assert.match(items[1].description, /spec feat.*waiting.*2 h ago/);
  assert.equal(items[1].mode, "spec");
  assert.match(items[2].detail, /kiro-cli's own store/);
  assert.match(items[2].description, /detached/);
  assert.deepEqual(kasHistoryItems(null, "/w", () => false), []);
});
