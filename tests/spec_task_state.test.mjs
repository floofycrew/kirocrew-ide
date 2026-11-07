// node --test: `taskState` (requirement 4.7) — the box on the task line
// decides first (`[x]` completed, `[~]` queued, `[-]` in progress); a `[ ]`
// task takes its state from the latest TaskSessionLinks record of the task:
// `error` → failed, `stopped` → aborted once the session is no longer running,
// anything else → not started. Table-driven over every box × link situation,
// plus the feature fallback and the store/array inputs. Same stub `vscode`
// module as task_session_links.test.mjs.
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

const ext = require(path.join(here, "..", "extension", "extension.js"));
const { TASK_STATES, taskState, taskStateLink, TaskSessionLinks, parseTasks } = ext.__test;

const FEATURE = "foo";
const DIR = "/w/.kiro/specs/foo";
const SESSION = "kide-task-1";
const link = (extra) => Object.assign({ id: "l1", feature: FEATURE, dir: DIR, taskIds: ["2.1"], sessionId: SESSION, startedAt: 100 }, extra || {});
const task = (box, extra) => Object.assign({ id: "2.1", number: "2.1", title: "Do it", box }, extra || {});

/** The six link situations of the requirement and what each means for a `[ ]` task. */
const SITUATIONS = [
  { name: "no link", links: [], running: false, blank: "not_started" },
  { name: "link without an outcome yet", links: [link()], running: true, blank: "not_started" },
  { name: "outcome ok", links: [link({ outcome: "ok" })], running: false, blank: "not_started" },
  { name: "outcome error", links: [link({ outcome: "error" })], running: false, blank: "failed" },
  { name: "outcome stopped, session still running", links: [link({ outcome: "stopped" })], running: true, blank: "not_started" },
  { name: "outcome stopped, session no longer running", links: [link({ outcome: "stopped" })], running: false, blank: "aborted" },
];
/** The four boxes; `null` means "whatever the link situation says". */
const BOXES = [
  { box: " ", state: null },
  { box: "~", state: "queued" },
  { box: "-", state: "in_progress" },
  { box: "x", state: "completed" },
];

test("TASK_STATES names the six states", () => {
  assert.deepEqual(TASK_STATES, ["not_started", "queued", "in_progress", "completed", "failed", "aborted"]);
});

for (const b of BOXES) {
  for (const s of SITUATIONS) {
    const expected = b.state || s.blank;
    test(`[${b.box}] with ${s.name} → ${expected}`, () => {
      const seen = [];
      const opts = { feature: FEATURE, dir: DIR, isRunning: (id) => { seen.push(id); return s.running; } };
      assert.equal(taskState(task(b.box), s.links, opts), expected);
      assert.ok(TASK_STATES.includes(expected));
      // The box wins before any record is consulted; the predicate is asked only for a stopped run.
      if (b.state) assert.deepEqual(seen, []);
      else if (s.links.length && s.links[0].outcome === "stopped") assert.deepEqual(seen, [SESSION]);
      else assert.deepEqual(seen, []);
    });
  }
}

test("`[X]` upper-case and a `status` field without a box both count", () => {
  assert.equal(taskState(task("X"), [link({ outcome: "error" })], { feature: FEATURE }), "completed");
  assert.equal(taskState({ id: "2.1", status: "queued" }, [link({ outcome: "error" })], { feature: FEATURE }), "queued");
  assert.equal(taskState({ id: "2.1", status: "not_started" }, [link({ outcome: "error" })], { feature: FEATURE }), "failed");
});

test("the latest record of the task decides, not an older one", () => {
  const links = [link({ id: "a", outcome: "error", startedAt: 100 }), link({ id: "b", sessionId: "s-b", outcome: "ok", startedAt: 200 })];
  assert.equal(taskState(task(" "), links, { feature: FEATURE }), "not_started");
  const flipped = [link({ id: "a", outcome: "ok", startedAt: 100 }), link({ id: "b", sessionId: "s-b", outcome: "error", startedAt: 200 })];
  assert.equal(taskState(task(" "), flipped, { feature: FEATURE }), "failed");
  // Between equal stamps the later array entry is the newer.
  const tied = [link({ id: "a", outcome: "error" }), link({ id: "b", outcome: "stopped" })];
  assert.equal(taskState(task(" "), tied, { feature: FEATURE, isRunning: () => false }), "aborted");
});

test("a sibling's own run never colours this task", () => {
  const links = [link({ taskIds: ["1.1"], outcome: "error" })];
  assert.equal(taskState(task(" "), links, { feature: FEATURE }), "not_started");
  assert.equal(taskStateLink(links, FEATURE, "2.1", DIR), null);
});

