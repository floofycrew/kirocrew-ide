// Native shell highlighting for the KiroCrew chat's command tip, served from the
// ENGINE's extension host.
//
// Why here and not in the chat: the bridge is a web extension (a browser worker:
// no file system, no node modules) and a webview is handed only the workbench
// colours as `--vscode-*` variables — never a theme's token colours, never a
// tokenizer. This host has both halves of what the editor itself uses: the
// engine's own `vscode-textmate` + `vscode-oniguruma` (the pair the workbench
// tokenizes every editor with, under its node_modules), the `source.shell`
// grammar the built-in shellscript extension contributes, and the active colour
// theme's definition on disk (its `include` chain, plus the user's
// `editor.tokenColorCustomizations`). So a command in the tip is coloured
// exactly as a .sh file is in the editor: same grammar, same theme rules, the
// theme's own default foreground left to the tip's text colour.
//
// Contract: the command `kirocrew.preview.highlight` takes `{text}` and resolves
// to `{lines: [[{s, e, c, f}]], theme, root}` — one array per line of `text`,
// each run `[s, e)` with `c` the theme colour (`""` for the default foreground)
// and `f` the font-style bits (1 italic, 2 bold, 4 underline, 8 strikethrough) —
// or `{lines: null, error}` when the engine's modules or the grammar cannot be
// loaded, so the chat keeps its own fallback colouring. Results are cached per
// text and dropped when the theme or the customizations change; the theme is
// re-read on the next call after `workbench.colorTheme` or the customizations
// move (checked by value on every call, so a reordering of the two hosts'
// change events cannot leave a stale palette behind).
"use strict";

const HIGHLIGHT_COMMAND = "kirocrew.preview.highlight";
const SHELL_SCOPE = "source.shell";
const CACHE_MAX = 200;
//: vscode.ColorThemeKind → the editor.foreground default and the stock theme the workbench falls back to.
const DEFAULT_FOREGROUND = { 1: "#333333", 2: "#BBBBBB", 3: "#FFFFFF", 4: "#292929" };
const DEFAULT_THEME = { 1: "Default Light Modern", 2: "Default Dark Modern", 3: "Default High Contrast", 4: "Default High Contrast Light" };
// vscode-textmate's encoded token metadata (encodedTokenAttributes.ts): the foreground colour id
// in bits 15–23, the font style in bits 11–14.
const FG_MASK = 0b00000000111111111000000000000000, FG_OFFSET = 15;
const FS_MASK = 0b00000000000000000111100000000000, FS_OFFSET = 11;
//: editor.tokenColorCustomizations' named groups → the scopes VS Code applies them to (colorThemeData.ts).
const TOKEN_GROUPS = {
  comments: ["comment", "punctuation.definition.comment"],
  strings: ["string", "meta.embedded.assembly"],
  keywords: ["keyword - keyword.operator", "keyword.control", "storage", "storage.type"],
  numbers: ["constant.numeric"],
  types: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
  functions: ["entity.name.function", "support.function"],
  variables: ["variable", "entity.name.variable"],
};

/** JSON with comments and trailing commas (the shape theme files and tmLanguage files come in). */
function parseJsonc(text) {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") { out += text[i + 1] || ""; i += 2; continue; }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') { inString = true; out += c; i += 1; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") { i += 1; continue; }
    }
    out += c;
    i += 1;
  }
  return JSON.parse(out.replace(/^\uFEFF/, ""));
}

/**
 * A TextMate `.tmTheme` (XML plist) as a plain value: dicts → objects, arrays → arrays,
 * strings/integers/reals/booleans → primitives. Enough for `settings[]` with `scope` and
 * `settings.foreground`/`fontStyle`; anything exotic is simply carried as text.
 */
