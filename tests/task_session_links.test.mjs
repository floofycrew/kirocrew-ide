// node --test: TaskSessionLinks (requirement 13) — record pruning to the 200
// most recent, the latest-record lookup per task, the feature fallback, the
// store's events and persistence, and `resolveViewSessionLink` cases that
// complement the two in spec_model.test.mjs. Same stub `vscode` module as
// extension_unit.test.mjs, with an EventEmitter that keeps its listeners so
// the event order can be observed.
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
const {
  TASK_SESSION_LINKS_KEY, TASK_SESSION_LINKS_MAX, LINK_OUTCOMES,
  normalizeLink, readLinks, pruneLinks, latestLink, linkMatchesFeature,
  latestLinkForTask, latestLinkForFeature, findLink, TaskSessionLinks, resolveViewSessionLink,
} = ext.__test;

const DIR = "/w/.kiro/specs/foo";
const link = (id, startedAt, extra) => Object.assign({ id, feature: "foo", dir: DIR, taskIds: [], sessionId: "s-" + id, startedAt }, extra || {});

/** A `workspaceState` double: `get`/`update` over a plain map, remembering every write. */
function fakeWorkspaceState(initial) {
  const store = new Map(Object.entries(initial || {}));
  const writes = [];
  return {
    store, writes,
    get(key) { return store.get(key); },
    update(key, value) { store.set(key, value); writes.push({ key, value }); return Promise.resolve(); },
  };
}

// ---- constants

test("the store key, the cap of 200 and the three outcomes are what the design names", () => {
  assert.equal(TASK_SESSION_LINKS_KEY, "kirocrew.taskSessionLinks");
  assert.equal(TASK_SESSION_LINKS_MAX, 200);
  assert.deepEqual(LINK_OUTCOMES, ["ok", "error", "stopped"]);
});

// ---- pruning (13.3)

test("pruneLinks keeps the 200 most recent of 252 by startedAt, oldest first, and leaves the input untouched", () => {
  // Shuffled insertion order so the sort, not the array position, decides.
  const all = Array.from({ length: 252 }, (_, i) => link("r" + i, 1000 + i));
  const shuffled = all.slice().sort((a, b) => (a.id.length - b.id.length) || (a.id < b.id ? 1 : -1));
  const before = shuffled.slice();
  const kept = pruneLinks(shuffled);
  assert.equal(kept.length, 200);
  assert.deepEqual(kept.map((l) => l.startedAt), Array.from({ length: 200 }, (_, i) => 1052 + i), "the 52 oldest are dropped; the rest come back oldest first");
  assert.deepEqual(shuffled, before, "the input array is not reordered");
  assert.notEqual(kept, shuffled, "a new array is returned");
  assert.equal(kept[0], all[52], "records are the same objects, not copies");
  // Under the cap, nothing is dropped; the sort still applies.
  assert.deepEqual(pruneLinks([link("b", 2), link("a", 1)]).map((l) => l.id), ["a", "b"]);
});

test("pruneLinks breaks startedAt ties by array position (the later entry is the newer) and honours an explicit max", () => {
  const ties = [link("p", 5), link("q", 5), link("r", 5), link("s", 5)];
  assert.deepEqual(pruneLinks(ties, 2).map((l) => l.id), ["r", "s"], "equal times keep the order they were recorded in; the last two are the newest");
  assert.deepEqual(pruneLinks(ties, 10).map((l) => l.id), ["p", "q", "r", "s"], "a stable sort: ties never reorder");
  assert.deepEqual(pruneLinks(ties, 0), [], "max 0 keeps nothing");
  assert.deepEqual(pruneLinks(ties, -3), [], "a negative max keeps nothing");
  assert.deepEqual(pruneLinks(ties, 2.9).map((l) => l.id), ["r", "s"], "a fractional max is floored");
  assert.deepEqual(pruneLinks(ties, "nope"), [], "an unparsable max keeps nothing");
  assert.deepEqual(pruneLinks(null), []);
  assert.deepEqual(pruneLinks(undefined, 3), []);
});

// ---- normalizeLink / readLinks on malformed input

