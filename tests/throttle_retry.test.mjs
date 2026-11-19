// node --test: a turn the model provider throttled is sent again by itself.
// KiroCrew words the refusal "Bedrock is throttling requests. Try: (1) wait a
// few seconds and retry, or (2) switch to a different model in the picker.
// (request_id: …)" and kiro-cli/KAS pass the provider's own ThrottlingException
// through; before this the turn just died in the transcript. Covered: what
// counts as a throttle (and the two neighbours that must never be retried), the
// backoff, the gateway's thrown and streamed forms, a Kiro-mode turn, the cap,
// and Stop / a new turn cancelling a pending resend.
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
const { isThrottleText, throttleWaitMs, throttleRetryCap, THROTTLE_BACKOFF_MS, THROTTLE_RETRIES_DEFAULT, ChatView } = ext.__test;

/** The gateway's own wording, both backends. */
const BEDROCK = "❌ Bedrock is throttling requests. Try: (1) wait a few seconds and retry, or (2) switch to a different model in the picker. (request_id: 51d0550c-17d4-4c4a-b91a-d6f5351fb3cc)";
const PROVIDER = "❌ The model provider is throttling requests. Try: (1) wait a few seconds and retry, or (2) switch to a different model in the picker. (request_id: 51d0550c)";

function make() {
  const calls = { sent: [], posted: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [],
    create: async () => "k1", inject: async () => {}, transcript: async () => [], replay: async () => [],
    send: async (key, text, agent, meta) => { calls.sent.push({ key, text, agent, meta }); },
    setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {}, stop: async () => {},
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  chat.checkpointBeforeTurn = async () => "";
  chat.noteLinkOutcome = () => {};
  return { chat, calls };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
/** The real backoff, asserted below; the timing tests then run on a short one so the suite stays quick. */
const REAL_BACKOFF = [...THROTTLE_BACKOFF_MS];
const FAST = 20;
const fastBackoff = () => THROTTLE_BACKOFF_MS.splice(0, THROTTLE_BACKOFF_MS.length, FAST, FAST, FAST, FAST);

test("isThrottleText takes a rate refusal and leaves a usage limit or a missing model alone", () => {
  assert.ok(isThrottleText(BEDROCK));
  assert.ok(isThrottleText(PROVIDER));
  assert.ok(isThrottleText("ThrottlingException: Too many requests, please wait before trying again."));
  assert.ok(isThrottleText("HTTP 429 from the model endpoint"));
  assert.ok(isThrottleText("the provider rate limited this request"));
  // Waiting cannot help either of these, so they are never resent.
  assert.ok(!isThrottleText("You have used all of your monthly limit; the limit resets on the 1st."));
  assert.ok(!isThrottleText("Model 'claude-fable-5.1' is unavailable on the backend right now (capacity throttle or region rollout)."));
  assert.ok(!isThrottleText("the turn failed"));
  assert.ok(!isThrottleText(""));
  // A version or an id that merely contains 429 is not a status code.
  assert.ok(!isThrottleText("wrote 1.429 MB to disk"));
});

test("the backoff backs off and then holds", () => {
  assert.deepEqual(REAL_BACKOFF, [4000, 12000, 30000, 60000]);
  assert.deepEqual(REAL_BACKOFF.map((_, i) => throttleWaitMs(i + 1)), REAL_BACKOFF);
  assert.equal(throttleWaitMs(99), REAL_BACKOFF[REAL_BACKOFF.length - 1]);
  assert.equal(throttleWaitMs(0), REAL_BACKOFF[0]);
  fastBackoff();   // every test below waits on the real timers, so shorten them
});

test("the retry cap comes from the setting, clamped, and 0 turns the feature off", () => {
  cfgValues = {};
  assert.equal(throttleRetryCap(), THROTTLE_RETRIES_DEFAULT);
  cfgValues = { throttleRetries: 0 };
  assert.equal(throttleRetryCap(), 0);
  cfgValues = { throttleRetries: 99 };
  assert.equal(throttleRetryCap(), 10);
  cfgValues = { throttleRetries: -2 };
  assert.equal(throttleRetryCap(), 0);
  cfgValues = {};
});

test("a throttle thrown at the send is swallowed, said once, and the same turn goes again", async () => {
  cfgValues = { throttleRetries: 2 };
  const { chat, calls } = make();
  let refused = 0;
  chat.sessions.send = async (key, text, agent, meta) => {
    calls.sent.push({ key, text, agent, meta });
    if (calls.sent.length === 1) { refused++; throw new Error(PROVIDER); }
  };
  const t = chat.newTab(true); t.key = "k-old";
  await chat.send(t, { text: "hello" });         // resolves: the turn is not over
  assert.equal(refused, 1);
  const waiting = calls.posted.filter((m) => m.type === "starting" && /throttling requests/.test(m.text));
  assert.equal(waiting.length, 1);
  assert.match(waiting[0].text, /retry 1 of 2/);
  assert.ok(!calls.posted.some((m) => m.type === "error"), "no error row of our own while a retry is pending");
  await tick(FAST + 60);
  assert.equal(calls.sent.length, 2, "the same turn was sent again");
  assert.equal(calls.sent[1].text, calls.sent[0].text);
});

test("the retries run out: it says so and the next throttle surfaces as the error it is", async () => {
  cfgValues = { throttleRetries: 1 };
  const { chat, calls } = make();
  chat.sessions.send = async (key, text, agent, meta) => { calls.sent.push({ key, text, agent, meta }); throw new Error(BEDROCK); };
  const t = chat.newTab(true); t.key = "k-old";
  await chat.send(t, { text: "hello" });
  await tick(FAST + 60);
  assert.equal(calls.sent.length, 2, "one send, one retry");
  assert.ok(calls.posted.some((m) => m.type === "status" && /Still throttled after 1 automatic retry/.test(m.text)));
  assert.ok(calls.posted.some((m) => m.type === "error" && /throttling requests/.test(m.text)), "the last failure is shown");
  cfgValues = {};
});

test("with the setting at 0 a throttle is left alone", async () => {
  cfgValues = { throttleRetries: 0 };
  const { chat, calls } = make();
  chat.sessions.send = async () => { throw new Error(BEDROCK); };
  const t = chat.newTab(true); t.key = "k-old";
  await assert.rejects(chat.send(t, { text: "hello" }), /throttling requests/);
  assert.ok(!calls.posted.some((m) => m.type === "starting"));
  cfgValues = {};
});

test("a throttle streamed as the turn's error row resends and does not judge the run", async () => {
  cfgValues = { throttleRetries: 2 };
  const { chat, calls } = make();
  const t = chat.newTab(true); t.key = "k-old";
  t.retryTurn = { text: "Run all tasks for this spec.", agent: "", meta: undefined, tried: false };
  let judged = 0;
  chat.noteTurnEnd = () => { judged++; };
  chat.onFrame({ type: "chat_message", data: { slot: "k-old", role: "error", content: BEDROCK } });
  assert.equal(judged, 0, "the turn is not over, so the run is not judged");
  assert.ok(calls.posted.some((m) => m.type === "starting" && /retry 1 of 2/.test(m.text)));
  await tick(FAST + 60);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].text, "Run all tasks for this spec.");
  // An answer means the throttle passed: the count starts over.
  chat.onFrame({ type: "chat_message", data: { slot: "k-old", role: "assistant", content: "done" } });
  assert.equal(t.throttle.tries, 0);
  cfgValues = {};
});

