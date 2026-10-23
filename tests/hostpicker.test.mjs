// The host-picker loader: the dashboard's ProjectPicker chunk is found through
// the document's modulepreload link (no hash hardcoded), imported once per
// document, and absent (null, never a rejection) on a dashboard that lacks it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOST_PICKER_RAISE_CSS, hostPickerUrl, hostReact, loadHostPicker, mountHostPicker } from "../spa/hostpicker.mjs";

function docWith(links) {
  return {
    querySelector(sel) {
      if (!sel.includes("ProjectPicker-")) return null;
      const href = links.find((l) => l.includes("/assets/ProjectPicker-"));
      return href ? { getAttribute: () => href } : null;
    },
  };
}

test("the chunk URL comes from the dashboard's own modulepreload link", () => {
  assert.equal(hostPickerUrl(docWith(["/assets/App-abc.js", "/assets/ProjectPicker-DsiqSdyz.js"])), "/assets/ProjectPicker-DsiqSdyz.js");
  assert.equal(hostPickerUrl(docWith(["/assets/App-abc.js"])), null);
  assert.equal(hostPickerUrl(null), null);
});

test("loadHostPicker resolves the chunk's export once, and null where the dashboard has none", async () => {
  const calls = [];
  const Picker = () => null;
  const doc = docWith(["/assets/ProjectPicker-x1.js"]);
  const importer = async (url) => { calls.push(url); return { t: Picker }; };
  assert.equal(await loadHostPicker(doc, importer), Picker);
  assert.equal(await loadHostPicker(doc, importer), Picker);
  assert.deepEqual(calls, ["/assets/ProjectPicker-x1.js"], "imported once per document");
  assert.equal(await loadHostPicker(docWith([]), importer), null);
  const broken = docWith(["/assets/ProjectPicker-x2.js"]);
  assert.equal(await loadHostPicker(broken, async () => { throw new Error("404"); }), null, "a failed import is 'no picker', not an error");
  const odd = docWith(["/assets/ProjectPicker-x3.js"]);
  assert.equal(await loadHostPicker(odd, async () => ({ t: "not a function" })), null);
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
  rendered.at(-1).props.onSelect("/srv/app");
  assert.deepEqual(selected, ["/srv/app"]);
  assert.ok(!ctl.isOpen(), "a selection closes it");
  ctl.open({});
  rendered.at(-1).props.onOpenChange(false);
  assert.deepEqual(closed, [1]);
  assert.ok(!ctl.isOpen());
  ctl.dispose();
  assert.ok(lastRoot.unmounted && body.children.length === 0);
  assert.equal(mountHostPicker(Picker, { win: {}, doc }), null, "no host React: no controller");
});

test("the raise rule targets the picker's body-level box by its stable list ids", () => {
  assert.match(HOST_PICKER_RAISE_CSS, /body > div:has\(#pp-recent-list\)/);
  assert.match(HOST_PICKER_RAISE_CSS, /body > div:has\(#pp-browse-list\)/);
  assert.match(HOST_PICKER_RAISE_CSS, /z-index: 2147483100 !important/);
});