test("normalizeLink: a usable record is made type-safe; anything without a feature string is null", () => {
  for (const bad of [null, undefined, 42, "foo", [], {}, { feature: "" }, { feature: 7 }, { feature: null, taskIds: ["1"] }]) {
    assert.equal(normalizeLink(bad), null, "rejected: " + JSON.stringify(bad));
  }
  const full = normalizeLink({ id: "a", feature: "foo", dir: DIR, taskIds: ["1", "2"], sessionId: "s", startedAt: 123, outcome: "ok" });
  assert.deepEqual(full, { id: "a", feature: "foo", dir: DIR, taskIds: ["1", "2"], sessionId: "s", startedAt: 123, outcome: "ok" });
  // Only the feature is required; the rest is defaulted.
  const bare = normalizeLink({ feature: "foo" });
  assert.match(bare.id, /^[0-9a-f-]{36}$/, "a missing id gets a fresh uuid");
  assert.equal(bare.dir, null);
  assert.deepEqual(bare.taskIds, []);
  assert.equal(bare.sessionId, null);
  assert.equal(bare.startedAt, 0);
  assert.equal("outcome" in bare, false, "no outcome key when none was stored");
  assert.notEqual(normalizeLink({ feature: "foo" }).id, normalizeLink({ feature: "foo" }).id);
});

test("normalizeLink: wrong-typed fields are dropped or coerced, never passed through", () => {
  const odd = normalizeLink({
    id: 12, feature: "foo", dir: { path: DIR }, taskIds: ["1", 2, "", null, "3", { id: "4" }], sessionId: 99,
    startedAt: "1700000000000", outcome: "exploded",
  });
  assert.match(odd.id, /^[0-9a-f-]{36}$/, "a non-string id is replaced");
  assert.equal(odd.dir, null, "a non-string dir is dropped");
  assert.deepEqual(odd.taskIds, ["1", "3"], "only non-empty string task ids survive");
  assert.equal(odd.sessionId, null, "a non-string session id is dropped");
  assert.equal(odd.startedAt, 1700000000000, "a numeric string startedAt is coerced");
  assert.equal("outcome" in odd, false, "an unknown outcome is dropped");
  assert.deepEqual(normalizeLink({ feature: "foo", taskIds: "1,2" }).taskIds, [], "a non-array taskIds is an empty list");
  assert.equal(normalizeLink({ feature: "foo", startedAt: NaN }).startedAt, 0);
  assert.equal(normalizeLink({ feature: "foo", startedAt: Infinity }).startedAt, 0);
  assert.equal(normalizeLink({ feature: "foo", startedAt: "2024-01-01" }).startedAt, 0, "an ISO string is not a number");
  assert.equal(normalizeLink({ feature: "foo", outcome: "stopped" }).outcome, "stopped");
  assert.equal(normalizeLink({ feature: "foo", sessionId: "" }).sessionId, null);
});

test("readLinks: a non-array is empty; unusable entries are skipped and the order of the rest is kept", () => {
  for (const bad of [undefined, null, "[]", 3, { 0: { feature: "foo" } }]) assert.deepEqual(readLinks(bad), [], "non-array: " + JSON.stringify(bad));
  const stored = [null, link("a", 1), "junk", { feature: "" }, link("b", 2), { feature: "bar", taskIds: null }, 7];
  const read = readLinks(stored);
  assert.deepEqual(read.map((l) => l.id), ["a", "b", read[2].id]);
  assert.deepEqual(read[2], Object.assign({ feature: "bar", dir: null, taskIds: [], sessionId: null, startedAt: 0 }, { id: read[2].id }));
  assert.notEqual(read[0], stored[1], "records are fresh objects, not the stored ones");
});

// ---- latest-record lookup and the feature fallback (13.2)

const LINKS = [
  link("a", 100, { taskIds: ["1", "2", "3"] }),                 // run-all
  link("b", 300, { taskIds: ["2"], outcome: "error" }),
  link("c", 200, { taskIds: ["2"], outcome: "ok" }),            // older than b, stored after it
  link("d", 300, { taskIds: ["3"], outcome: "ok" }),            // ties with b on time
  link("e", 50, { feature: "bar", dir: "/w/.kiro/specs/bar", taskIds: ["1"] }),
  link("f", 400, { feature: "foo", dir: "/elsewhere/.kiro/specs/foo", taskIds: ["1"] }),
];