function parsePlist(xml) {
  const tags = [...xml.matchAll(/<\/?([a-zA-Z]+)(\s[^>]*)?\/?>|[^<]+/g)].map((m) => ({ raw: m[0], tag: m[1] ? m[1].toLowerCase() : null }));
  let pos = 0;
  const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
  const text = (close) => { let s = ""; while (pos < tags.length && tags[pos].raw !== close) s += tags[pos++].raw; pos += 1; return decode(s); };
  const value = () => {
    while (pos < tags.length && (tags[pos].tag === null || tags[pos].raw.startsWith("<?") || tags[pos].raw.startsWith("<!"))) pos += 1;
    const t = tags[pos++];
    if (!t) return undefined;
    switch (t.tag) {
      case "plist": return value();
      case "dict": { const o = {}; while (pos < tags.length && tags[pos].raw !== "</dict>") { if (tags[pos].tag === "key") { pos += 1; const k = text("</key>"); o[k] = value(); } else pos += 1; } pos += 1; return o; }
      case "array": { const a = []; while (pos < tags.length && tags[pos].raw !== "</array>") { if (tags[pos].tag === null) { pos += 1; continue; } a.push(value()); } pos += 1; return a; }
      case "string": return t.raw.endsWith("/>") ? "" : text("</string>");
      case "integer": return Number(text("</integer>"));
      case "real": return Number(text("</real>"));
      case "true": return true;
      case "false": return false;
      case "date": return text("</date>");
      case "data": return text("</data>");
      default: return undefined;
    }
  };
  return value();
}

/**
 * The theme file at `file` as `{rules, colors}`: its `include` chain first (a base
 * theme's rules come before the including theme's, as the workbench orders them),
 * `tokenColors` as an array, or as a path to a .tmTheme whose `settings` are the rules.
 */
function loadThemeFile(file, io, seen = new Set()) {
  if (seen.has(file)) return { rules: [], colors: {} };
  seen.add(file);
  const doc = parseJsonc(io.fs.readFileSync(file, "utf8"));
  let rules = [], colors = {};
  if (typeof doc.include === "string" && doc.include) {
    const base = loadThemeFile(io.path.join(io.path.dirname(file), doc.include), io, seen);
    rules = base.rules;
    colors = base.colors;
  }
  if (doc.colors && typeof doc.colors === "object") colors = Object.assign({}, colors, doc.colors);
  if (Array.isArray(doc.tokenColors)) rules = rules.concat(doc.tokenColors);
  else if (typeof doc.tokenColors === "string" && doc.tokenColors) {
    const plist = parsePlist(io.fs.readFileSync(io.path.join(io.path.dirname(file), doc.tokenColors), "utf8"));
    if (plist && Array.isArray(plist.settings)) rules = rules.concat(plist.settings);
  }
  return { rules, colors };
}

/** Does a `[Theme Name]` key of editor.tokenColorCustomizations name this theme? (`*` wildcards, as the workbench matches them.) */
function themeKeyMatches(key, names) {
  const m = /^\[(.*)\]$/.exec(key);
  if (!m) return false;
  return m[1].split("][").some((pattern) => {
    const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return names.some((n) => re.test(n));
  });
}

/** editor.tokenColorCustomizations as theme rules: the named groups, then textMateRules, the theme-specific section last. */
function customizationRules(custom, names) {
  const rules = [];
  const add = (section) => {
    if (!section || typeof section !== "object") return;
    for (const [group, scopes] of Object.entries(TOKEN_GROUPS)) {
      const v = section[group];
      if (!v) continue;
      const settings = typeof v === "string" ? { foreground: v } : (v && typeof v === "object" ? v : null);
      if (settings) rules.push({ scope: scopes, settings });
    }
    if (Array.isArray(section.textMateRules)) rules.push(...section.textMateRules.filter((r) => r && typeof r === "object" && r.settings));
  };
  add(custom);
  if (custom && typeof custom === "object") for (const key of Object.keys(custom)) if (themeKeyMatches(key, names)) add(custom[key]);
  return rules;
}

/**
 * Every extension whose manifest this host can read, as `{extensionPath, packageJSON}`:
 * `vscode.extensions.all` (the ones installed on the engine, a theme the user added
 * included), then the app root's `extensions/` folder — the built-ins (shellscript,
 * theme-defaults) are declarative and a server's remote host does not always list them.
 */
function knownExtensions(vscode, io) {
  const out = [], seen = new Set();
  const add = (extensionPath, packageJSON) => { if (!extensionPath || seen.has(extensionPath) || !packageJSON) return; seen.add(extensionPath); out.push({ extensionPath, packageJSON }); };
  for (const ext of (vscode.extensions && vscode.extensions.all) || []) add(ext.extensionPath, ext.packageJSON);
  for (const root of (io.roots || []).filter(Boolean)) {
    const dir = io.path.join(root, "extensions");
    let names = [];
    try { names = io.fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const p = io.path.join(dir, name);
      try { add(p, parseJsonc(io.fs.readFileSync(io.path.join(p, "package.json"), "utf8"))); } catch { /* not an extension folder */ }
    }
  }
  return out;
}

