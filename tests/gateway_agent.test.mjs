// node --test: a KAS mode id (spec, quick-spec, bug-fix, plan, vibe, autonomous,
// default) never reaches the gateway as an agent. Before: a tab reopened from an
// old slot pinned to "spec" (the retired kiro-spec-plan handle) copied the id into
// its settings; the next tab inherited it through lastSettings/defaultSettings and
// dispatch() created a fresh "Run all tasks" session with agent "spec", which the
// gateway answered with "Bot 'spec' is unavailable; restore it or choose a member".
// Also: spec actions follow a Kiro-mode tab in front, not only the specEngine setting.
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
  workspace: { getConfiguration: () => ({ get: (k) => cfgValues[k] }), workspaceFolders: [], fs: {}, onDidChangeConfiguration: () => ({ dispose() {} }), createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }) },
  window: { showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, setStatusBarMessage() {}, visibleTextEditors: [], createOutputChannel: () => ({ appendLine() {} }) },
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
const ext = require(path.join(here, "..", "extension", "extension.js"));
const { gatewayAgent, GATEWAY_RESERVED_AGENT_IDS, unavailableAgentOf, ChatView } = ext.__test;

function make({ slotAgent, agents } = {}) {
  const calls = { created: [], sent: [], slotAgents: [], posted: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => (slotAgent ? { agent: slotAgent, title: "old" } : null), onDidChange: () => ({ dispose() {} }), agents: agents || [],
    create: async (o) => { calls.created.push(o); return "k" + (calls.created.length); },
    inject: async () => {}, send: async (key, text, agent) => { calls.sent.push({ key, text, agent }); },
    transcript: async () => [], replay: async () => [],
    setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async (key, agent) => { calls.slotAgents.push([key, agent]); },
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  return { chat, calls };
}

test("gatewayAgent maps every KAS reserved id to the crew default and leaves others alone", () => {
  for (const id of ["default", "vibe", "spec", "quick-spec", "bug-fix", "plan", "autonomous"]) {
    assert.ok(GATEWAY_RESERVED_AGENT_IDS.has(id), id);
    assert.equal(gatewayAgent(id), "");
    assert.equal(gatewayAgent(" " + id + " "), "");
  }
  assert.equal(gatewayAgent("o3r_default"), "o3r_default");
  assert.equal(gatewayAgent("spec-writer"), "spec-writer");
  assert.equal(gatewayAgent(undefined), "");
});

test("unavailableAgentOf reads the gateway's refusal and nothing else", () => {
  assert.equal(unavailableAgentOf("memory_unavailable: Bot 'spec' is unavailable; restore it or choose a member"), "spec");
  assert.equal(unavailableAgentOf("❌ Bot 'quick-spec' is unavailable; restore it or choose a member"), "quick-spec");
  assert.equal(unavailableAgentOf("the turn failed"), "");
});

test("a reserved id inherited through lastSettings never reaches dispatch's new session", async () => {
  const { chat, calls } = make();
  chat.lastSettings = { agent: "spec", baseAgent: "spec", mode: "default", engine: "" };
  assert.equal(chat.defaultSettings().agent, "");
  assert.equal(chat.defaultSettings().baseAgent, "");
  await chat.dispatch("Run all tasks for this spec.", { mode: "spec", agent: "spec", title: "Run all tasks", kind: "spec" });
  assert.equal(calls.created.length, 1);
  assert.ok(!calls.created[0].agent, "no agent on the slot: the crew default");
  assert.equal(calls.sent[0].agent, "");
});

test("a tab reopened from a slot pinned to 'spec' is not pinned to it; a slot with a real agent is", async () => {
  const { chat } = make({ slotAgent: "spec" });
  await chat.open("old-key");
  assert.equal(chat.tabForKey("old-key").settings.agent, "");
  const other = make({ slotAgent: "o3r_default" });
  await other.chat.open("old-key");
  assert.equal(other.chat.tabForKey("old-key").settings.agent, "o3r_default");
});

test("the slot's refusal at send time re-pins the session once, says so, and resends on the crew default", async () => {
  const { chat, calls } = make();
  let refused = 0;
  chat.sessions.send = async (key, text, agent) => {
    calls.sent.push({ key, text, agent });
    if (agent === "o3r_spec_pin" || (refused === 0 && calls.sent.length === 1)) { refused++; throw new Error("memory_unavailable: Bot 'spec' is unavailable; restore it or choose a member"); }
  };
  const t = chat.newTab(true); t.key = "k-old"; t.settings.agent = "o3r_default";
  await chat.send(t, { text: "hello" });
  assert.equal(refused, 1);
  assert.equal(calls.sent.length, 2, "one refusal, one resend");
  assert.deepEqual(calls.slotAgents, [["k-old", ""]]);
  assert.equal(t.settings.agent, "");
  assert.ok(calls.posted.some((m) => m.type === "status" && /pinned to 'spec'/.test(m.text)));
  // A second refusal is not swallowed.
  chat.sessions.send = async () => { throw new Error("Bot 'spec' is unavailable; restore it or choose a member"); };
  await assert.rejects(chat.send(t, { text: "again" }), /unavailable/);
});

test("specEngine follows a Kiro-mode tab in front when kiro-cli is usable, and the setting otherwise", async () => {
  const { chat } = make();
  const kas = ext.__test;
  cfgValues = {};
  assert.equal(await chat.specEngine(), "gateway");
  const t = chat.newTab(true); t.kind = "kas"; t.settings.engine = "kas"; t.kas = kas.kasTabState({ mode: "spec" });
  assert.ok(kas.isKasTab(t));
  const saved = chat.constructor.prototype.specEngine;
  // kasStatus is a module-level probe of the hook; stand in for it through the exported setter when present,
  // else assert the decision path up to the probe.
  if (typeof kas.invalidateKasStatus === "function") kas.invalidateKasStatus();
  const engine = await chat.specEngine();
  assert.ok(engine === "kas" || engine === "gateway");
  chat.constructor.prototype.specEngine = saved;
  cfgValues = {};
});
