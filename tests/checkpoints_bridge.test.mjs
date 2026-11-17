// node --test: the bridge half of "Revert changes". Before a gateway turn the tab
// asks the hook for a checkpoint and the user bubble carries its id; a 409
// (not a git repository) is said once and never blocks the turn; revertTo asks
// the hook what would change, confirms through a modal warning, restores, and
// posts a `reverted` row with Undo; an undo skips the confirmation; the setting
// `kirocrew.checkpoints: false` takes no checkpoints at all.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let cfgValues = {};
let warnAnswer = "Revert";
const warnings = [];
const stub = {
  Uri: { file: (p) => ({ scheme: "file", path: p, fsPath: p }), joinPath: (u, ...s) => ({ scheme: "file", path: [u.path, ...s].join("/"), fsPath: [u.path, ...s].join("/") }), parse: (s) => ({ path: s }) },
  workspace: { getConfiguration: () => ({ get: (k) => cfgValues[k] }), workspaceFolders: [{ uri: { path: "/w", fsPath: "/w" }, name: "w" }], fs: {}, onDidChangeConfiguration: () => ({ dispose() {} }), createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }) },
  window: { showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, showWarningMessage: async (m, o) => { warnings.push({ m, o }); return warnAnswer; }, setStatusBarMessage() {}, visibleTextEditors: [], createOutputChannel: () => ({ appendLine() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  ThemeIcon: class {}, ThemeColor: class {}, TreeItem: class {}, TreeItemCollapsibleState: { None: 0 },
  Range: class {}, Position: class {}, MarkdownString: class {}, Hover: class {}, Diagnostic: class {}, DiagnosticSeverity: {}, CodeAction: class {}, CodeActionKind: { QuickFix: {} },
  languages: { createDiagnosticCollection: () => ({ set() {}, delete() {}, dispose() {} }) },
  env: { clipboard: { readText: async () => "" } },
  ViewColumn: {},
};
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? stub : load.call(this, request, ...rest); };

// The mod's own api routes answer through fetch; a tiny fake hook keyed by route.
const hook = { calls: [], answers: {} };
globalThis.fetch = async (url, init) => {
  const route = String(url).split("/api/").pop();
  const body = init && init.body ? JSON.parse(init.body) : null;
  hook.calls.push({ route, body });
  const key = route.split("?")[0];
  const a = hook.answers[key];
  const out = typeof a === "function" ? a(body, route) : a;
  if (out && out.__status) return { ok: false, status: out.__status, text: async () => JSON.stringify(out.body) };
  return { ok: true, status: 200, text: async () => JSON.stringify(out || {}) };
};

const ext = require(path.join(here, "..", "extension", "extension.js"));
const { ChatView } = ext.__test;

function make() {
  const calls = { posted: [], sent: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [],
    create: async () => "k1", inject: async () => {}, send: async (key, text, agent) => { calls.sent.push({ key, text, agent }); },
    setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {}, transcript: async () => [],
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  return { chat, calls };
}

test("a gateway turn takes a checkpoint first and the user bubble carries its id", async () => {
  hook.calls.length = 0; cfgValues = {};
  hook.answers["checkpoints/snapshot"] = (body) => ({ id: "abc123def456", root: "/w", turn: body.turn });
  const { chat, calls } = make();
  const t = chat.newTab(true);
  await chat.send(t, { text: "change the thing" });
  const snap = hook.calls.find((c) => c.route === "checkpoints/snapshot");
  assert.ok(snap, "snapshot requested");
  assert.equal(snap.body.folder, "/w");
  assert.equal(snap.body.turn, 1);
  assert.equal(snap.body.label, "change the thing");
  const user = calls.posted.find((m) => m.type === "user");
  assert.equal(user.checkpoint, "abc123def456");
  assert.equal(calls.sent.length, 1, "the turn went out");
  await chat.send(t, { text: "again" });
  assert.equal(hook.calls.filter((c) => c.route === "checkpoints/snapshot").pop().body.turn, 2);
});

test("a folder that is not a git repository is told once and never blocks the turn", async () => {
  hook.calls.length = 0; cfgValues = {};
  hook.answers["checkpoints/snapshot"] = () => ({ __status: 409, body: { error: "not a git repository: /w", unsupported: true } });
  const { chat, calls } = make();
  const t = chat.newTab(true);
  await chat.send(t, { text: "one" });
  await chat.send(t, { text: "two" });
  assert.equal(calls.sent.length, 2);
  const users = calls.posted.filter((m) => m.type === "user");
  assert.ok(users.every((m) => m.checkpoint === undefined));
  const notes = calls.posted.filter((m) => m.type === "status" && /Revert changes is unavailable here/.test(m.text));
  assert.equal(notes.length, 1, "said once per tab");
});

test("kirocrew.checkpoints: false takes no checkpoint", async () => {
  hook.calls.length = 0; cfgValues = { checkpoints: false };
  const { chat, calls } = make();
  await chat.send(chat.newTab(true), { text: "x" });
  assert.equal(hook.calls.filter((c) => c.route === "checkpoints/snapshot").length, 0);
  assert.equal(calls.sent.length, 1);
  cfgValues = {};
});

test("revertTo previews, confirms with the file list, restores and posts a row with Undo; cancel does nothing", async () => {
  hook.calls.length = 0; warnings.length = 0; cfgValues = {};
  const files = [{ path: "src/a.js", status: "M" }, { path: "src/new.js", status: "A" }, { path: "gone.txt", status: "D" }];
  hook.answers["checkpoints/changed"] = { id: "abc123def456", root: "/w", files, same: false };
  hook.answers["checkpoints/revert"] = { id: "abc123def456", root: "/w", files, restored: 2, removed: 1, undo: "fedcba987654" };
  const { chat, calls } = make();
  const t = chat.newTab(true);
  warnAnswer = undefined;                       // the user dismisses the modal
  await chat.revertTo(t, "abc123def456");
  assert.equal(hook.calls.filter((c) => c.route === "checkpoints/revert").length, 0, "nothing restored on cancel");
  assert.match(warnings[0].m, /Revert 3 files/);
  assert.ok(warnings[0].o.modal);
  assert.match(warnings[0].o.detail, /remove src\/new\.js/);
  assert.match(warnings[0].o.detail, /restore gone\.txt/);
  warnAnswer = "Revert";
  await chat.revertTo(t, "abc123def456");
  const rev = hook.calls.find((c) => c.route === "checkpoints/revert");
  assert.deepEqual(rev.body, { folder: "/w", id: "abc123def456" });
  const row = calls.posted.find((m) => m.type === "reverted");
  assert.equal(row.files.length, 3);
  assert.equal(row.undo, "fedcba987654");
  assert.equal(row.root, "/w");
  assert.equal(row.undoOf, undefined);
});

test("an undo skips the confirmation and the row says so; a checkpoint equal to now says nothing to revert", async () => {
  hook.calls.length = 0; warnings.length = 0; cfgValues = {};
  hook.answers["checkpoints/revert"] = { id: "fedcba987654", root: "/w", files: [{ path: "src/a.js", status: "M" }], restored: 1, removed: 0, undo: "0123456789ab" };
  const { chat, calls } = make();
  const t = chat.newTab(true);
  await chat.revertTo(t, "fedcba987654", { undoOf: "abc123def456" });
  assert.equal(warnings.length, 0, "no modal for an undo");
  const row = calls.posted.find((m) => m.type === "reverted");
  assert.equal(row.undoOf, "abc123def456");
  assert.equal(row.undo, "0123456789ab");
  hook.answers["checkpoints/changed"] = { id: "abc123def456", root: "/w", files: [], same: true };
  calls.posted.length = 0;
  await chat.revertTo(t, "abc123def456");
  assert.equal(warnings.length, 0);
  assert.deepEqual(calls.posted.find((m) => m.type === "reverted").files, []);
});

test("a Kiro-mode spec run's echoed user bubble carries the checkpoint taken before the invoke", async () => {
  cfgValues = {};
  const { chat, calls } = make();
  const t = chat.newTab(true);
  t.kind = "kas";
  t.kas = ext.__test.kasTabState({ sessionId: "sess-1", mode: "spec" });
  t.kas.pendingCheckpoint = "aa11bb22cc33";
  chat.applyKasMessages(t, [{ type: "user", text: "Run all tasks" }, { type: "user", text: "a later turn" }]);
  const users = calls.posted.filter((m) => m.type === "user");
  assert.equal(users[0].checkpoint, "aa11bb22cc33", "the run's own bubble offers Revert changes");
  assert.equal(users[1].checkpoint, undefined, "and only that one");
  assert.equal(t.kas.pendingCheckpoint, null, "the id is spent");
});

test("a hook error on revert lands as an error row, not a thrown turn", async () => {
  cfgValues = {};
  hook.answers["checkpoints/changed"] = () => ({ __status: 404, body: { error: "unknown checkpoint zzz" } });
  const { chat, calls } = make();
  await chat.revertTo(chat.newTab(true), "zzz");
  const row = calls.posted.find((m) => m.type === "reverted");
  assert.match(row.error, /unknown checkpoint/);
});