/**
 * The colour theme the workbench is showing, as vscode-textmate wants it:
 * `{name, settings}` with the editor foreground as the default rule, the theme's
 * rules, then the user's customizations. `vscode.extensions.all` lists the theme
 * extensions this host knows (:func:`knownExtensions`: the ones installed on the
 * engine and the built-in defaults under the app root); the setting `workbench.colorTheme` holds the theme's id, or its label
 * when it has none. An unknown name resolves to the stock theme of the active kind.
 */
function resolveTheme(vscode, io) {
  const wb = vscode.workspace.getConfiguration("workbench");
  const kind = (vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind) || 2;
  const wanted = String(wb.get("colorTheme") || "");
  const all = [];
  for (const ext of knownExtensions(vscode, io)) {
    const themes = ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.themes;
    if (!Array.isArray(themes)) continue;
    let nls = null;
    for (const t of themes) {
      if (!t || typeof t.path !== "string") continue;
      let label = String(t.label || "");
      if (/^%.*%$/.test(label)) {
        if (nls === null) { try { nls = parseJsonc(io.fs.readFileSync(io.path.join(ext.extensionPath, "package.nls.json"), "utf8")); } catch { nls = {}; } }
        label = nls[label.slice(1, -1)] || label;
      }
      all.push({ id: t.id || label, label, file: io.path.join(ext.extensionPath, t.path) });
    }
  }
  const found = all.find((t) => t.id === wanted) || all.find((t) => t.label === wanted) || all.find((t) => t.id === DEFAULT_THEME[kind]) || null;
  if (!found) throw new Error("no colour theme named " + JSON.stringify(wanted) + " and no stock theme for kind " + kind);
  const theme = loadThemeFile(found.file, io);
  const foreground = theme.colors["editor.foreground"] || DEFAULT_FOREGROUND[kind] || DEFAULT_FOREGROUND[2];
  const custom = vscode.workspace.getConfiguration("editor").get("tokenColorCustomizations");
  const settings = [{ settings: { foreground } }].concat(theme.rules.filter((r) => r && typeof r === "object" && r.settings), customizationRules(custom, [found.id, found.label]));
  return { name: found.id, settings, key: found.id + "\n" + JSON.stringify(custom || null) };
}

let wasmReady = null;
/** vscode-oniguruma's WASM may be loaded once per process; every highlighter shares that one load. */
function loadWasm(onig, bytes) {
  if (!wasmReady) wasmReady = onig.loadWASM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return wasmReady;
}

/**
 * The tokenizer behind the command: lazily loads the engine's modules and the shell
 * grammar, keeps the registry's theme in step with the workbench, caches per text.
 * `io` is `{fs, path, roots}` — `roots` the directories whose `node_modules` may hold
 * the engine's vscode-textmate (the app root first, then the node binary's directory).
 */
