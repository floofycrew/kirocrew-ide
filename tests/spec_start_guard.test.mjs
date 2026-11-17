// node --test: one spec chat per click. SpecStartGuard holds a start per spec
// directory (or the unkeyed SPEC_START_ANY) until its work settles; a click that
// collides gets the start already going (same promise, onDuplicate told), two
// specs start side by side, the hold ends on success and on failure, onChange
// fires for the Specs view, progress wraps the work; specStartKey reads the
// spec directory off a Specs node, a `{ dir }` record, a document Uri or nothing.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

class EventEmitter {
  constructor() { this._listeners = []; this.event = (fn) => { this._listeners.push(fn); return { dispose: () => undefined }; }; }
  fire(e) { for (const l of this._listeners.slice()) l(e); }
  dispose() { this._listeners = []; }
}
const stub = {
  EventEmitter,
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  Uri: { file: (p) => ({ scheme: "file", path: p, fsPath: p }), joinPath: (u, ...s) => ({ scheme: "file", path: [u.path, ...s].join("/") }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, d) => d }), createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }), fs: {} },
  window: { setStatusBarMessage() {}, showInformationMessage: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  languages: {},
  ProgressLocation: { Notification: 15 },
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
const { SPEC_START_ANY, SPEC_START_NEW, SpecStartGuard, specStartKey } = ext.__test;

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a second click on the same spec while its start is going gets the first start, not a new one", async () => {
  const dups = [];
  const guard = new SpecStartGuard({ onDuplicate: (held, wanted) => dups.push([held, wanted]) });
  const gate = deferred();
  let runs = 0;
  const work = async () => { runs++; await gate.promise; return "key-1"; };
  const first = guard.run("/w/.kiro/specs/a", "Run all tasks", work);
  const second = guard.run("/w/.kiro/specs/a", "Write design", work);
  assert.equal(runs, 1, "the second click ran nothing");
  assert.equal(second, first, "it holds the first start's promise");
  assert.deepEqual(dups, [["Run all tasks", "Write design"]]);
  assert.equal(guard.titleFor("/w/.kiro/specs/a"), "Run all tasks");
  gate.resolve();
  assert.equal(await second, "key-1");
  assert.equal(guard.size, 0, "the hold ends when the work settles");
  assert.equal(guard.titleFor("/w/.kiro/specs/a"), null);
});

test("two specs start side by side; the hold is per directory", async () => {
  const guard = new SpecStartGuard();
  const a = deferred(), b = deferred();
  let runs = 0;
  const pa = guard.run("/w/.kiro/specs/a", "Run all tasks", async () => { runs++; await a.promise; return "a"; });
  const pb = guard.run("/w/.kiro/specs/b", "Write design", async () => { runs++; await b.promise; return "b"; });
  assert.equal(runs, 2);
  assert.equal(guard.size, 2);
  a.resolve(); b.resolve();
  assert.deepEqual(await Promise.all([pa, pb]), ["a", "b"]);
  assert.equal(guard.size, 0);
});

test("an unkeyed start (the spec is not known at the click) collides with every start, and every start collides with it", async () => {
  const guard = new SpecStartGuard();
  const gate = deferred();
  let runs = 0;
  const first = guard.run(SPEC_START_ANY, "Run all tasks", async () => { runs++; await gate.promise; return 1; });
  assert.equal(guard.run("/w/.kiro/specs/a", "Write design", async () => { runs++; return 2; }), first, "a keyed click waits on the unkeyed start");
  gate.resolve();
  await first;
  const gate2 = deferred();
  const keyed = guard.run("/w/.kiro/specs/a", "Write design", async () => { runs++; await gate2.promise; return 3; });
  assert.equal(guard.run(SPEC_START_ANY, "Resume run", async () => { runs++; return 4; }), keyed, "an unkeyed click waits on any start");
  gate2.resolve();
  await keyed;
  assert.equal(runs, 2);
});

test("a start that fails releases its hold and rejects every holder", async () => {
  const guard = new SpecStartGuard();
  const gate = deferred();
  const first = guard.run("/w/.kiro/specs/a", "Run all tasks", async () => { await gate.promise; });
  const second = guard.run("/w/.kiro/specs/a", "Run all tasks", async () => "never");
  gate.reject(new Error("gateway down"));
  await assert.rejects(first, /gateway down/);
  await assert.rejects(second, /gateway down/);
  assert.equal(guard.size, 0);
  // and the spec can start again
  assert.equal(await guard.run("/w/.kiro/specs/a", "Run all tasks", async () => "ok"), "ok");
});

test("onChange fires when a hold starts and when it ends; progress wraps the work with the title", async () => {
  const changes = [];
  const progressed = [];
  const guard = new SpecStartGuard({
    onChange: () => changes.push(guard.size),
    progress: async (title, work) => { progressed.push(title); return work(); },
  });
  assert.equal(await guard.run("/w/.kiro/specs/a", "Write tasks", async () => "k"), "k");
  assert.deepEqual(changes, [1, 0]);
  assert.deepEqual(progressed, ["Write tasks"]);
});

test("a synchronous throw inside the work still releases the hold", async () => {
  const guard = new SpecStartGuard();
  await assert.rejects(guard.run("/w/.kiro/specs/a", "Run all tasks", () => { throw new Error("boom"); }), /boom/);
  await tick();
  assert.equal(guard.size, 0);
});

test("specStartKey reads the spec directory off what a command is invoked on", () => {
  const dir = { scheme: "file", path: "/w/.kiro/specs/a" };
  assert.equal(specStartKey({ spec: { name: "a", dir }, contextValue: "spec" }), "/w/.kiro/specs/a", "a Specs view node");
  assert.equal(specStartKey({ spec: { name: "a", dir }, task: { id: "1" } }), "/w/.kiro/specs/a", "a task node");
  assert.equal(specStartKey({ feature: "a", dir }), "/w/.kiro/specs/a", "a lens / fix argument with a Uri dir");
  assert.equal(specStartKey({ dir: "/w/.kiro/specs/a" }), "/w/.kiro/specs/a", "a string dir");
  assert.equal(specStartKey({ dir: SPEC_START_NEW }), SPEC_START_NEW, "the ＋ wizard's own key");
  assert.equal(specStartKey({ scheme: "file", path: "/w/.kiro/specs/a/tasks.md", fsPath: "/w/.kiro/specs/a/tasks.md" }), "/w/.kiro/specs/a", "a spec document Uri (the title-bar actions)");
  assert.equal(specStartKey({ uri: { path: "/w/.kiro/specs/b/design.md" } }), "/w/.kiro/specs/b", "a `{ uri }` record");
  assert.equal(specStartKey({ scheme: "file", path: "/w/src/main.js" }), SPEC_START_ANY, "a file outside .kiro/specs");
  assert.equal(specStartKey(undefined), SPEC_START_ANY, "the palette: nothing to go on");
  assert.equal(specStartKey(null), SPEC_START_ANY);
});