test("latestLink picks the newest by startedAt, then by position; null when nothing matches", () => {
  assert.equal(latestLink(LINKS).id, "f");
  assert.equal(latestLink(LINKS, (l) => l.startedAt === 300).id, "d", "equal times: the later array entry wins");
  assert.equal(latestLink([link("y", 300), link("x", 300)], (l) => l.startedAt === 300).id, "x");
  assert.equal(latestLink(LINKS, (l) => l.taskIds.includes("9")), null);
  assert.equal(latestLink([null, undefined, link("z", 1)]).id, "z", "holes are skipped");
  assert.equal(latestLink(null), null);
  assert.equal(latestLink([]), null);
});

test("latestLinkForTask: the newest record whose run included the task, not the newest record of the feature", () => {
  assert.equal(latestLinkForTask(LINKS, "foo", "2", DIR).id, "b", "task 2 ran in a, c and b; b is the newest by time even though c was stored later");
  assert.equal(latestLinkForTask(LINKS, "foo", "1", DIR).id, "a", "task 1 only ran in the run-all of this directory");
  assert.equal(latestLinkForTask(LINKS, "foo", "3", DIR).id, "d");
  assert.equal(latestLinkForTask(LINKS, "foo", "9", DIR), null, "a task that never ran has no record: the caller falls back to the feature");
  assert.equal(latestLinkForTask(LINKS, "bar", "1").id, "e");
  assert.equal(latestLinkForTask(LINKS, "nope", "1"), null);
  assert.equal(latestLinkForTask([], "foo", "1"), null);
  assert.equal(latestLinkForTask(LINKS, "foo", "2.1", DIR), null, "ids match exactly; '2' does not cover '2.1'");
});

test("latestLinkForFeature is the fallback: the newest record of the spec, whichever tasks it ran", () => {
  assert.equal(latestLinkForFeature(LINKS, "foo", DIR).id, "d", "ties on time: d was recorded after b");
  assert.equal(latestLinkForFeature(LINKS, "bar", "/w/.kiro/specs/bar").id, "e");
  assert.equal(latestLinkForFeature(LINKS, "baz"), null);
  // Without a directory, every record of that feature name counts, so the other checkout's run is the newest.
  assert.equal(latestLinkForFeature(LINKS, "foo").id, "f");
});

test("dir scoping: a directory on both sides must match (trailing slash and /local prefix ignored); a missing one on either side matches", () => {
  const l = link("x", 1, { dir: "/local/home/u/w/.kiro/specs/foo" });
  assert.equal(linkMatchesFeature(l, "foo", "/home/u/w/.kiro/specs/foo"), true, "the symlinked spelling of the same home");
  assert.equal(linkMatchesFeature(l, "foo", "/local/home/u/w/.kiro/specs/foo/"), true, "a trailing slash");
  assert.equal(linkMatchesFeature(l, "foo", "/home/u/other/.kiro/specs/foo"), false, "a different checkout of the same spec name");
  assert.equal(linkMatchesFeature(l, "foo"), true, "the caller knows no directory");
  assert.equal(linkMatchesFeature(link("y", 1, { dir: null }), "foo", DIR), true, "the record knows no directory");
  assert.equal(linkMatchesFeature(l, "bar", "/home/u/w/.kiro/specs/foo"), false, "the name must match regardless");
  assert.equal(linkMatchesFeature(null, "foo"), false);
  assert.equal(latestLinkForTask(LINKS, "foo", "1", "/elsewhere/.kiro/specs/foo").id, "f");
  assert.equal(latestLinkForFeature(LINKS, "foo", "/w/.kiro/specs/foo/").id, "d");
});

test("findLink: the record id wins; a session id returns that session's latest record; nothing for an unknown or empty ref", () => {
  const shared = [link("a", 1, { sessionId: "s" }), link("b", 3, { sessionId: "s" }), link("c", 2, { sessionId: "s" })];
  assert.equal(findLink(shared, "c").id, "c", "by record id");
  assert.equal(findLink(shared, "s").id, "b", "by session id: three records share the session; the newest by startedAt");
  // A record id that is also some other record's session id: the id lookup comes first.
  const clash = [link("x", 1, { sessionId: "y" }), link("y", 2, { sessionId: "z" })];
  assert.equal(findLink(clash, "y").id, "y");
  assert.equal(findLink(shared, "nope"), null);
  assert.equal(findLink(shared, ""), null);
  assert.equal(findLink(shared, null), null);
  assert.equal(findLink(null, "a"), null);
});

