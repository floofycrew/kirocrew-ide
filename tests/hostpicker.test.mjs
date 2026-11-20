// The host-picker loader: KiroCrew 0.13+'s App SDK `ProjectPicker` first (gated
// behind the listing paths app.json declares; the layer renders it under the
// mod's own app scope), else the ≤ 0.12 ProjectPicker chunk found through the
// document's modulepreload link (no hash hardcoded); null (never a rejection)
// on a dashboard with neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, HOST_PICKER_RAISE_CSS, HOST_PICKER_SELECTOR, SDK_PICKER_PATHS, hostModules, hostPickerUrl, hostReact, loadHostPicker, mountHostPicker, sdkPicker } from "../spa/hostpicker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function docWith(links) {
  return {
    querySelector(sel) {
      if (!sel.includes("ProjectPicker-")) return null;
      const href = links.find((l) => l.includes("/assets/ProjectPicker-"));
      return href ? { getAttribute: () => href } : null;
    },
  };
}
/** The slice of a 0.13 host's module registry the loader reads: react + the App SDK with its level-7 exports. */
function sdkWin({ withPicker = true, withProvider = true } = {}) {
  const React = { createElement: (C, props, ...children) => ({ C, props, children }) };
  const sdk = {};
  if (withPicker) sdk.ProjectPicker = function ProjectPicker() { return null; };
  if (withProvider) sdk.AppApiProvider = function AppApiProvider() { return null; };
  return { __kirocrew_modules: { react: React, "react-dom": { createRoot() {} }, "@kirocrew/app-sdk": sdk } };
}

test("the chunk URL comes from the dashboard's own modulepreload link (≤ 0.12)", () => {
  assert.equal(hostPickerUrl(docWith(["/assets/App-abc.js", "/assets/ProjectPicker-DsiqSdyz.js"])), "/assets/ProjectPicker-DsiqSdyz.js");
  assert.equal(hostPickerUrl(docWith(["/assets/App-abc.js"])), null);
  assert.equal(hostPickerUrl(null), null);
});

test("sdkPicker: the App SDK's ProjectPicker, bare for an App render, scoped under the mod's app name for the layer", () => {
  const win = sdkWin();
  const mods = win.__kirocrew_modules;
  assert.equal(sdkPicker(mods), mods["@kirocrew/app-sdk"].ProjectPicker, "unscoped: the SDK component itself (the App Kit supplies the scope)");
  const Scoped = sdkPicker(mods, { scoped: true });
  assert.equal(typeof Scoped, "function");
  const props = { open: true, anchorRect: { top: 1 }, onOpenChange() {}, onSelect() {} };
  const tree = Scoped(props);
  assert.equal(tree.C, mods["@kirocrew/app-sdk"].AppApiProvider, "wrapped in the SDK's own AppApiProvider");
  assert.equal(tree.props.appName, APP_NAME);
  assert.deepEqual(tree.props.allowedApiPaths, [...SDK_PICKER_PATHS], "declares exactly the four listing paths the picker reads");
  assert.equal(tree.children[0].C, mods["@kirocrew/app-sdk"].ProjectPicker);
  assert.equal(tree.children[0].props, props, "the picker gets the caller's props untouched");
  assert.equal(sdkPicker(sdkWin({ withPicker: false }).__kirocrew_modules), null, "a host below level 7 has no ProjectPicker export");
  assert.equal(sdkPicker(sdkWin({ withProvider: false }).__kirocrew_modules, { scoped: true }), null, "no provider, no scoped render");
  assert.equal(sdkPicker(null), null);
  assert.equal(sdkPicker({ react: {} }), null);
});

test("app.json declares the paths the SDK picker is gated behind, and nothing else is needed for it", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "app", "app.json"), "utf8"));
  assert.equal(manifest.name, APP_NAME);
  assert.deepEqual(manifest.permissions.api, [...SDK_PICKER_PATHS], "the App page's scope covers /api/browse-dirs, /api/browse-dirs/create, /api/recent-projects, /api/favorite-projects (KiroCrew 0.13's gate)");
});

test("hostModules waits for the dashboard's registry, then gives up", async () => {
  const timers = [];
  const setTimer = (fn, ms) => { timers.push([fn, ms]); };
  let t = 0;
  const now = () => t;
  const win = {};
  const p = hostModules(win, { waitMs: 200, setTimer, now });
  assert.equal(timers.length, 1, "polls");
  t = 60; timers.shift()[0]();
  win.__kirocrew_modules = { react: {} };
  t = 120; timers.shift()[0]();
  assert.deepEqual(await p, { react: {} }, "resolves with the registry once it appears");
  const late = hostModules({}, { waitMs: 100, setTimer, now });
  t = 1000; timers.shift()[0]();
  assert.equal(await late, null, "null past the deadline");
  assert.deepEqual(await hostModules({ __kirocrew_modules: { x: 1 } }, { waitMs: 100, setTimer }), { x: 1 }, "present at once: no wait");
});

