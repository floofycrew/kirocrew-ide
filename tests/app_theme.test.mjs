// node --test: the shared workbench helpers (spa/workbench.mjs): title-bar theme read, dashboard scheme, URL decoration.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The App page imports "react" / "react-dom" through the host's import map; give node stand-ins.
const { register } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const loaderCode = `
export async function resolve(specifier, context, next) {
  if (specifier === "react" || specifier === "react-dom") return { url: "data:text/javascript,export default {createElement(){},useState(){},useRef(){},useEffect(){},useCallback(){},createPortal(){}};", shortCircuit: true };
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(loaderCode), pathToFileURL(here + "/"));
const { readWorkbenchTheme } = await import(pathToFileURL(path.join(here, "..", "spa", "workbench.mjs")).href);

/** A frame whose `.monaco-workbench` carries `vars` (as the real engine does) while <body> carries none. */
function frameWith(vars) {
  const workbench = { vars };
  const body = { vars: {}, querySelector: (sel) => (sel === ".monaco-workbench" ? workbench : null) };
  return { contentDocument: { body, defaultView: { getComputedStyle: (el) => ({ getPropertyValue: (n) => el.vars[n] || "" }) } } };
}

test("reads the variables off .monaco-workbench, not <body>", () => {
  const t = readWorkbenchTheme(frameWith({ "--vscode-titleBar-activeBackground": "#f8f8f8", "--vscode-titleBar-activeForeground": "#3b3b3b" }));
  assert.equal(t.bg, "#f8f8f8");
  assert.equal(t.fg, "#3b3b3b");
  // A document with no workbench root yet (still booting) reads body and finds nothing.
  assert.equal(readWorkbenchTheme({ contentDocument: { body: { vars: {}, querySelector: () => null }, defaultView: { getComputedStyle: (el) => ({ getPropertyValue: (n) => el.vars[n] || "" }) } } }), null);
});

test("reads command-centre colours first, title-bar colours as fallback", () => {
  const t = readWorkbenchTheme(frameWith({
    "--vscode-commandCenter-background": "#333", "--vscode-commandCenter-foreground": "#eee",
    "--vscode-commandCenter-border": "#555", "--vscode-titleBar-activeBackground": "#111",
  }));
  assert.deepEqual(t, { bg: "#333", fg: "#eee", border: "#555", hover: "#333", titleBar: "#111", accent: "#7c5cff", menuBg: "#333", menuFg: "inherit", menuBorder: "#555", menuHover: "rgba(128,128,128,.18)", menuHoverFg: "inherit", done: "#3fb950", active: "#4a9eff" });
  const fallback = readWorkbenchTheme(frameWith({ "--vscode-titleBar-activeBackground": "#202", "--vscode-titleBar-activeForeground": "#fff" }));
  assert.equal(fallback.bg, "#202");
  assert.equal(fallback.fg, "#fff");
  assert.equal(fallback.border, "transparent");
});

test("null before the workbench painted or when the frame is cross-origin", () => {
  assert.equal(readWorkbenchTheme(frameWith({})), null);
  assert.equal(readWorkbenchTheme(null), null);
  assert.equal(readWorkbenchTheme({ get contentDocument() { throw new DOMException("Blocked", "SecurityError"); } }), null);
});


test("dashboardScheme reads the host's data-mode / data-theme, withScheme attaches it once", async () => {
  const { dashboardScheme, withScheme } = await import("../spa/workbench.mjs");
  const doc = (mode, theme) => ({ documentElement: { dataset: Object.assign({}, mode ? { mode } : {}, theme ? { theme } : {}) } });
  assert.equal(dashboardScheme(doc("dark")), "dark");
  assert.equal(dashboardScheme(doc("light")), "light");
  assert.equal(dashboardScheme(doc(undefined, "ocean-dark")), "dark", "falls back to data-theme's suffix");
  assert.equal(dashboardScheme(doc(undefined, "light")), "light");
  assert.equal(withScheme("/kirocrew-ide/", "dark"), "/kirocrew-ide/?kideScheme=dark");
  assert.equal(withScheme("/kirocrew-ide/?folder=/w", "light"), "/kirocrew-ide/?folder=/w&kideScheme=light");
  assert.equal(withScheme("/kirocrew-ide/?kideScheme=dark", "light"), "/kirocrew-ide/?kideScheme=light", "replaces, never stacks");
  assert.equal(withScheme(null, "dark"), null);
});

test("the donut arcs take the theme's chart colours when it has them", () => {
  const t = readWorkbenchTheme(frameWith({ "--vscode-titleBar-activeBackground": "#111", "--vscode-charts-green": "#89d185", "--vscode-charts-blue": "#3794ff" }));
  assert.equal(t.done, "#89d185");
  assert.equal(t.active, "#3794ff");
});
