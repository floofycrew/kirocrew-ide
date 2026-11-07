// node --test: the engine-host highlighter behind the chat's command tip (preview/highlight.js).
// The theme resolution runs on fakes; the tokenizer itself runs against a real engine install
// when one is present on this machine (the mod's data dir, or KIDE_ENGINE_ROOT) and is skipped otherwise.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const hl = require(path.join(here, "..", "preview", "highlight.js"));

/** A read-only fs over a {path: text} map. */
const fakeFs = (files) => ({ readFileSync: (p) => { if (!(p in files)) { const e = new Error("ENOENT " + p); e.code = "ENOENT"; throw e; } return files[p]; } });
/** The slice of the vscode API resolveTheme reads. */
function fakeVscode({ theme, kind = 2, extensions = [], custom }) {
  return {
    workspace: { getConfiguration: (section) => ({ get: (key) => (section === "workbench" && key === "colorTheme" ? theme : section === "editor" && key === "tokenColorCustomizations" ? custom : undefined) }) },
    window: { activeColorTheme: { kind } },
    extensions: { all: extensions },
  };
}

test("parseJsonc reads theme files as VS Code does: comments and trailing commas", () => {
  assert.deepEqual(hl.parseJsonc('\uFEFF{\n  // a comment\n  "a": [1, 2,], /* block */ "b": "x // not a comment",\n}'), { a: [1, 2], b: "x // not a comment" });
});