test("feature fallback: a spec-wide run that named no tasks decides for every task", () => {
  const whole = link({ id: "w", taskIds: [], outcome: "error" });
  assert.equal(taskState(task(" "), [whole], { feature: FEATURE, dir: DIR }), "failed");
  assert.equal(taskState(task(" ", { id: "9.9" }), [whole], { feature: FEATURE, dir: DIR }), "failed");
  assert.equal(taskStateLink([whole], FEATURE, "2.1", DIR).id, "w");
  // The task's own record, even an older one, outranks the feature fallback.
  const own = link({ id: "o", outcome: "stopped", startedAt: 50 });
  assert.equal(taskStateLink([whole, own], FEATURE, "2.1", DIR).id, "o");
  assert.equal(taskState(task(" "), [whole, own], { feature: FEATURE, dir: DIR, isRunning: () => false }), "aborted");
  // A fallback record is still subject to the running check.
  const stoppedWhole = link({ id: "w2", taskIds: [], outcome: "stopped" });
  assert.equal(taskState(task(" "), [stoppedWhole], { feature: FEATURE, isRunning: () => true }), "not_started");
  assert.equal(taskState(task(" "), [stoppedWhole], { feature: FEATURE, isRunning: () => false }), "aborted");
});

test("another feature's or another directory's record is ignored", () => {
  assert.equal(taskState(task(" "), [link({ feature: "bar", outcome: "error" })], { feature: FEATURE }), "not_started");
  assert.equal(taskState(task(" "), [link({ dir: "/elsewhere/.kiro/specs/foo", outcome: "error" })], { feature: FEATURE, dir: DIR }), "not_started");
  // Without a directory on either side the feature name alone matches.
  assert.equal(taskState(task(" "), [link({ dir: null, outcome: "error" })], { feature: FEATURE, dir: DIR }), "failed");
  assert.equal(taskState(task(" "), [link({ outcome: "error" })], { feature: FEATURE }), "failed");
});

test("feature and dir may ride on the task itself; no feature means no record", () => {
  assert.equal(taskState(task(" ", { feature: FEATURE, dir: DIR }), [link({ outcome: "error" })]), "failed");
  assert.equal(taskState(task(" "), [link({ outcome: "error" })]), "not_started");
  assert.equal(taskState(task(" "), [link({ outcome: "error" })], {}), "not_started");
});

test("without an isRunning predicate a stopped run is aborted; a stopped run with no session id too", () => {
  assert.equal(taskState(task(" "), [link({ outcome: "stopped" })], { feature: FEATURE }), "aborted");
  assert.equal(taskState(task(" "), [link({ outcome: "stopped", sessionId: null })], { feature: FEATURE, isRunning: () => true }), "aborted");
});

test("the store is accepted in place of the array and reflects its writes", () => {
  const store = new TaskSessionLinks(null, { initial: [] });
  const opts = { feature: FEATURE, dir: DIR, isRunning: () => false };
  assert.equal(taskState(task(" "), store, opts), "not_started");
  const rec = store.record({ feature: FEATURE, dir: DIR, taskIds: ["2.1"] });
  assert.equal(taskState(task(" "), store, opts), "not_started");
  store.setSession(rec.id, SESSION);
  store.setOutcome(rec.id, "error");
  assert.equal(taskState(task(" "), store, opts), "failed");
  store.setOutcome(SESSION, "stopped");
  assert.equal(taskState(task(" "), store, opts), "aborted");
  assert.equal(taskState(task(" "), store, Object.assign({}, opts, { isRunning: (id) => id === SESSION })), "not_started");
  store.setOutcome(rec.id, "ok");
  assert.equal(taskState(task(" "), store, opts), "not_started");
});

test("parseTasks rows feed taskState as they are", () => {
  const rows = parseTasks("- [ ] 1. First\n  - [-] 1.1 Going\n  - [x] 1.2 Done\n- [~] 2. Later\n- [ ] 3. Broke\n");
  const byNumber = Object.fromEntries(rows.map((r) => [r.number, r]));
  // A run records the rows' `id`s (the task text), the same value `runTask` / `runAll` store.
  const links = [link({ taskIds: [byNumber["3"].id], outcome: "error" }), link({ id: "l0", taskIds: [byNumber["1"].id], outcome: "stopped", startedAt: 90 })];
  const opts = { feature: FEATURE, dir: DIR, isRunning: () => false };
  assert.equal(taskState(byNumber["1"], links, opts), "aborted");
  assert.equal(taskState(byNumber["1.1"], links, opts), "in_progress");
  assert.equal(taskState(byNumber["1.2"], links, opts), "completed");
  assert.equal(taskState(byNumber["2"], links, opts), "queued");
  assert.equal(taskState(byNumber["3"], links, opts), "failed");
});

test("garbage in: a missing task or unusable links still yield a state", () => {
  assert.equal(taskState(null, null), "not_started");
  assert.equal(taskState(undefined, undefined, { feature: FEATURE }), "not_started");
  assert.equal(taskState(task(" "), [null, {}, { taskIds: ["2.1"], outcome: "error" }], { feature: FEATURE }), "not_started");
  assert.equal(taskState(task("?"), [link({ outcome: "error" })], { feature: FEATURE }), "failed");
});
