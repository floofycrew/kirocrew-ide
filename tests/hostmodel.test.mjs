// node --test: the crew-switching protocol the overlay speaks to the desktop window.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { HostModelStore, clickLocalChip, entriesFor, isEmbedded, localEntries, parseHostModel, switchTo } =
  await import(pathToFileURL(path.join(here, "..", "spa", "hostmodel.mjs")).href);

/** A window stand-in: a parent that records posts, timers that fire on demand, message listeners. */
function fakeWindow({ embedded = true } = {}) {
  const posted = [];
  const listeners = new Set();
  const timers = [];
  const win = {
    posted,
    timers,
    addEventListener: (type, fn) => { if (type === "message") listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === "message") listeners.delete(fn); },
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms, live: true }); return id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
    // Fire the earliest live timer only (real timers are spaced; the retries are bounded, not simultaneous).
    fire: () => { const next = timers.filter((t) => t.live).sort((a, b) => a.ms - b.ms)[0]; if (!next) return; next.live = false; next.fn(); },
    deliver: (data, source) => { for (const fn of [...listeners]) fn({ data, source }); },
    listenerCount: () => listeners.size,
  };
  win.parent = embedded ? { postMessage: (msg, origin) => posted.push({ msg, origin }) } : win;
  win.self = win;
  win.top = embedded ? win.parent : win;
  return win;
}

const MODEL = {
  type: "mc-host-model", v: 1, activeId: "crew-a", macInset: true,
  tabs: [
    { id: "crew-a", name: "desk", sshHost: "dev-dsk-a", state: "connected", unread: 0 },
    { id: "crew-b", name: "sandbox", sshHost: "sandbox", state: "connecting", unread: "3" },
    { id: "", name: "dropped" },
    "junk",
  ],
};

test("isEmbedded: a frame whose top differs, or throws, is embedded", () => {
  assert.equal(isEmbedded(fakeWindow({ embedded: true })), true);
  assert.equal(isEmbedded(fakeWindow({ embedded: false })), false);
  assert.equal(isEmbedded({ self: 1, get top() { throw new Error("cross-origin"); } }), true);
});

test("parseHostModel narrows the payload and drops malformed tabs", () => {
  const m = parseHostModel(MODEL);
  assert.deepEqual(m.tabs.map((t) => [t.id, t.name, t.sshHost, t.state, t.unread]), [
    ["crew-a", "desk", "dev-dsk-a", "connected", 0],
    ["crew-b", "sandbox", "sandbox", "connecting", 3],
  ]);
  assert.equal(m.activeId, "crew-a");
  assert.equal(parseHostModel({ type: "mc-embedded-ack" }), null);
  assert.equal(parseHostModel(null), null);
  assert.equal(parseHostModel({ type: "mc-host-model", activeId: 7 }).activeId, null);
});

test("entriesFor puts Local first and hides a detail equal to the name", () => {
  const rows = entriesFor(parseHostModel(MODEL));
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.detail]), [
    [null, "Local", "Local dashboard"], ["crew-a", "desk", "dev-dsk-a"], ["crew-b", "sandbox", ""],
  ]);
  assert.deepEqual(entriesFor(null).map((r) => r.id), [null]);
});

test("the store asks the parent with the pane's handshake, accepts only the parent's model, stops asking once it lands", () => {
  const win = fakeWindow();
  const store = new HostModelStore(win);
  const seen = [];
  const off = store.subscribe((m) => seen.push(m));
  assert.deepEqual(seen, [null], "first call reports the (empty) current model");
  win.fire();
  assert.equal(win.posted.length, 1);
  assert.deepEqual(win.posted[0], { msg: { type: "mc-embedded-ready", v: 1 }, origin: "*" });
  // A model from some other frame is ignored; the parent's is stored and fanned out.
  win.deliver(MODEL, {});
  assert.equal(seen.length, 1);
  win.deliver(MODEL, win.parent);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].activeId, "crew-a");
  // Pending retries are cancelled once a model arrived.
  assert.equal(win.timers.filter((t) => t.live).length, 0);
  win.fire();
  assert.equal(win.posted.length, 1, "no further asks after the model landed");
  // A later subscriber gets the cached model immediately; the last unsubscribe disarms the listener.
  const late = [];
  const off2 = store.subscribe((m) => late.push(m));
  assert.equal(late[0].activeId, "crew-a");
  off();
  assert.equal(win.listenerCount(), 1);
  off2();
  assert.equal(win.listenerCount(), 0);
});

test("the store never asks when there is no parent", () => {
  const win = fakeWindow({ embedded: false });
  const store = new HostModelStore(win);
  store.subscribe(() => undefined);
  win.fire();
  assert.equal(win.posted.length, 0);
});

test("switchTo posts the pane's own switch request; Local is null; false without a parent", () => {
  const win = fakeWindow();
  assert.equal(switchTo("crew-b", win), true);
  assert.equal(switchTo(null, win), true);
  assert.deepEqual(win.posted.map((p) => p.msg), [
    { type: "mc-switch-instance", v: 1, id: "crew-b" },
    { type: "mc-switch-instance", v: 1, id: null },
  ]);
  assert.equal(switchTo("crew-b", fakeWindow({ embedded: false })), false);
});

/** A document stand-in holding KiroCrew's chip row. */
/** KiroCrew's switcher group: the leading active chip, the pinned row, the dropdown trigger — as upstream lays it out. */
function docWithChips(chips) {
  const buttons = chips.map((c) => ({
    clicked: 0,
    attrs: c,
    id: c.id || "",
    getAttribute(name) { return name in c ? c[name] : null; },
    hasAttribute(name) { return name in c; },
    closest: () => null,
    textContent: c.text || "",
    click() { this.clicked += 1; },
  }));
  const group = { querySelectorAll: () => buttons };
  const row = { parentElement: group, querySelectorAll: () => buttons.filter((b) => b.attrs.inRow) };
  return {
    buttons,
    querySelector: (sel) => (sel === '[data-testid="crew-chip-row"]' ? row : null),
  };
}

test("localEntries reads the whole switcher group (leading chip + pinned row), skipping the trigger and our tag; clickLocalChip clicks by name", () => {
  const doc = docWithChips([
    { "aria-label": "desk (dev-dsk-a) — connected", "aria-current": "true" },
    { "aria-label": "dev-dsk-a IDE — the workbench", id: "kirocrew-ide-chip" },
    { "aria-label": "Local dashboard", text: "Local", inRow: true },
    { "aria-label": "sandbox (sandbox) — error", inRow: true },
    { "aria-label": "Switch crew", "aria-haspopup": "menu" },
  ]);
  const rows = localEntries(doc);
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.detail, r.state, r.active]), [
    [null, "Local dashboard", "Local dashboard", undefined, false],
    ["desk", "desk", "dev-dsk-a", "connected", true],
    ["sandbox", "sandbox", "sandbox", "error", false],
  ]);
  assert.equal(clickLocalChip("sandbox", doc), true);
  assert.equal(doc.buttons[3].clicked, 1);
  assert.equal(clickLocalChip("nowhere", doc), false);
  assert.deepEqual(localEntries({ querySelector: () => null }), []);
});
