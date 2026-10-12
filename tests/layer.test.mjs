// node --test: the IDE layer's tag-stack model and the chip it adds to KiroCrew's switcher.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { APP_ROUTE, chipMarkup, stackEntries, subTagStyle } = await import(pathToFileURL(path.join(here, "..", "spa", "layer.mjs")).href);

const ENTRIES = [
  { id: null, name: "Local", detail: "Local dashboard", unread: 0 },
  { id: "crew-a", name: "desk", detail: "dev-dsk-a", state: "connected", unread: 0 },
  { id: "crew-b", name: "sandbox", detail: "", state: "error", unread: 2 },
];

test("the crew on screen is the 'here' row, the rest switch, the IDE row closes the stack", () => {
  const rows = stackEntries({ entries: ENTRIES, activeId: "crew-a", host: "dev-dsk-a" });
  assert.deepEqual(rows.map((r) => [r.kind, r.id, r.label]), [
    ["crew", null, "Local"], ["here", "crew-a", "desk"], ["crew", "crew-b", "sandbox"], ["ide", "ide", "dev-dsk-a IDE"],
  ]);
  assert.equal(rows[2].unread, 2);
  assert.equal(rows[2].state, "error");
  assert.equal(rows[0].state, "connected", "Local carries no tunnel state and is painted connected");
});

test("Local on screen makes Local the 'here' row", () => {
  const rows = stackEntries({ entries: ENTRIES, activeId: null, host: "mac" });
  assert.deepEqual(rows.map((r) => r.kind), ["here", "crew", "crew", "ide"]);
});

test("with no crews known, the host stands in for its own dashboard", () => {
  const rows = stackEntries({ entries: [], activeId: null, host: "dev-dsk-a" });
  assert.deepEqual(rows.map((r) => [r.kind, r.label]), [["here", "dev-dsk-a"], ["ide", "dev-dsk-a IDE"]]);
  // A model whose active crew is not among the entries still gets a 'here' row.
  const odd = stackEntries({ entries: ENTRIES.slice(0, 1), activeId: "crew-z", host: "z" });
  assert.deepEqual(odd.map((r) => r.kind), ["crew", "here", "ide"]);
});

test("the switcher chip wears the host's chip classes, lit when the layer is up, and escapes the host name", () => {
  const off = chipMarkup("desk", false);
  const on = chipMarkup("<b>", true);
  assert.match(off.className, /border-border text-text/);
  assert.match(on.className, /bg-accent-subtle text-accent font-bold/);
  assert.match(off.html, /desk IDE/);
  assert.match(on.html, /&lt;b&gt; IDE/);
  assert.doesNotMatch(on.html, /<b>/);
  assert.match(off.html, /^<svg/);
  assert.equal(off.style, "", "standalone: no attachment styling");
});

test("as a sub-tag the chip reads just 'IDE' and is styled to join the host's chip", () => {
  const sub = chipMarkup("desk", false, { sub: true });
  assert.match(sub.html, />IDE</);
  assert.doesNotMatch(sub.html, /desk/);
  assert.match(sub.style, /border-top-left-radius:0/);
  assert.match(sub.style, /margin-left:-4px/);
  assert.match(sub.style, /border-left-width:0/);
});


test("the joining style is shared: the row gap is what the negative margin cancels", () => {
  assert.equal(chipMarkup("desk", false, { sub: true }).style, subTagStyle(4), "KiroCrew's row is gap-1 (4px)");
  assert.match(subTagStyle(6), /margin-left:-6px/);
  assert.match(subTagStyle(6), /border-top-left-radius:0;border-bottom-left-radius:0/);
  assert.match(subTagStyle(6), /border-left-width:0/);
});

test("exitFullscreen() (API only) navigates to the App page route", () => {
  assert.equal(APP_ROUTE, "/apps/kirocrew-ide");
});