// ---- the store: events, outcome validation, persistence

test("TaskSessionLinks: record → setSession → setOutcome fire in that order with the same record; repeats are silent", () => {
  const ws = fakeWorkspaceState();
  const subscriptions = [];
  const store = new TaskSessionLinks({ workspaceState: ws, subscriptions });
  assert.equal(subscriptions.length, 1, "the emitter is disposed with the extension");
  const events = [];
  store.onDidChange((e) => events.push(e));

  const rec = store.record({ feature: "foo", dir: DIR, taskIds: ["2.1"] });
  assert.match(rec.id, /^[0-9a-f-]{36}$/);
  assert.equal(rec.sessionId, null, "the gateway has not named the session yet");
  assert.ok(Math.abs(rec.startedAt - Date.now()) < 5000, "startedAt defaults to now");
  assert.equal(store.get(rec.id), rec, "the stored record is the returned object");

  assert.equal(store.setSession(rec.id, "sess-1"), rec);
  assert.equal(rec.sessionId, "sess-1");
  assert.equal(store.setSession(rec.id, "sess-1"), rec, "same session again: no event");
  assert.equal(store.setSession(rec.id, ""), rec, "an empty session id is ignored");
  assert.equal(store.setSession(rec.id, 7), rec, "a non-string session id is ignored");
  assert.equal(rec.sessionId, "sess-1");
  assert.equal(store.setSession("unknown", "sess-9"), null);

  assert.equal(store.setOutcome("sess-1", "error"), rec, "the outcome arrives by session id once the turn ends");
  assert.equal(rec.outcome, "error");
  assert.equal(store.setOutcome("sess-1", "error"), rec, "same outcome again: no event");
  assert.equal(store.setOutcome("unknown", "ok"), null, "an unknown ref is a no-op, not an error");

  assert.deepEqual(events.map((e) => e.kind), ["record", "session", "outcome"]);
  assert.ok(events.every((e) => e.link === rec), "every event carries the record itself");
  assert.deepEqual(ws.writes.map((w) => w.key), [TASK_SESSION_LINKS_KEY, TASK_SESSION_LINKS_KEY, TASK_SESSION_LINKS_KEY], "every write persists");
  assert.deepEqual(ws.store.get(TASK_SESSION_LINKS_KEY), [rec]);
  assert.notEqual(ws.store.get(TASK_SESSION_LINKS_KEY)[0], rec, "a copy is persisted, not the live record");
});

test("TaskSessionLinks.setOutcome accepts exactly ok | error | stopped and throws on anything else before touching state", () => {
  const store = new TaskSessionLinks(null, { initial: [link("a", 1, { sessionId: "s" })] });
  const events = [];
  store.onDidChange((e) => events.push(e));
  for (const outcome of LINK_OUTCOMES) assert.equal(store.setOutcome("a", outcome).outcome, outcome);
  for (const bad of ["done", "OK", "", null, undefined, 1]) {
    assert.throws(() => store.setOutcome("a", bad), /unknown task run outcome/, "rejected: " + String(bad));
  }
  assert.throws(() => store.setOutcome("unknown-ref", "exploded"), /unknown task run outcome/, "the outcome is checked before the ref");
  assert.equal(store.get("a").outcome, "stopped");
  assert.deepEqual(events.map((e) => e.kind), ["outcome", "outcome", "outcome"]);
  assert.throws(() => store.record({ taskIds: ["1"] }), /needs a feature/);
  assert.throws(() => store.record(null), /needs a feature/);
});