test("parsePlist reads a .tmTheme's settings", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>name</key><string>Old &amp; Grey</string><key>settings</key><array>
  <dict><key>settings</key><dict><key>foreground</key><string>#AAAAAA</string></dict></dict>
  <dict><key>name</key><string>Strings</string><key>scope</key><string>string, string.quoted</string><key>settings</key><dict><key>foreground</key><string>#CE9178</string><key>fontStyle</key><string>italic</string></dict></dict>
</array></dict></plist>`;
  const plist = hl.parsePlist(xml);
  assert.equal(plist.name, "Old & Grey");
  assert.deepEqual(plist.settings, [{ settings: { foreground: "#AAAAAA" } }, { name: "Strings", scope: "string, string.quoted", settings: { foreground: "#CE9178", fontStyle: "italic" } }]);
});

test("loadThemeFile follows the include chain (base rules first), merges colors, reads a tmTheme tokenColors path", () => {
  const files = {
    "/t/dark_modern.json": '{ "include": "./dark_plus.json", "colors": { "editor.foreground": "#CCCCCC" }, "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#6A9955" } } ] }',
    "/t/dark_plus.json": '{ "include": "./dark_vs.json", "tokenColors": [ { "scope": ["entity.name.function"], "settings": { "foreground": "#DCDCAA" } }, ] }',
    "/t/dark_vs.json": '{ "colors": { "editor.foreground": "#D4D4D4", "editor.background": "#1E1E1E" }, "tokenColors": [ { "settings": { "foreground": "#D4D4D4" } }, { "scope": "string", "settings": { "foreground": "#CE9178" } } ] }',
    "/t/old.json": '{ "tokenColors": "./old.tmTheme" }',
    "/t/old.tmTheme": '<plist><dict><key>settings</key><array><dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#A31515</string></dict></dict></array></dict></plist>',
  };
  const io = { fs: fakeFs(files), path };
  const t = hl.loadThemeFile("/t/dark_modern.json", io);
  assert.deepEqual(t.rules.map((r) => r.scope || "(default)"), ["(default)", "string", ["entity.name.function"], "comment"], "the base theme's rules precede the including theme's, so the latter wins ties");
  assert.deepEqual(t.colors, { "editor.foreground": "#CCCCCC", "editor.background": "#1E1E1E" }, "colors merge with the including theme on top");
  assert.deepEqual(hl.loadThemeFile("/t/old.json", io).rules, [{ scope: "string", settings: { foreground: "#A31515" } }], "a tmTheme path yields its settings as rules");
});

test("editor.tokenColorCustomizations: the named groups, textMateRules, and [Theme] sections (wildcards too)", () => {
  assert.ok(hl.themeKeyMatches("[Dark Modern]", ["Default Dark Modern", "Dark Modern"]));
  assert.ok(hl.themeKeyMatches("[Dark*]", ["Default Dark Modern", "Dark Modern"]));
  assert.ok(hl.themeKeyMatches("[Monokai][Dark Modern]", ["Dark Modern"]));
  assert.ok(!hl.themeKeyMatches("[Light Modern]", ["Default Dark Modern", "Dark Modern"]));
  assert.ok(!hl.themeKeyMatches("textMateRules", ["Dark Modern"]));
  const rules = hl.customizationRules({
    strings: "#FF0000",
    functions: { foreground: "#00FF00", fontStyle: "bold" },
    textMateRules: [{ scope: "comment", settings: { fontStyle: "italic" } }, { scope: "junk" }],
    "[Dark Modern]": { comments: "#00AA00" },
    "[Light*]": { comments: "#AA0000" },
  }, ["Default Dark Modern", "Dark Modern"]);
  assert.deepEqual(rules, [
    { scope: hl.TOKEN_GROUPS.strings, settings: { foreground: "#FF0000" } },
    { scope: hl.TOKEN_GROUPS.functions, settings: { foreground: "#00FF00", fontStyle: "bold" } },
    { scope: "comment", settings: { fontStyle: "italic" } },
    { scope: hl.TOKEN_GROUPS.comments, settings: { foreground: "#00AA00" } },
  ], "groups then textMateRules (a rule without settings dropped), the matching theme section last; the light section ignored");
  assert.deepEqual(hl.customizationRules(undefined, ["x"]), []);
});

test("resolveTheme finds the workbench's theme by id, by label (nls-resolved), or falls back to the stock theme of the kind", () => {
  const files = {
    "/ext/defaults/themes/dark_modern.json": '{ "colors": { "editor.foreground": "#CCCCCC" }, "tokenColors": [ { "scope": "string", "settings": { "foreground": "#CE9178" } } ] }',
    "/ext/defaults/themes/light_modern.json": '{ "colors": { "editor.foreground": "#3B3B3B" }, "tokenColors": [ { "scope": "string", "settings": { "foreground": "#A31515" } } ] }',
    "/ext/defaults/package.nls.json": '{ "darkModernThemeLabel": "Dark Modern", "lightModernThemeLabel": "Light Modern" }',
    "/ext/nord/themes/nord.json": '{ "tokenColors": [ { "scope": "string", "settings": { "foreground": "#A3BE8C" } } ] }',
  };
  const extensions = [
    { extensionPath: "/ext/defaults", packageJSON: { contributes: { themes: [
      { id: "Default Dark Modern", label: "%darkModernThemeLabel%", uiTheme: "vs-dark", path: "./themes/dark_modern.json" },
      { id: "Default Light Modern", label: "%lightModernThemeLabel%", uiTheme: "vs", path: "./themes/light_modern.json" },
    ] } } },
    { extensionPath: "/ext/nord", packageJSON: { contributes: { themes: [{ label: "Nord", uiTheme: "vs-dark", path: "./themes/nord.json" }] } } },
    { extensionPath: "/ext/none", packageJSON: { contributes: {} } },
  ];
  const io = { fs: fakeFs(files), path, roots: ["/ext-root"] };  // a root without an extensions/ folder is skipped
  const dark = hl.resolveTheme(fakeVscode({ theme: "Default Dark Modern", extensions, custom: { strings: "#123456" } }), io);
  assert.equal(dark.name, "Default Dark Modern");
  assert.deepEqual(dark.settings, [{ settings: { foreground: "#CCCCCC" } }, { scope: "string", settings: { foreground: "#CE9178" } }, { scope: hl.TOKEN_GROUPS.strings, settings: { foreground: "#123456" } }], "editor.foreground as the default rule, the theme's rules, the customizations last");
  assert.ok(dark.key.includes("#123456"), "the key covers the customizations, so a change re-reads the theme");
  const byLabel = hl.resolveTheme(fakeVscode({ theme: "Dark Modern", extensions }), io);
  assert.equal(byLabel.name, "Default Dark Modern", "an nls-placeholder label resolves through package.nls.json");
  const nord = hl.resolveTheme(fakeVscode({ theme: "Nord", extensions }), io);
  assert.equal(nord.name, "Nord");
  assert.deepEqual(nord.settings[0], { settings: { foreground: hl.DEFAULT_FOREGROUND[2] } }, "a theme without editor.foreground gets the kind's default");
  const missing = hl.resolveTheme(fakeVscode({ theme: "Not Installed", kind: 1, extensions }), io);
  assert.equal(missing.name, "Default Light Modern", "an unknown name falls back to the stock theme of the active kind, as the workbench shows");
  assert.throws(() => hl.resolveTheme(fakeVscode({ theme: "x", extensions: [] }), io), /no colour theme/);
});

test("ShellHighlighter reports the reason when the engine's modules are not where it looks", async () => {
  const io = { fs, path, roots: ["/nonexistent/engine", undefined] };
  const lines = [];
  const h = new hl.ShellHighlighter(fakeVscode({ theme: "x" }), io, (l) => lines.push(l));
  const r = await h.highlight("ls");
  assert.equal(r.lines, null);
  assert.match(r.error, /vscode-textmate and vscode-oniguruma not found under \/nonexistent\/engine\/node_modules/);
  assert.equal(lines.length, 1);
  assert.equal((await h.highlight("ls")).error, r.error, "the failure sticks (no retry storm) until a reset");
});

// ---- the real tokenizer, against a real engine install
function engineRoot() {
  if (process.env.KIDE_ENGINE_ROOT) return process.env.KIDE_ENGINE_ROOT;
  const engines = path.join(os.homedir(), ".kiro", "crew", "floofy", "mods", "kirocrew-ide", ".floofy", "engines");
  try {
    return fs.readdirSync(engines).map((n) => path.join(engines, n)).filter((p) => fs.existsSync(path.join(p, "node_modules", "vscode-textmate")) && fs.existsSync(path.join(p, "extensions", "shellscript"))).sort().pop() || null;
  } catch { return null; }
}
const ROOT = engineRoot();
/** The engine's built-in extensions as vscode.extensions.all would list them. */
function engineExtensions(root) {
  const dir = path.join(root, "extensions");
  return fs.readdirSync(dir).map((n) => path.join(dir, n)).filter((p) => fs.existsSync(path.join(p, "package.json"))).map((p) => ({ extensionPath: p, packageJSON: JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")) }));
}
const runsText = (line, runs) => runs.map((r) => [line.slice(r.s, r.e), r.c, r.f]);

test("against the engine: a command is coloured with the engine's grammar and the active theme's rules", { skip: ROOT ? false : "no openvscode-server install on this machine" }, async () => {
  // extensions.all is left EMPTY here: the built-ins must be found under the app root's extensions/ (a server's remote host does not list the declarative ones)
  const extensions = [];
  assert.ok(hl.knownExtensions(fakeVscode({ theme: "", extensions }), { fs, path, roots: [ROOT] }).some((e) => e.packageJSON.name === "shellscript"), "the shellscript built-in is found under the app root");
  assert.equal(hl.knownExtensions(fakeVscode({ theme: "", extensions: engineExtensions(ROOT) }), { fs, path, roots: [ROOT] }).filter((e) => e.packageJSON.name === "shellscript").length, 1, "an extension listed by the host and found on disk counts once");
  let theme = "Default Dark Modern", custom;
  const vscode = fakeVscode({ theme: "", extensions });
  vscode.workspace.getConfiguration = (section) => ({ get: (key) => (section === "workbench" && key === "colorTheme" ? theme : section === "editor" && key === "tokenColorCustomizations" ? custom : undefined) });
  const logs = [];
  const h = new hl.ShellHighlighter(vscode, { fs, path, roots: [ROOT] }, (l) => logs.push(l));
  const line = 'git status --short && echo "x $HOME" 2>/dev/null | head -1 # done';
  const r = await h.highlight(line);
  assert.equal(r.theme, "Default Dark Modern");
  assert.equal(r.root, ROOT);
  assert.equal(r.lines.length, 1);
  const runs = runsText(line, r.lines[0]);
  const colourOf = (text) => { const hit = runs.find((x) => x[0] === text); assert.ok(hit, "a run for " + JSON.stringify(text) + " in " + JSON.stringify(runs)); return hit[1]; };
  assert.equal(colourOf("git"), "#DCDCAA", "Dark Modern's function colour for the command name");
  assert.equal(colourOf("status"), "#CE9178", "an unquoted argument is a string to the shellscript grammar");
  assert.equal(colourOf("--short"), "#569CD6", "an option");
  assert.equal(colourOf("$HOME"), "#9CDCFE", "a variable inside the double-quoted string");
  assert.equal(colourOf("# done"), "#6A9955", "a comment");
  assert.equal(colourOf(" && "), "", "the default foreground is left to the tip's text colour");
  assert.ok(runs.every((x) => x[2] === 0), "no font style in Dark Modern");
  assert.ok(logs.some((l) => /vscode-textmate from/.test(l)) && logs.some((l) => /theme Default Dark Modern/.test(l)), logs.join("\n"));
  // The user's customizations apply, and a change of them (or of the theme) is picked up on the next call.
  custom = { functions: { foreground: "#FF00FF", fontStyle: "italic bold" } };
  const r2 = await h.highlight(line);
  const git = runsText(line, r2.lines[0]).find((x) => x[0] === "git");
  assert.deepEqual(git, ["git", "#FF00FF", 3], "editor.tokenColorCustomizations.functions recolours the command name; italic|bold = 1|2");
  custom = undefined;
  theme = "Default Light Modern";
  const r3 = await h.highlight(line);
  assert.equal(r3.theme, "Default Light Modern");
  assert.equal(runsText(line, r3.lines[0]).find((x) => x[0] === "git")[1], "#795E26", "Light Modern's function colour");
  // Several lines share one rule stack: a heredoc body is a string on its own line.
  theme = "Default Dark Modern";
  const multi = "cat <<'EOF' > out.txt\nhello $HOME\nEOF";
  const m = await h.highlight(multi);
  assert.equal(m.lines.length, 3);
  assert.equal(runsText("hello $HOME", m.lines[1])[0][1], "#CE9178", "the heredoc body line is coloured as a string: the stack carried over from line 1");
  // The cache: the same text comes back as the same object until the theme moves.
  assert.equal(await h.highlight(multi).then((x) => x.lines), m.lines);
  h.resetTheme();
  assert.notEqual(await h.highlight(multi).then((x) => x.lines), m.lines);
});
