// node --test: editor, terminal and SCM integration (requirements 10.2, 10.6,
// 10.7) — the prompt override merge, the fenced-block builder, the `#selection`
// entry and `runEditorAction` over a stub editor, the diff selection and the
// commit-message helpers, `runBackgroundTurn` over a fake sessions/feed pair,
// `explorerSelection`, the quick-fix provider and `addCodeBlockToChat`. Same
// stub `vscode` module as context_providers.test.mjs, with a configurable
// `kirocrew` configuration and a recording `showInformationMessage`.
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
const config = {}; // what getConfiguration("kirocrew").get(key) answers
const messages = []; // showInformationMessage calls
const stub = {
  EventEmitter,
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  FileType: { Directory: 2 },
  Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }), parse: (s) => ({ toString: () => s }) },
  workspace: { getConfiguration: () => ({ get: (key) => config[key] }), workspaceFolders: [], asRelativePath: (uri) => String(uri.path || uri).replace(/^\/ws\//, "") },
  window: { createOutputChannel: () => ({ appendLine() {} }), setStatusBarMessage: () => {}, showInformationMessage: (m) => { messages.push(m); }, activeTextEditor: undefined, activeTerminal: undefined },
  languages: {},
  commands: {},
  extensions: { getExtension: () => undefined },
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

const ext = require(path.join(here, "..", "extension", "extension.js"));
const {
  EDITOR_ACTION_IDS, EDITOR_ACTION_TITLES, DEFAULT_ACTION_PROMPTS, SELECTION_GLYPH, actionPrompt,
  fenceFor, fencedBlock, buildSelectionContext, selectionInput, runEditorAction, addCodeBlockToChat,
  COMMIT_MESSAGE_PROMPT, PROVIDER_CAP, pickDiff, commitMessagePrompt, cleanCommitMessage, runBackgroundTurn,
  explorerSelection, EXPLORER_MAX_ITEMS, AgentFixCodeActionProvider, DIAGNOSTIC_FIX_TITLE,
} = ext.__test;

const P = DEFAULT_ACTION_PROMPTS;
const pos = (line, character) => ({ line, character });
/** A stub editor over `text` with a selection (zero-based positions, like vscode). */
function editorOf(text, start, end, languageId = "javascript", file = "/ws/src/a.js") {
  const lines = text.split("\n");
  const offset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const selection = { start, end, isEmpty: start.line === end.line && start.character === end.character };
  return { selection, document: { uri: { path: file, scheme: "file" }, languageId, getText: (r) => (r ? text.slice(offset(r.start), offset(r.end)) : text) } };
}
function fakeChat() {
  const calls = { staged: [], sent: [], inserted: [] };
  return {
    calls,
    stageContexts: async (entries) => { calls.staged.push(entries); return "staged"; },
    sendWithContexts: async (text, entries, opts) => { calls.sent.push({ text, entries, opts }); return "sent"; },
    insertComposerText: async (text) => { calls.inserted.push(text); },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------- prompt override merge (10.2)

test("editor actions: six ids in menu order with the menu titles, each with a default", () => {
  assert.deepEqual(EDITOR_ACTION_IDS, ["ask", "fixGrammar", "writeComments", "writeDocstring", "fixCode", "optimize"]);
  assert.deepEqual(EDITOR_ACTION_IDS.map((id) => EDITOR_ACTION_TITLES[id]),
    ["Ask about this", "Fix grammar and spelling", "Write comments", "Write a docstring", "Fix this code", "Optimize this code"]);
  assert.deepEqual(Object.keys(P).sort(), [...EDITOR_ACTION_IDS].sort());
  for (const id of EDITOR_ACTION_IDS) assert.ok(P[id].trim(), id + " has a default prompt");
});

test("actionPrompt: default per id; a non-empty override wins for its id only; blank or non-string falls back", () => {
  for (const id of EDITOR_ACTION_IDS) { assert.equal(actionPrompt(id), P[id]); assert.equal(actionPrompt(id, {}), P[id]); assert.equal(actionPrompt(id, null), P[id]); }
  assert.equal(actionPrompt("fixCode", { fixCode: "Repair it." }), "Repair it.");
  assert.equal(actionPrompt("optimize", { fixCode: "Repair it." }), P.optimize);
  for (const bad of ["", "   \n\t", 42, null]) assert.equal(actionPrompt("fixGrammar", { fixGrammar: bad }), P.fixGrammar, JSON.stringify(bad));
});

test("actionPrompt: an unknown id answers the empty string", () => {
  assert.equal(actionPrompt("explode"), "");
  assert.equal(actionPrompt("", {}), "");
  assert.equal(actionPrompt(undefined), "");
  assert.equal(actionPrompt("toString"), "", "inherited keys are not defaults");
  assert.equal(actionPrompt("explode", { explode: "Boom" }), "Boom", "an override may name a new id");
});

// ------------------------------------------------------- fenced block (10.7)

test("fenceFor: three backticks unless the text holds a run of three or more", () => {
  assert.equal(fenceFor(""), "```");
  assert.equal(fenceFor(undefined), "```");
  assert.equal(fenceFor("a `b` c ``d``"), "```");
  assert.equal(fenceFor("```"), "````");
  assert.equal(fenceFor("x ```` y ``` z"), "`````");
});

test("fencedBlock: language fence, trimmed language id, no path line without a path", () => {
  assert.equal(fencedBlock({ languageId: "python", text: "print(1)" }), "```python\nprint(1)\n```");
  assert.equal(fencedBlock({ text: "x" }), "```\nx\n```");
  assert.equal(fencedBlock({ languageId: "  ts ", text: "x" }), "```ts\nx\n```");
});

test("fencedBlock: path line forms — path, path:line, path:start-end", () => {
  const f = (o) => fencedBlock({ languageId: "js", text: "x", path: "src/a.js", ...o });
  assert.equal(f({}), "src/a.js\n```js\nx\n```");
  assert.equal(f({ startLine: 3 }), "src/a.js:3\n```js\nx\n```");
  assert.equal(f({ startLine: 3, endLine: 3 }), "src/a.js:3\n```js\nx\n```");
  assert.equal(f({ startLine: 1, endLine: 3 }), "src/a.js:1-3\n```js\nx\n```");
  assert.equal(f({ startLine: 5, endLine: 2 }), "src/a.js:5\n```js\nx\n```", "end before start → one line");
  assert.equal(f({ startLine: 0 }), "src/a.js\n```js\nx\n```", "line 0 → no range");
});

test("fencedBlock: an inner ``` widens the fence; CRLF → LF; trailing newlines stripped; empty input", () => {
  const md = "```md\nhello\n```";
  assert.equal(fencedBlock({ languageId: "markdown", text: md }), "````markdown\n" + md + "\n````");
  assert.equal(fencedBlock({ text: "````" }), "`````\n````\n`````");
  assert.equal(fencedBlock({ languageId: "c", text: "a\r\nb\r\n" }), "```c\na\nb\n```");
  assert.equal(fencedBlock({ languageId: "c", text: "a\rb" }), "```c\na\nb\n```", "lone CR too");
  assert.equal(fencedBlock({ languageId: "c", text: "a\n\n\n" }), "```c\na\n```");
  assert.equal(fencedBlock({ languageId: "c", text: "\n\na" }), "```c\n\n\na\n```", "leading newlines kept");
  assert.equal(fencedBlock({ text: null }), "```\n\n```");
  assert.equal(fencedBlock(), "```\n\n```");
});

// ------------------------------------------------------- #selection entry and the actions

test("buildSelectionContext: kind, label file:start-end, glyph, paths, selection, fenced content with a header", () => {
  const e = buildSelectionContext({ path: "src/a.js", uriPath: "/ws/src/a.js", languageId: "javascript", startLine: 2, endLine: 4, text: "b\nc\nd\n" });
  assert.equal(e.kind, "selection");
  assert.equal(e.label, "a.js:2-4");
  assert.equal(e.glyph, SELECTION_GLYPH);
  assert.deepEqual(e.paths, ["/ws/src/a.js"]);
  assert.equal(e.truncated, false);
  assert.equal(e.note, undefined);
  assert.deepEqual(e.selection, { path: "src/a.js", languageId: "javascript", range: { startLine: 2, endLine: 4 } });
  assert.equal(e.content, "Selection from src/a.js, lines 2-4 (javascript):\n```javascript\nb\nc\nd\n```");
});

test("buildSelectionContext: one line, backslash paths, no path, inner ```, text past PROVIDER_CAP", () => {
  const one = buildSelectionContext({ path: "C:\\proj\\x.py", languageId: "python", startLine: 7, endLine: 7, text: "pass" });
  assert.equal(one.label, "x.py:7");
  assert.deepEqual(one.paths, ["C:\\proj\\x.py"], "paths from path when uriPath is absent");
  assert.match(one.content, /^Selection from C:\\proj\\x\.py, line 7 \(python\):\n/);
  const none = buildSelectionContext({ text: "x" });
  assert.equal(none.label, "selection:1");
  assert.equal(none.paths, undefined);
  assert.match(none.content, /^Selection from the editor, line 1:\n```\nx\n```$/);
  const fenced = buildSelectionContext({ path: "a.md", languageId: "markdown", startLine: 1, endLine: 3, text: "```js\nx\n```" });
  assert.match(fenced.content, /\n````markdown\n```js\nx\n```\n````$/);
  const big = buildSelectionContext({ path: "a.txt", startLine: 1, endLine: 1, text: "x".repeat(PROVIDER_CAP + 10) });
  assert.equal(big.truncated, true);
  assert.match(big.note, /^Truncated: \d+ of \d+ bytes shown\.$/);
  assert.match(big.content, /… \[truncated: \d+ of \d+ bytes shown\]\n```$/);
});

test("selectionInput: one-based inclusive lines, an end at column 0 excludes that line, null when empty", () => {
  const text = "l1\nl2\nl3\nl4";
  assert.deepEqual(selectionInput(editorOf(text, pos(1, 0), pos(2, 2))),
    { path: "src/a.js", uriPath: "/ws/src/a.js", languageId: "javascript", startLine: 2, endLine: 3, text: "l2\nl3" });
  const col0 = selectionInput(editorOf(text, pos(0, 0), pos(2, 0)));
  assert.equal(col0.endLine, 2);
  assert.equal(col0.text, "l1\nl2\n");
  assert.equal(selectionInput(editorOf(text, pos(1, 1), pos(1, 1))), null);
  assert.equal(selectionInput(undefined), null);
  assert.equal(selectionInput({}), null);
});

test("runEditorAction: 'ask' stages the selection chip and sends nothing", async () => {
  stub.window.activeTextEditor = editorOf("const a = 1;\nconst b = 2;", pos(0, 0), pos(0, 12));
  const chat = fakeChat();
  assert.equal(await runEditorAction(chat, "ask"), "staged");
  assert.equal(chat.calls.sent.length, 0);
  const [entry] = chat.calls.staged[0];
  assert.equal(entry.kind, "selection");
  assert.equal(entry.label, "a.js:1");
  assert.match(entry.content, /```javascript\nconst a = 1;\n```$/);
});

test("runEditorAction: 'fixCode' sends the instruction with the entry, the menu title as display text", async () => {
  stub.window.activeTextEditor = editorOf("a\nb\nc", pos(0, 0), pos(2, 1));
  delete config["editorActions.prompts"];
  const chat = fakeChat();
  assert.equal(await runEditorAction(chat, "fixCode"), "sent");
  assert.equal(chat.calls.staged.length, 0);
  const [call] = chat.calls.sent;
  assert.equal(call.text, P.fixCode);
  assert.deepEqual(call.opts, { displayText: "Fix this code" });
  assert.equal(call.entries.length, 1);
  assert.equal(call.entries[0].label, "a.js:1-3");
  assert.deepEqual(call.entries[0].paths, ["/ws/src/a.js"]);
});

test("runEditorAction: kirocrew.editorActions.prompts overrides the instruction; a blank one falls back", async () => {
  stub.window.activeTextEditor = editorOf("x", pos(0, 0), pos(0, 1));
  config["editorActions.prompts"] = { optimize: "Make it faster.", writeComments: "   " };
  try {
    const chat = fakeChat();
    await runEditorAction(chat, "optimize");
    await runEditorAction(chat, "writeComments");
    assert.equal(chat.calls.sent[0].text, "Make it faster.");
    assert.deepEqual(chat.calls.sent[0].opts, { displayText: "Optimize this code" });
    assert.equal(chat.calls.sent[1].text, P.writeComments);
  } finally { delete config["editorActions.prompts"]; }
});

test("runEditorAction: no selection → information message, nothing staged or sent; unknown id throws", async () => {
  messages.length = 0;
  const chat = fakeChat();
  stub.window.activeTextEditor = editorOf("x", pos(0, 0), pos(0, 0));
  assert.equal(await runEditorAction(chat, "fixCode"), null);
  stub.window.activeTextEditor = undefined;
  assert.equal(await runEditorAction(chat, "ask"), null);
  assert.deepEqual(messages, ["Select some text in the editor first.", "Select some text in the editor first."]);
  assert.equal(chat.calls.sent.length + chat.calls.staged.length, 0);
  stub.window.activeTextEditor = editorOf("x", pos(0, 0), pos(0, 1));
  await assert.rejects(runEditorAction(chat, "explode"), /unknown editor action explode/);
  assert.equal(chat.calls.sent.length, 0);
});

test("addCodeBlockToChat: inserts the fenced block with its path:range line; no selection → message, nothing inserted", async () => {
  stub.window.activeTextEditor = editorOf("def f():\n    return 1\n", pos(0, 0), pos(2, 0), "python", "/ws/pkg/m.py");
  const chat = fakeChat();
  const block = await addCodeBlockToChat(chat);
  assert.equal(block, "pkg/m.py:1-2\n```python\ndef f():\n    return 1\n```");
  assert.deepEqual(chat.calls.inserted, [block]);
  messages.length = 0;
  stub.window.activeTextEditor = undefined;
  assert.equal(await addCodeBlockToChat(chat), null);
  assert.equal(chat.calls.inserted.length, 1);
  assert.deepEqual(messages, ["Select some text in the editor first."]);
});

// ------------------------------------------------------- diff selection (10.6)

test("pickDiff: staged wins, working tree is the fallback, whitespace-only counts empty, both empty → null", () => {
  assert.deepEqual(pickDiff({ staged: "diff --git a\n+x\n", working: "diff --git b\n+y\n" }), { diff: "diff --git a\n+x", staged: true });
  assert.deepEqual(pickDiff({ staged: "", working: "diff --git b\n+y\n\n" }), { diff: "diff --git b\n+y", staged: false });
  assert.deepEqual(pickDiff({ staged: undefined, working: "w" }), { diff: "w", staged: false });
  assert.deepEqual(pickDiff({ staged: "  \n\t\n", working: "w" }), { diff: "w", staged: false });
  assert.deepEqual(pickDiff({ staged: "\n  +a\n  \n" }), { diff: "\n  +a", staged: true }, "only trailing whitespace is removed");
  assert.equal(pickDiff({ staged: " \n", working: "\n\n " }), null);
  assert.equal(pickDiff({ staged: "", working: "" }), null);
  assert.equal(pickDiff({}), null);
  assert.equal(pickDiff(), null);
});

test("commitMessagePrompt: the instruction, then the diff framed as `$ git diff` (--cached when staged); oversized diff capped", () => {
  const staged = commitMessagePrompt({ diff: "diff --git a\n+x", staged: true });
  assert.ok(staged.startsWith(COMMIT_MESSAGE_PROMPT + "\n\n$ git diff --cached\ndiff --git a\n+x"));
  const working = commitMessagePrompt({ diff: "diff --git b\n+y", staged: false });
  assert.ok(working.endsWith("\n\n$ git diff\ndiff --git b\n+y"));
  assert.ok(!working.includes("--cached") && !working.includes("[truncated:"));
  assert.match(COMMIT_MESSAGE_PROMPT, /Conventional Commits/);
  const big = commitMessagePrompt({ diff: "+".repeat(PROVIDER_CAP + 100), staged: true });
  const m = big.match(/\n… \[truncated: (\d+) of (\d+) bytes shown\]$/);
  assert.ok(m, "the cap marker ends the prompt");
  assert.equal(Number(m[2]), PROVIDER_CAP + 100);
  assert.ok(Number(m[1]) <= PROVIDER_CAP);
});

test("cleanCommitMessage: fence, label, bold label + fence, quotes and CRLF are stripped; the wording is kept", () => {
  const msg = "feat(scm): Add commit message generation\n\nUses the staged diff.";
  assert.equal(cleanCommitMessage(msg), msg);
  assert.equal(cleanCommitMessage("```\n" + msg + "\n```"), msg, "plain fence");
  assert.equal(cleanCommitMessage("```text\n" + msg + "\n```\n"), msg, "fence with info string");
  assert.equal(cleanCommitMessage("Commit message:\n" + msg), msg, "label on its own line");
  assert.equal(cleanCommitMessage("commit message: " + msg), msg, "inline label, any case");
  assert.equal(cleanCommitMessage("**Commit message:**\n```\n" + msg + "\n```"), msg, "bold label then fence");
  assert.equal(cleanCommitMessage("```\nCommit message:\n" + msg + "\n```"), msg, "label inside the fence");
  for (const q of ['"', "'", "`"]) assert.equal(cleanCommitMessage(q + msg + q), msg, q + " quotes");
  assert.equal(cleanCommitMessage("fix: Add \"quoted\" words\r\n\r\nBody."), "fix: Add \"quoted\" words\n\nBody.", "CRLF → LF");
});

test("cleanCommitMessage: embedded quotes and a mismatched pair are kept; empty input is empty", () => {
  assert.equal(cleanCommitMessage('"Fix" the "thing"'), '"Fix" the "thing"', "an inner quote of the same kind keeps the outer pair");
  assert.equal(cleanCommitMessage('"mismatch\''), '"mismatch\'');
  assert.equal(cleanCommitMessage('"'), '"');
  assert.equal(cleanCommitMessage("  \n\n"), "");
  assert.equal(cleanCommitMessage(null), "");
  assert.equal(cleanCommitMessage("```\n```"), "", "an empty fence");
});

// ------------------------------------------------------- background turn (10.6)

/** A fake Sessions + feed pair recording calls; `fire(frame)` plays one feed frame. */
function fakeHost(key = "slot-1") {
  const calls = [], listeners = [];
  const sessions = {
    create: async (opts) => { calls.push(["create", opts]); return key; },
    send: async (slot, prompt, agent) => { calls.push(["send", slot, prompt, agent, listeners.length]); },
    stop: async (slot) => { calls.push(["stop", slot]); },
    remove: async (slot) => { calls.push(["remove", slot]); },
    refresh: async () => { calls.push(["refresh"]); },
  };
  const feed = { on: (fn) => { listeners.push(fn); return { dispose: () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } }; } };
  const fire = (frame) => { for (const l of listeners.slice()) l(frame); };
  const run = (opts) => runBackgroundTurn({ sessions, feed, prompt: "p", title: "t", timeoutMs: 5000, ...opts });
  const tail = () => calls.slice(2).map((c) => c[0]);
  return { sessions, feed, fire, calls, listeners, key, run, tail };
}
const msg = (slot, role, content, extra) => ({ type: "chat_message", data: { slot, role, content, ...extra } });

test("runBackgroundTurn: background session, listener attached before the send, first assistant row of its slot resolves, slot removed", async () => {
  const h = fakeHost();
  const turn = h.run({ agent: "kirocrew", prompt: "Write it", title: "Generate commit message" });
  await tick();
  assert.deepEqual(h.calls[0], ["create", { agent: "kirocrew", kind: "background", title: "Generate commit message" }]);
  assert.deepEqual(h.calls[1], ["send", h.key, "Write it", "kirocrew", 1], "one feed listener at send time");
  h.fire(msg("other-slot", "assistant", "wrong slot"));
  h.fire(msg(h.key, "user", "Write it"));
  h.fire(msg(h.key, "assistant", "   "));
  h.fire({ type: "chat_message", data: null });
  h.fire(msg(h.key, "assistant", "feat: Do the thing"));
  h.fire(msg(h.key, "assistant", "a later row is ignored"));
  assert.equal(await turn, "feat: Do the thing");
  assert.deepEqual(h.tail(), ["stop", "remove", "refresh"], "turn still running → stopped, then removed on success");
  assert.equal(h.listeners.length, 0, "the listener is disposed");
});

test("runBackgroundTurn: an empty agent becomes undefined (the default); the timeout floor is one second", async () => {
  const h = fakeHost();
  const turn = h.run({ agent: "", timeoutMs: 1 });
  await tick();
  assert.deepEqual(h.calls[0], ["create", { agent: undefined, kind: "background", title: "t" }]);
  assert.deepEqual(h.calls[1].slice(0, 4), ["send", h.key, "p", undefined]);
  h.fire(msg(h.key, "assistant", "ok"));
  assert.equal(await turn, "ok");
});

test("runBackgroundTurn: an error row rejects; the slot is stopped and kept for inspection", async () => {
  const h = fakeHost();
  const turn = h.run({});
  await tick();
  h.fire(msg(h.key, "error", "  agent refused  "));
  await assert.rejects(turn, /^Error: agent refused$/);
  assert.deepEqual(h.tail(), ["stop", "refresh"], "no remove on failure");
  const h2 = fakeHost();
  const turn2 = h2.run({});
  await tick();
  h2.fire(msg(h2.key, "assistant", "❌ the turn failed badly", { cls: "msg-err" }));
  await assert.rejects(turn2, /the turn failed badly/);
  assert.deepEqual(h2.tail(), ["stop", "refresh"]);
});

test("runBackgroundTurn: chat_done before any text rejects; the finished slot is not stopped, only kept", async () => {
  const h = fakeHost();
  const turn = h.run({});
  await tick();
  h.fire({ type: "chat_done", data: { slot: "other" } });
  h.fire({ type: "chat_done", data: { slot: h.key } });
  await assert.rejects(turn, /ended without an answer/);
  assert.deepEqual(h.tail(), ["refresh"]);
});

test("runBackgroundTurn: no frame within timeoutMs rejects with the wait in seconds and stops the slot", async () => {
  const h = fakeHost();
  await assert.rejects(h.run({ timeoutMs: 1000 }), /no answer within 1 s/);
  assert.deepEqual(h.tail(), ["stop", "refresh"]);
  assert.equal(h.listeners.length, 0);
});

// ------------------------------------------------------- explorer selection and the quick fix

test("explorerSelection: the multi-selection when present, de-duplicated, else [uri]; nullish dropped", () => {
  const a = { path: "/a", toString: () => "file:///a" }, a2 = { path: "/a", toString: () => "file:///a" }, b = { path: "/b", toString: () => "file:///b" };
  assert.deepEqual(explorerSelection(a, [a, b, a2, null, undefined]), [a, b]);
  assert.deepEqual(explorerSelection(a, []), [a], "empty multi-selection → the clicked uri");
  assert.deepEqual(explorerSelection(a, undefined), [a]);
  assert.deepEqual(explorerSelection(b, [a]), [a], "the multi-selection wins over the clicked uri");
  assert.deepEqual(explorerSelection(undefined, undefined), []);
  assert.deepEqual(explorerSelection(undefined, [{ path: "/x" }, { path: "/x" }]), [{ path: "/x" }], "plain objects dedupe by path");
  assert.equal(EXPLORER_MAX_ITEMS, 20);
});

test("AgentFixCodeActionProvider: one quick fix per diagnostic in range, kirocrew-spec skipped, same range+message de-duplicated", () => {
  const range = (sl, sc, el, ec) => ({ start: pos(sl, sc), end: pos(el, ec) });
  const document = { uri: { path: "/ws/a.js" } };
  const diagnostics = [
    { message: "Unused variable x", severity: 1, source: "eslint", range: range(1, 0, 1, 5) },
    { message: "Unused  variable x", severity: 1, source: "tsc", range: range(1, 0, 1, 5) }, // same range and message modulo spaces
    { message: "Missing semicolon", severity: 0, source: "eslint", range: range(1, 4, 1, 5) },
    { message: "Task line malformed", severity: 1, source: "kirocrew-spec", range: range(1, 0, 1, 5) },
    { message: "Far away", severity: 0, source: "eslint", range: range(9, 0, 9, 3) },
    null,
  ];
  const provider = new AgentFixCodeActionProvider();
  const actions = provider.provideCodeActions(document, range(1, 0, 1, 5), { diagnostics });
  assert.deepEqual(actions.map((a) => a.title), [DIAGNOSTIC_FIX_TITLE + ": Unused variable x", DIAGNOSTIC_FIX_TITLE + ": Missing semicolon"]);
  assert.equal(actions[0].kind, "quickfix", "the stub has no CodeActionKind → the plain kind");
  assert.deepEqual(actions[0].diagnostics, [diagnostics[0]]);
  assert.equal(actions[0].command.command, "kirocrew.editor.fixDiagnostic");
  const [arg] = actions[0].command.arguments;
  assert.equal(arg.uri, document.uri);
  assert.deepEqual(arg.range, range(1, 0, 1, 5));
  assert.equal(arg.diagnostic.message, "Unused variable x");
  assert.equal(arg.diagnostic.source, "eslint");
  assert.equal(provider.provideCodeActions(document, undefined, { diagnostics }).length, 3, "no range → every non-spec diagnostic, still de-duplicated");
  assert.deepEqual(provider.provideCodeActions(document, range(0, 0, 0, 1), {}), []);
});