test("TaskSessionLinks: latestForTask, latestForFeature, forSession, get and all answer over the live array; all() is a copy", () => {
  const store = new TaskSessionLinks(null, { initial: LINKS });
  assert.equal(store.latestForTask("foo", "2", DIR).id, "b");
  assert.equal(store.latestForTask("foo", "9", DIR), null);
  assert.equal(store.latestForFeature("foo", DIR).id, "d");
  assert.equal(store.latestForFeature("foo").id, "f");
  assert.deepEqual(store.forSession("s-a").map((l) => l.id), ["a"]);
  assert.deepEqual(store.forSession("none"), []);
  assert.equal(store.get("s-c").id, "c");
  assert.equal(store.get("nope"), null);
  assert.deepEqual(store.all().map((l) => l.id), ["e", "a", "c", "b", "d", "f"], "oldest first after the constructor's prune");
  store.all().length = 0;
  assert.equal(store.all().length, 6, "mutating the copy does not touch the store");
  // A store with no context and no initial array starts empty and still works.
  const empty = new TaskSessionLinks(null);
  assert.deepEqual(empty.all(), []);
  const rec = empty.record({ feature: "foo", taskIds: ["1"], sessionId: "s" });
  assert.equal(empty.latestForTask("foo", "1"), rec);
  // A tracked run with several records on one session.
  const multi = new TaskSessionLinks(null, { initial: [link("p", 1, { sessionId: "same" }), link("q", 2, { sessionId: "same" })] });
  assert.deepEqual(multi.forSession("same").map((l) => l.id), ["p", "q"]);
  assert.equal(multi.setOutcome("same", "ok").id, "q", "a session ref resolves to the session's newest record");
  assert.equal(multi.get("p").outcome, undefined);
});

test("TaskSessionLinks persists through workspaceState and prunes to 200 on write and on reload", () => {
  const ws = fakeWorkspaceState();
  const store = new TaskSessionLinks({ workspaceState: ws });
  for (let i = 0; i < 205; i++) store.record({ feature: "foo", dir: DIR, taskIds: [String(i)], sessionId: "s" + i, startedAt: 1000 + i });
  assert.equal(store.all().length, 200, "the live array never exceeds the cap");
  assert.equal(store.latestForTask("foo", "0", DIR), null, "the five oldest were dropped");
  assert.equal(store.latestForTask("foo", "5", DIR).sessionId, "s5", "the 200th most recent survives");
  assert.equal(store.latestForTask("foo", "204", DIR).sessionId, "s204");
  const persisted = ws.store.get(TASK_SESSION_LINKS_KEY);
  assert.equal(persisted.length, 200, "the persisted array is the pruned one");
  assert.deepEqual(persisted.map((l) => l.startedAt), Array.from({ length: 200 }, (_, i) => 1005 + i));

  // Reload from the same workspace state: identical content, nothing re-written on construction.
  const writesBefore = ws.writes.length;
  const reloaded = new TaskSessionLinks({ workspaceState: ws });
  assert.equal(ws.writes.length, writesBefore, "the constructor only reads");
  assert.deepEqual(reloaded.all(), store.all());
  assert.equal(reloaded.latestForFeature("foo", DIR).sessionId, "s204");

  // An over-long or dirty array written by an older build is pruned and cleaned on reload.
  const dirty = Array.from({ length: 260 }, (_, i) => link("o" + i, i)).concat([null, "junk", { feature: "" }, { feature: "bar", taskIds: ["z"], sessionId: "sz", startedAt: 999 }]);
  const stale = new TaskSessionLinks({ workspaceState: fakeWorkspaceState({ [TASK_SESSION_LINKS_KEY]: dirty }) });
  assert.equal(stale.all().length, 200);
  assert.equal(stale.all()[0].id, "o61", "261 usable records (260 old + bar): the 61 oldest are gone");
  assert.equal(stale.latestForFeature("bar").sessionId, "sz", "the usable foreign record was kept");
  assert.deepEqual(stale.all().slice(-2).map((l) => l.sessionId), ["s-o259", "sz"], "bar (startedAt 999) is the newest of all");
  // A smaller cap is honoured.
  const small = new TaskSessionLinks({ workspaceState: fakeWorkspaceState({ [TASK_SESSION_LINKS_KEY]: dirty }) }, { max: 3 });
  assert.deepEqual(small.all().map((l) => l.sessionId), ["s-o258", "s-o259", "sz"]);
  small.record({ feature: "foo", startedAt: 5000 });
  assert.deepEqual(small.all().map((l) => l.startedAt), [259, 999, 5000]);
  // A custom key is read and written.
  const ws2 = fakeWorkspaceState({ other: [link("k", 1)] });
  const keyed = new TaskSessionLinks({ workspaceState: ws2 }, { key: "other" });
  assert.equal(keyed.get("k").id, "k");
  keyed.record({ feature: "foo" });
  assert.deepEqual(ws2.writes.map((w) => w.key), ["other"]);
});