test("a throttle on a Kiro-mode turn resends the same prompt and keeps the pane working", async () => {
  cfgValues = { throttleRetries: 2 };
  const { chat, calls } = make();
  const t = chat.newTab(true); t.key = "kas:sess_1"; t.kind = "kas"; t.kas = ext.__test.kasTabState({ mode: "spec" });
  t.kas.sessionId = "sess_1"; t.kas.running = true;
  let resent = 0;
  t.kasResend = async () => { resent++; };
  // What the adapter makes of KAS's error frame: the row, then a `done`.
  chat.applyKasMessages(t, [{ type: "error", text: "ThrottlingException: Too many requests" }, { type: "done" }]);
  assert.ok(calls.posted.some((m) => m.type === "error" && /Too many requests/.test(m.text)), "the transcript says what happened");
  assert.ok(calls.posted.some((m) => m.type === "starting" && /retry 1 of 2/.test(m.text)));
  assert.ok(!calls.posted.some((m) => m.type === "done"), "the done behind the error row is not this turn's");
  assert.equal(t.kas.running, true);
  await tick(FAST + 60);
  assert.equal(resent, 1);
  cfgValues = {};
});

test("Stop and a fresh turn both cancel a pending resend", async () => {
  cfgValues = { throttleRetries: 3 };
  const { chat, calls } = make();
  const t = chat.newTab(true); t.key = "k-old";
  let resent = 0;
  const resend = async () => { resent++; };
  assert.ok(chat.throttleRetry(t, BEDROCK, resend));
  await chat.onMessage({ type: "stop", id: t.id });
  await tick(FAST + 60);
  assert.equal(resent, 0, "Stop means do not send it again");
  assert.equal(t.throttle.tries, 0);
  // And a turn the user sends replaces the one that was waiting.
  t.stopped = false;
  assert.ok(chat.throttleRetry(t, BEDROCK, resend));
  await chat.send(t, { text: "something else" });
  await tick(FAST + 60);
  assert.equal(resent, 0);
  assert.equal(calls.sent.filter((s) => s.text === "something else").length, 1);
  cfgValues = {};
});