class ShellHighlighter {
  constructor(vscode, io, log) {
    this.vscode = vscode;
    this.io = io;
    this.log = log || (() => undefined);
    this.loading = null;
    this.failure = "";
    this.themeKey = null;
    this.themeName = "";
    this.colorMap = [];
    this.cache = new Map();
  }
  async ensure() {
    if (this.failure) return false;
    if (!this.loading) this.loading = this.load().then(() => true, (error) => { this.failure = String((error && error.message) || error); this.log("native highlighting unavailable: " + this.failure); return false; });
    return this.loading;
  }
  async load() {
    const { fs, path } = this.io;
    let tm = null, onig = null, wasm = null, root = null;
    for (const candidate of this.io.roots.filter(Boolean)) {
      try {
        tm = require(path.join(candidate, "node_modules", "vscode-textmate"));
        onig = require(path.join(candidate, "node_modules", "vscode-oniguruma"));
        wasm = fs.readFileSync(path.join(candidate, "node_modules", "vscode-oniguruma", "release", "onig.wasm"));
        root = candidate;
        break;
      } catch { tm = onig = wasm = null; }
    }
    if (!tm) throw new Error("vscode-textmate and vscode-oniguruma not found under " + this.io.roots.filter(Boolean).map((r) => path.join(r, "node_modules")).join(", "));
    await loadWasm(onig, wasm);
    const grammars = new Map();
    for (const ext of knownExtensions(this.vscode, this.io)) {
      const list = ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.grammars;
      if (!Array.isArray(list)) continue;
      for (const g of list) if (g && g.scopeName && g.path && !grammars.has(g.scopeName)) grammars.set(g.scopeName, path.join(ext.extensionPath, g.path));
    }
    if (!grammars.has(SHELL_SCOPE)) throw new Error("no extension contributes the " + SHELL_SCOPE + " grammar");
    this.tm = tm;
    this.root = root;
    this.registry = new tm.Registry({
      onigLib: Promise.resolve({ createOnigScanner: (patterns) => new onig.OnigScanner(patterns), createOnigString: (s) => new onig.OnigString(s) }),
      loadGrammar: async (scope) => { const file = grammars.get(scope); return file ? tm.parseRawGrammar(fs.readFileSync(file, "utf8"), file) : null; },
    });
    this.grammar = await this.registry.loadGrammar(SHELL_SCOPE);
    if (!this.grammar) throw new Error("the " + SHELL_SCOPE + " grammar did not load");
    this.log("native highlighting: vscode-textmate from " + root + ", grammar from " + grammars.get(SHELL_SCOPE));
  }
  /** Re-read the theme when the setting or the customizations moved since the last call. */
  syncTheme() {
    const theme = resolveTheme(this.vscode, this.io);
    if (theme.key === this.themeKey) return;
    this.registry.setTheme({ name: theme.name, settings: theme.settings });
    this.colorMap = this.registry.getColorMap();
    this.themeKey = theme.key;
    this.themeName = theme.name;
    this.cache.clear();
    this.log("native highlighting: theme " + theme.name + " (" + theme.settings.length + " rules)");
  }
  resetTheme() { this.themeKey = null; this.cache.clear(); }
  async highlight(text) {
    text = String(text || "");
    if (!(await this.ensure())) return { lines: null, error: this.failure };
    try { this.syncTheme(); } catch (error) { return { lines: null, error: "theme: " + String((error && error.message) || error) }; }
    const cached = this.cache.get(text);
    if (cached) return { lines: cached, theme: this.themeName, root: this.root };
    const lines = [];
    let stack = this.tm.INITIAL;
    for (const line of text.split(/\r?\n/)) {
      const r = this.grammar.tokenizeLine2(line, stack);
      const toks = r.tokens, runs = [];
      for (let i = 0; i < toks.length; i += 2) {
        const s = toks[i], meta = toks[i + 1], e = i + 2 < toks.length ? toks[i + 2] : line.length;
        if (e <= s) continue;
        const fg = (meta & FG_MASK) >>> FG_OFFSET;
        // colour id 1 is the theme's default foreground: left to the tip's own text colour
        runs.push({ s, e, c: fg > 1 && this.colorMap[fg] ? this.colorMap[fg] : "", f: (meta & FS_MASK) >>> FS_OFFSET });
      }
      lines.push(runs);
      stack = r.ruleStack;
    }
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(text, lines);
    return { lines, theme: this.themeName, root: this.root };
  }
}

/** Wire the highlighter into an extension host: the command, and the theme listeners. */
function register(vscode, context, io, log) {
  const highlighter = new ShellHighlighter(vscode, io, log);
  context.subscriptions.push(
    vscode.commands.registerCommand(HIGHLIGHT_COMMAND, (args) => highlighter.highlight(args && args.text)),
    vscode.window.onDidChangeActiveColorTheme(() => highlighter.resetTheme()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("workbench.colorTheme") || e.affectsConfiguration("editor.tokenColorCustomizations")) highlighter.resetTheme(); }),
  );
  return highlighter;
}

module.exports = { HIGHLIGHT_COMMAND, SHELL_SCOPE, ShellHighlighter, register, resolveTheme, knownExtensions, loadThemeFile, customizationRules, themeKeyMatches, parseJsonc, parsePlist, TOKEN_GROUPS, DEFAULT_THEME, DEFAULT_FOREGROUND };
