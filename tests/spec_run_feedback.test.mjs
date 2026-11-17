// node --test: a spec action answers the click at once and in its own chat.
//
// beginSpecRun prepares the tab and posts the "starting…" row BEFORE the engine
// probe and the session create (the lag the Specs view used to show nothing for),
// dispatch lands in that very tab, and the page replaces the row with the turn's
// bubble. The empty chat offers Kiro's four workflows as tiles, which resolve to
// the kiro-cli mode when the picker offers it and to the mod's workflow otherwise.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let cfgValues = {};
const stub = {
  Uri: { file: (p) => ({ scheme: "file", path: p, fsPath: p }), joinPath: (u, ...s) => ({ scheme: "file", path: [u.path, ...s].join("/"), fsPath: [u.path, ...s].join("/") }), parse: (s) => ({ path: s }) },
  workspace: { getConfiguration: () => ({ get: (k) => cfgValues[k] }), workspaceFolders: [{ uri: { path: "/w", fsPath: "/w" }, name: "w" }], fs: {}, onDidChangeConfiguration: () => ({ dispose() {} }), createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }) },
  window: { showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, setStatusBarMessage() {}, visibleTextEditors: [], createOutputChannel: () => ({ appendLine() {} }) },
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
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });

const ext = require(path.join(here, "..", "extension", "extension.js"));
const { ChatView, chatHtml, WORKFLOWS } = ext.__test;

function make() {
  const calls = { posted: [], created: [], sent: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [],
    create: async (o) => { calls.created.push(o); return "k" + calls.created.length; },
    inject: async () => {}, send: async (key, text, agent) => { calls.sent.push({ key, text, agent }); },
    setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {}, transcript: async () => [],
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  return { chat, calls };
}

test("beginSpecRun: a selected tab with the run's settings and a starting row, before anything is sent", () => {
  cfgValues = {};
  const { chat, calls } = make();
  const t = chat.beginSpecRun({ mode: "spec", agent: "spec-writer", kind: "spec", title: "Run all tasks", display: "Run all tasks", autopilot: true, run: { spec: "foo", dir: "/w/.kiro/specs/foo" }, spec: { name: "foo", dir: "/w/.kiro/specs/foo" } });
  assert.equal(chat.active, t.id, "the prepared tab is in front");
  assert.equal(t.key, null, "no session yet");
  assert.equal(t.settings.mode, "spec");
  assert.equal(t.settings.agent, "spec-writer");
  assert.equal(t.settings.autopilot, true);
  assert.equal(t.settings.engine, "", "the gateway unless the engine probe says otherwise");
  assert.deepEqual(t.spec, { name: "foo", dir: "/w/.kiro/specs/foo" });
  assert.equal(t.run.resumed, 0);
  const row = calls.posted.find((m) => m.type === "starting");
  assert.ok(row, "the chat says it is starting");
  assert.equal(row.id, t.id);
  assert.match(row.text, /^Run all tasks — starting…$/);
  assert.equal(calls.created.length, 0, "nothing was created to say it");
  // A reserved mode id still never reaches the gateway.
  const other = chat.beginSpecRun({ mode: "spec", agent: "spec", display: "x" });
  assert.equal(other.settings.agent, "");
});

test("dispatch lands in the prepared tab and draws its bubble there, keeping the run record", async () => {
  cfgValues = {};
  const { chat, calls } = make();
  const prepared = chat.beginSpecRun({ mode: "spec", kind: "spec", display: "Run all tasks", run: { spec: "foo", dir: "/w/.kiro/specs/foo" } });
  const tabs = chat.tabs.length;
  const key = await chat.dispatch("Run all tasks for this spec.", { mode: "spec", kind: "spec", title: "Run all tasks", display: "Run all tasks", run: { spec: "foo", dir: "/w/.kiro/specs/foo" }, tab: prepared });
  assert.equal(chat.tabs.length, tabs, "no second tab");
  assert.equal(prepared.key, key, "the prepared tab carries the session");
  assert.equal(calls.created.length, 1);
  const bubbles = calls.posted.filter((m) => m.type === "user");
  assert.equal(bubbles[0].id, prepared.id);
  assert.equal(bubbles[0].local, bubbles[1].local, "the early bubble is completed, not duplicated");
  assert.equal(prepared.run.spec, "foo");
  // Without a prepared tab, dispatch still makes its own.
  const before = chat.tabs.length;
  await chat.dispatch("again", { mode: "spec", kind: "spec", display: "again" });
  assert.equal(chat.tabs.length, before + 1);
});

test("the page keeps a starting row until the turn's bubble arrives, and drops it in both bubble paths", () => {
  const html = chatHtml("fox.svg");
  assert.ok(html.includes("function dropStarting(st)"), "the row has a remover");
  assert.ok(/case 'starting': \{[^]*?el\(st,'status starting', m\.text\|\|'Starting…'\); st\.running=true; setWork\(st\);/.test(html), "a starting row sets the pane working");
  assert.ok(/if\(own\)\{ dropStarting\(st\);/.test(html), "the completed bubble drops it");
  assert.ok(/thinkClose\(st\); dropResume\(st\); dropStarting\(st\); const d=el\(st,'user'\)/.test(html), "a new bubble drops it too");
  assert.ok(/\.row\.starting\{opacity:/.test(html), "and it is styled apart from an ordinary status row");
});

test("the empty chat offers Kiro's four workflows as tiles that pick the right engine", () => {
  const html = chatHtml("fox.svg");
  const modes = WORKFLOWS.filter((w) => w.id !== "default").map((w) => w.id);
  assert.deepEqual(modes, ["spec", "quick-spec", "bug-fix", "plan"]);
  assert.ok(html.includes("const EMPTY_MODES = "), "the tiles come from the mod's own workflow list");
  for (const w of WORKFLOWS.filter((x) => x.id !== "default")) assert.ok(html.includes('"' + w.id + '"') && html.includes('"' + w.label + '"'), w.id);
  assert.ok(html.includes("function pickMode(mode)"), "a tile picks a mode");
  assert.ok(/const kas=\(choices\.agents\|\|\[\]\)\.find\(\(x\)=>x\.id==='kas:'\+mode\);/.test(html), "Kiro's own mode when the picker offers it");
  assert.ok(/const id=kas\?kas\.id:'workflow:'\+mode;/.test(html), "the mod's workflow otherwise");
  assert.ok(/vscode\.postMessage\(\{type:'setting', id:active, key:'pick', value:id\}\)/.test(html), "through the same pick message the agent menu sends");
  assert.ok(/\.empty \.modes\{pointer-events:auto/.test(html), "the tiles take clicks although the empty state does not");
});