test("loadHostPicker prefers the SDK picker (0.13+), falls back to the chunk (≤ 0.12), null with neither; once per document and scope", async () => {
  const calls = [];
  const Chunk = () => null;
  const importer = async (url) => { calls.push(url); return { t: Chunk }; };
  // 0.13: the SDK is there; the chunk link is not, and would not be consulted anyway.
  const win13 = sdkWin();
  const doc13 = docWith([]);
  const bare = await loadHostPicker(doc13, { win: win13, importer, waitMs: 0 });
  assert.equal(bare, win13.__kirocrew_modules["@kirocrew/app-sdk"].ProjectPicker);
  const scoped = await loadHostPicker(doc13, { win: win13, importer, waitMs: 0, scoped: true });
  assert.notEqual(scoped, bare, "the layer's scoped component is a different one");
  assert.equal(await loadHostPicker(doc13, { win: win13, importer, waitMs: 0, scoped: true }), scoped, "cached per document and scope");
  assert.deepEqual(calls, [], "no chunk import on a host with the SDK picker");
  // 0.12: a registry without ProjectPicker, the chunk link present.
  const win12 = { __kirocrew_modules: { react: { createElement() {} }, "react-dom": { createRoot() {} }, "@kirocrew/app-sdk": { useAppApi() {} } } };
  const doc12 = docWith(["/assets/ProjectPicker-x1.js"]);
  assert.equal(await loadHostPicker(doc12, { win: win12, importer, waitMs: 0 }), Chunk);
  assert.equal(await loadHostPicker(doc12, { win: win12, importer, waitMs: 0 }), Chunk);
  assert.deepEqual(calls, ["/assets/ProjectPicker-x1.js"], "imported once per document");
  // neither, a broken chunk, a chunk without a component
  assert.equal(await loadHostPicker(docWith([]), { win: win12, importer, waitMs: 0 }), null);
  assert.equal(await loadHostPicker(docWith(["/assets/ProjectPicker-x2.js"]), { win: win12, importer: async () => { throw new Error("404"); }, waitMs: 0 }), null, "a failed import is 'no picker', not an error");
  assert.equal(await loadHostPicker(docWith(["/assets/ProjectPicker-x3.js"]), { win: win12, importer: async () => ({ t: "not a function" }), waitMs: 0 }), null);
  // no registry at all (the probe's stub realm): the chunk route still works
  assert.equal(await loadHostPicker(docWith(["/assets/ProjectPicker-x4.js"]), { win: {}, importer, waitMs: 0 }), Chunk);
});

test("hostReact needs the host's shared react + react-dom with createRoot", () => {
  assert.equal(hostReact({}), null);
  assert.equal(hostReact({ __kirocrew_modules: { react: {} } }), null);
  const win = { __kirocrew_modules: { react: { createElement() {} }, "react-dom": { createRoot() {} } } };
  assert.ok(hostReact(win));
});

test("mountHostPicker drives the component through open/select/close", () => {
  const rendered = [];
  const React = { createElement: (C, props) => ({ C, props }) };
  let lastRoot;
  const ReactDOM = { createRoot: () => (lastRoot = { render: (tree) => rendered.push(tree), unmount() { lastRoot.unmounted = true; } }) };
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  const doc = { body, createElement: () => ({ setAttribute() {}, remove() { body.children.pop(); } }) };
  const selected = [], closed = [];
  const Picker = () => null;
  const ctl = mountHostPicker(Picker, { win: { __kirocrew_modules: { react: React, "react-dom": ReactDOM } }, doc, onSelect: (p) => selected.push(p), onClose: () => closed.push(1) });
  assert.ok(ctl && !ctl.isOpen());
  assert.equal(rendered.at(-1).props.open, false);
  ctl.open({ top: 1, bottom: 2, left: 3, right: 4 });
  assert.ok(ctl.isOpen());
  assert.deepEqual(rendered.at(-1).props.anchorRect, { top: 1, bottom: 2, left: 3, right: 4 });
  rendered.at(-1).props.onSelect("/tmp/x");
  assert.deepEqual(selected, ["/tmp/x"]);
  assert.ok(!ctl.isOpen() && rendered.at(-1).props.open === false, "a pick closes it");
  ctl.open({ top: 0 });
  rendered.at(-1).props.onOpenChange(false);
  assert.deepEqual(closed, [1], "the picker closing itself (Escape, outside click) reports onClose");
  assert.equal(mountHostPicker(Picker, { win: {}, doc }), null, "no host React: nothing mounted");
  ctl.dispose();
  assert.ok(lastRoot.unmounted && body.children.length === 0);
});

test("the raise rule targets the picker's body-level box by its stable list ids", () => {
  // Any tab of the picker: Recent, Browse and (KiroCrew 0.11) Favorites all render pp-… ids; a
  // rule naming two lists raised the box for its first paint only and let it drop behind the IDE.
  assert.equal(HOST_PICKER_SELECTOR, 'body > div:has([id^="pp-"])');
  assert.ok(HOST_PICKER_RAISE_CSS.startsWith(HOST_PICKER_SELECTOR + " {"));
  assert.match(HOST_PICKER_RAISE_CSS, /z-index: 2147483100 !important/);
  assert.doesNotMatch(HOST_PICKER_RAISE_CSS, /pp-recent-list|pp-browse-list/, "no tab-specific id");
});