test("TaskSessionLinks: a rejected workspaceState.update is logged, not thrown, and the in-memory array still changes", async () => {
  const ws = { get: () => undefined, update: () => Promise.reject(new Error("disk full")) };
  const store = new TaskSessionLinks({ workspaceState: ws });
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const rec = store.record({ feature: "foo", taskIds: ["1"] });
    assert.equal(store.all().length, 1);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(lines.some((l) => /task session links: disk full/.test(l)), "the rejection is logged");
    assert.equal(store.get(rec.id), rec);
  } finally { console.log = original; }
  // A synchronous update (older hosts) is fine too.
  const sync = new TaskSessionLinks({ workspaceState: { get: () => undefined, update: () => undefined } });
  assert.doesNotThrow(() => sync.record({ feature: "foo" }));
});

// ---- resolveViewSessionLink: cases complementary to spec_model.test.mjs

test("resolveViewSessionLink: an older run of the task with a session beats a newer run of the same task without one", () => {
  const links = [
    link("old", 100, { taskIds: ["2"], sessionId: "s-old" }),
    link("new", 200, { taskIds: ["2"], sessionId: null }),
    link("other", 150, { taskIds: ["3"], sessionId: "s-other" }),
  ];
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir: DIR, taskId: "2" }).id, "old", "the task's own history is preferred over the feature fallback");
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir: DIR, taskId: null }).id, "other", "a spec row: the feature's newest record with a session");
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir: DIR, taskId: "9" }).id, "other", "a task that never ran: the same fallback");
});

test("resolveViewSessionLink: ties by position, dir unknown on either side, and a live store", () => {
  const ties = [link("p", 7, { taskIds: ["1"] }), link("q", 7, { taskIds: ["1"] })];
  assert.equal(resolveViewSessionLink(ties, { feature: "foo", dir: DIR, taskId: "1" }).id, "q", "equal startedAt: the later record is the newer");
  const dirless = [link("n", 1, { dir: null, taskIds: ["1"] }), link("m", 2, { dir: "/elsewhere/.kiro/specs/foo", taskIds: ["1"] })];
  assert.equal(resolveViewSessionLink(dirless, { feature: "foo", dir: DIR, taskId: "1" }).id, "n", "a record without a dir matches any target dir; the other checkout's does not");
  assert.equal(resolveViewSessionLink(dirless, { feature: "foo", dir: null, taskId: "1" }).id, "m", "a target without a dir accepts every record of the name");
  // Only records with a session count, even when every record lacks one.
  assert.equal(resolveViewSessionLink([link("x", 1, { sessionId: null, taskIds: ["1"] })], { feature: "foo", dir: DIR, taskId: "1" }), null);
  // Target shapes that name no feature.
  assert.equal(resolveViewSessionLink(ties, {}), null);
  assert.equal(resolveViewSessionLink(ties, { feature: "" }), null);
  assert.equal(resolveViewSessionLink(ties, { feature: 3 }), null);
  // The store answers like the array, and follows the gateway naming the session later.
  const store = new TaskSessionLinks(null);
  const rec = store.record({ feature: "foo", dir: DIR, taskIds: ["4"], startedAt: 10 });
  assert.equal(resolveViewSessionLink(store, { feature: "foo", dir: DIR, taskId: "4" }), null, "no session yet: nothing to open");
  store.setSession(rec.id, "s-late");
  assert.equal(resolveViewSessionLink(store, { feature: "foo", dir: DIR, taskId: "4" }).sessionId, "s-late");
  assert.equal(resolveViewSessionLink({ all: "not a function" }, { feature: "foo", dir: DIR, taskId: "4" }), null, "something neither array nor store has no links");
  assert.equal(resolveViewSessionLink(null, { feature: "foo" }), null);
});
