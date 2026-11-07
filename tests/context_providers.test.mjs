// node --test: context providers (requirements 9.1, 9.3) — the registry listed
// after the file kinds, `capText` (UTF-8 byte cap, marker, no split surrogate),
// each resolver's pure formatter (problems, folder, spec, git diff), the
// `providerEntry` truncation note, the terminal helpers, the three chip helpers
// of 11.2, `resolveProblems` over stubbed diagnostics, `resolveTerminal` without
// a terminal, and `resolveGitDiff` answering GIT_ABSENT_MESSAGE when the git
// extension is absent. Same stub `vscode` module as spec_diagnostics.test.mjs,
// plus `languages` and an `extensions` namespace that knows no extension.
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
  window: { createOutputChannel: () => ({ appendLine() {} }), setStatusBarMessage: (m) => { stub.window.lastStatus = m; }, activeTextEditor: undefined, activeTerminal: undefined },
  languages: { getDiagnostics: () => stub.languages.all || [] },
  commands: {},
  extensions: { getExtension: () => undefined },
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
  CONTEXT_KINDS, CONTEXT_FILE_KINDS, CONTEXT_PROVIDERS, CONTEXT_CAP, PROVIDER_CAP, CONTEXT_BUDGET,
  TERMINAL_TAIL_LINES, TERMINAL_HISTORY_MAX, FOLDER_FILES_MAX, GIT_ABSENT_MESSAGE,
  byteLength, capText, tailLines, stripAnsi, plainDiagnostic, formatProblems, formatFolder, formatSpec, formatGitDiff,
  providerEntry, contextChipLabel, contextChipTooltip, contextChipEcho, resolveGitDiff, resolveProblems, resolveTerminal,
} = ext.__test;

const MARKER = /\n… \[truncated: (\d+) of (\d+) bytes shown\]$/;
const provider = (id) => CONTEXT_PROVIDERS.find((p) => p.id === id);

// ------------------------------------------------------------------ registry (9.1)

test("registry: five providers in order, each with label, glyph, icon and a resolver", () => {
  assert.deepEqual(CONTEXT_PROVIDERS.map((p) => p.id), ["problems", "terminal", "git-diff", "folder", "spec"]);
  assert.deepEqual(CONTEXT_PROVIDERS.map((p) => p.label), ["Problems", "Terminal", "Git Diff", "Folder", "Spec"]);
  for (const p of CONTEXT_PROVIDERS) {
    assert.equal(typeof p.label, "string", p.id + " label");
    assert.ok(p.glyph && p.glyph.length <= 2, p.id + " glyph");
    assert.match(p.icon, /^\$\([a-z-]+\)$/, p.id + " codicon");
    assert.equal(typeof p.description, "string", p.id + " description");
    assert.equal(typeof p.resolve, "function", p.id + " resolve");
  }
  assert.equal(new Set(CONTEXT_PROVIDERS.map((p) => p.glyph)).size, CONTEXT_PROVIDERS.length, "glyphs are distinct");
});

test("registry: the # picker lists the file kinds first, then the providers under their own section", () => {
  assert.deepEqual(CONTEXT_FILE_KINDS.map((k) => k.label), ["File", "Currently Open Files", "Steering"]);
  assert.deepEqual(CONTEXT_KINDS.map((k) => k.kind), [...CONTEXT_FILE_KINDS.map((k) => k.kind), ...CONTEXT_PROVIDERS.map((p) => p.id)]);
  assert.deepEqual(CONTEXT_KINDS.map((k) => k.label), ["File", "Currently Open Files", "Steering", "Problems", "Terminal", "Git Diff", "Folder", "Spec"]);
  assert.ok(CONTEXT_KINDS.slice(0, 3).every((k) => k.section === "Files"));
  assert.ok(CONTEXT_KINDS.slice(3).every((k) => k.section === "Providers"));
  assert.equal(CONTEXT_KINDS[7].glyph, provider("spec").glyph, "the picker row carries the provider's glyph");
});

test("registry: the caps and limits are the documented numbers", () => {
  assert.equal(CONTEXT_CAP, 65536);
  assert.equal(PROVIDER_CAP, Math.min(CONTEXT_CAP, CONTEXT_BUDGET));
  assert.equal(PROVIDER_CAP, 36000);
  assert.equal(TERMINAL_TAIL_LINES, 200);
  assert.equal(TERMINAL_HISTORY_MAX, 20);
  assert.equal(FOLDER_FILES_MAX, 200);
  assert.match(provider("folder").description, new RegExp(Math.round(PROVIDER_CAP / 1024) + " KB"));
  assert.match(provider("terminal").description, new RegExp("last " + TERMINAL_TAIL_LINES + " lines"));
});

// ------------------------------------------------------------- capText / marker (9.3)

test("capText: text under or at the cap is returned untouched", () => {
  const r = capText("hello", 5);
  assert.deepEqual(r, { text: "hello", truncated: false, shown: 5, total: 5 });
  assert.deepEqual(capText("hi", 100), { text: "hi", truncated: false, shown: 2, total: 2 });
});

test("capText: text over the cap is cut at the cap with the marker, shown and total in bytes", () => {
  const r = capText("abcdefghij", 4);
  assert.equal(r.truncated, true);
  assert.equal(r.shown, 4);
  assert.equal(r.total, 10);
  assert.equal(r.text, "abcd\n… [truncated: 4 of 10 bytes shown]");
  const m = r.text.match(MARKER);
  assert.ok(m, "marker line last");
  assert.equal(Number(m[1]), r.shown);
  assert.equal(Number(m[2]), r.total);
  assert.equal(byteLength(r.text.replace(MARKER, "")), r.shown, "kept bytes equal shown");
});

test("capText: a multibyte character or emoji is never split; shown counts bytes, not chars", () => {
  // "é" is 2 bytes: a 3-byte cap keeps "a" + "é" (3 bytes), a 2-byte cap keeps only "a".
  assert.equal(capText("aéb", 3).text.replace(MARKER, ""), "aé");
  assert.equal(capText("aéb", 2).text.replace(MARKER, ""), "a");
  // "😀" is 4 bytes / a surrogate pair: a cap landing between its two halves drops the whole pair.
  const emoji = capText("x😀y", 2);
  assert.equal(emoji.text.replace(MARKER, ""), "x");
  assert.equal(emoji.shown, 1);
  assert.equal(emoji.total, 6);
  const whole = capText("x😀y", 5);
  assert.equal(whole.text.replace(MARKER, ""), "x😀");
  assert.equal(whole.shown, 5);
  // A kept prefix always decodes to whole characters (no lone surrogate).
  for (const cap of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const kept = capText("日本😀語", cap).text.replace(MARKER, "");
    assert.ok(!/[\uD800-\uDFFF]/.test(kept.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "lone surrogate at cap " + cap);
    assert.ok(byteLength(kept) <= cap, "over cap at " + cap);
  }
});

test("capText: empty, null and a zero cap", () => {
  assert.deepEqual(capText("", 10), { text: "", truncated: false, shown: 0, total: 0 });
  assert.deepEqual(capText(null, 10), { text: "", truncated: false, shown: 0, total: 0 });
  assert.deepEqual(capText(undefined, 0), { text: "", truncated: false, shown: 0, total: 0 });
  const r = capText("abc", 0);
  assert.equal(r.truncated, true);
  assert.equal(r.shown, 0);
  assert.equal(r.text, "\n… [truncated: 0 of 3 bytes shown]");
});

test("byteLength counts UTF-8 bytes", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("é"), 2);
  assert.equal(byteLength("😀"), 4);
  assert.equal(byteLength(""), 0);
  assert.equal(byteLength(null), 0);
});

// ------------------------------------------------------------------- problems

test("formatProblems: one `path:line:col severity [source code]: message` line per diagnostic, 1-based", () => {
  const byFile = [
    ["src/a.js", [
      { range: { start: { line: 0, character: 4 } }, severity: 0, message: "Unexpected token", source: "eslint", code: "parse" },
      { range: { start: { line: 9, character: 0 } }, severity: 1, message: "  unused   var\n  x  ", source: "ts", code: { value: 6133 } },
    ]],
    ["b.py", [
      { range: { start: { line: 2, character: 2 } }, severity: 2, message: "info only" },
      { range: { start: { line: 3, character: 3 } }, severity: 3, message: "a hint", source: "pyright" },
      { range: { start: { line: 4, character: 4 } }, severity: "warning", message: "named severity", code: "W1" },
    ]],
  ];
  assert.equal(formatProblems(byFile), [
    "src/a.js:1:5 error [eslint parse]: Unexpected token",
    "src/a.js:10:1 warning [ts 6133]: unused var x",
    "b.py:3:3 info: info only",
    "b.py:4:4 hint [pyright]: a hint",
    "b.py:5:5 warning [W1]: named severity",
  ].join("\n"));
  assert.equal(formatProblems([]), "");
  assert.equal(formatProblems([["x", []]]), "");
  assert.equal(formatProblems([["x", [{ message: "no range", severity: 7 }]]]), "x:1:1 info: no range", "unknown severity falls back to info");
});

test("plainDiagnostic keeps what formatProblems reads and unwraps a code object", () => {
  const d = { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } }, severity: 0, message: "m", source: "s", code: { value: "C1", target: "http://x" } };
  assert.deepEqual(plainDiagnostic(d), { range: { start: { line: 1, character: 2 } }, severity: 0, message: "m", source: "s", code: "C1" });
  assert.equal(formatProblems([["f", [plainDiagnostic(d)]]]), "f:2:3 error [s C1]: m");
});

test("resolveProblems: no editor → all files; count in the label, files skipped when empty, paths kept; nothing → null", async () => {
  const rel = (p) => p.replace(/^\/w\//, "");
  stub.languages.all = [
    [{ path: "/w/src/a.js" }, [{ range: { start: { line: 0, character: 0 } }, severity: 0, message: "boom", source: "eslint" }]],
    [{ path: "/w/empty.js" }, []],
    [{ path: "/w/b.py" }, [{ range: { start: { line: 1, character: 1 } }, severity: 1, message: "w" }, { range: { start: { line: 2, character: 2 } }, severity: 2, message: "i" }]],
  ];
  try {
    const r = await resolveProblems({ rel });
    assert.equal(r.label, "Problems (3)");
    assert.equal(r.text, "src/a.js:1:1 error [eslint]: boom\nb.py:2:2 warning: w\nb.py:3:3 info: i");
    assert.equal(r.note, "3 diagnostics across 2 files");
    assert.deepEqual(r.paths, ["/w/src/a.js", "/w/b.py"]);
    assert.equal(providerEntry(provider("problems"), r).glyph, "⚠");
    stub.languages.all = [[{ path: "/w/x" }, []]];
    assert.equal(await resolveProblems({ rel }), null);
    assert.equal(stub.window.lastStatus, "KiroCrew: no problems");
  } finally { delete stub.languages.all; }
});

// --------------------------------------------------------------------- folder

test("formatFolder: listing, then each file under a --- path --- header, then the omitted count", () => {
  const text = formatFolder(["src/a.js", "src/b.js", "src/img.png"], [{ path: "src/a.js", text: "a();" }, { path: "src/b.js", text: "b();" }], { dir: "src/", omitted: 1 });
  assert.equal(text, [
    "Folder src/ — 3 files:\n  src/a.js\n  src/b.js\n  src/img.png",
    "--- src/a.js ---\na();",
    "--- src/b.js ---\nb();",
    "(1 listed file is not shown: binary, too large, or past the size cap)",
  ].join("\n\n"));
  const two = formatFolder(["a"], [], { dir: "d", omitted: 2 });
  assert.match(two, /^Folder d\/ — 1 file:\n  a/);
  assert.match(two, /\(2 listed files are not shown/);
  assert.equal(formatFolder([], [], {}), "Folder the workspace root — 0 files:\n", "root without a dir");
  assert.ok(!formatFolder(["a"], [], { dir: "d", omitted: 0 }).includes("not shown"), "no omitted line when nothing was omitted");
});

// ----------------------------------------------------------------------- spec

test("formatSpec: `# Spec name` then one `## <file>` section per document, missing ones noted", () => {
  const text = formatSpec("my-feature", [
    { file: "requirements.md", exists: true, text: "# Reqs\n\nR1.\n\n\n" },
    { file: "design.md", exists: false, text: "" },
    { file: "tasks.md", exists: true, text: "" },
  ]);
  assert.equal(text, [
    "# Spec my-feature",
    "## requirements.md\n\n# Reqs\n\nR1.",
    "## design.md\n\n(not written yet)",
    "## tasks.md\n\n(empty)",
  ].join("\n\n"));
  assert.equal(formatSpec("bare", []), "# Spec bare");
  assert.deepEqual(text.match(/^## .*$/gm), ["## requirements.md", "## design.md", "## tasks.md"], "headers in the given order");
});

// ------------------------------------------------------------------- git diff

test("formatGitDiff: the command line names staged/unstaged and the branch; an empty diff says so", () => {
  assert.equal(formatGitDiff("diff --git a/x b/x\n+1\n\n", { staged: false, branch: "main" }), "$ git diff   # on main\ndiff --git a/x b/x\n+1");
  assert.equal(formatGitDiff("+s", { staged: true }), "$ git diff --cached\n+s");
  assert.equal(formatGitDiff("", { staged: false }), "$ git diff\n(clean working tree)");
  assert.equal(formatGitDiff("", { staged: true, branch: "dev" }), "$ git diff --cached   # on dev\n(nothing staged)");
  assert.equal(formatGitDiff(null), "$ git diff\n(clean working tree)");
});

test("resolveGitDiff: no git extension and no root → GIT_ABSENT_MESSAGE, not a throw", async () => {
  const r = await resolveGitDiff({});
  assert.equal(r.label, "Git diff");
  assert.equal(r.text, GIT_ABSENT_MESSAGE);
  assert.equal(r.note, "git unavailable");
  assert.match(GIT_ABSENT_MESSAGE, /^Git diff is unavailable/);
  const entry = providerEntry(provider("git-diff"), r);
  assert.equal(entry.content, GIT_ABSENT_MESSAGE);
  assert.equal(entry.truncated, false);
  assert.equal(contextChipLabel(entry), "± Git diff");
  assert.equal(contextChipTooltip(entry), "git unavailable");
});

// ------------------------------------------------------------- providerEntry (9.3)

test("providerEntry: under the cap → content as given, glyph and paths copied, resolver note kept", () => {
  const e = providerEntry(provider("problems"), { label: "Problems (2)", text: "a:1:1 error: x", note: "2 diagnostics across 1 file", paths: ["/w/a"] });
  assert.deepEqual(e, { kind: "problems", label: "Problems (2)", content: "a:1:1 error: x", truncated: false, glyph: "⚠", note: "2 diagnostics across 1 file", paths: ["/w/a"] });
  const bare = providerEntry(provider("spec"), { text: "t" });
  assert.equal(bare.label, "Spec", "falls back to the provider label");
  assert.equal("note" in bare, false);
  assert.equal("paths" in bare, false);
});

test("providerEntry: over the cap → content cut with the marker, truncated set, note says how much was shown", () => {
  const e = providerEntry(provider("terminal"), { label: "Terminal", text: "0123456789", note: "selection of zsh" }, 6);
  assert.equal(e.truncated, true);
  assert.equal(e.content, "012345\n… [truncated: 6 of 10 bytes shown]");
  assert.equal(e.note, "selection of zsh Truncated: 6 of 10 bytes shown.");
  const noNote = providerEntry(provider("folder"), { text: "0123456789" }, 3);
  assert.equal(noNote.note, "Truncated: 3 of 10 bytes shown.");
  const big = providerEntry(provider("folder"), { text: "x".repeat(PROVIDER_CAP + 1) });
  assert.equal(big.truncated, true, "the default cap is PROVIDER_CAP");
  assert.equal(byteLength(big.content.replace(MARKER, "")), PROVIDER_CAP);
  assert.equal(providerEntry(provider("folder"), { text: "x".repeat(PROVIDER_CAP) }).truncated, false);
});

// ------------------------------------------------------------ terminal helpers

test("tailLines keeps the last n lines after dropping trailing blank lines", () => {
  assert.equal(tailLines("a\nb\nc\nd\n\n\n", 2), "c\nd");
  assert.equal(tailLines("a\nb", 5), "a\nb");
  assert.equal(tailLines("a\nb\nc", 0), "c", "n below 1 keeps one line");
  assert.equal(tailLines("", 3), "");
});

test("resolveTerminal: no active terminal → null with a status-bar hint, no throw", async () => {
  assert.equal(await resolveTerminal(), null);
  assert.equal(stub.window.lastStatus, "KiroCrew: no active terminal");
});

test("stripAnsi removes CSI colours, OSC titles, lone escapes and carriage returns", () => {
  assert.equal(stripAnsi("\x1b[32mok\x1b[0m done"), "ok done");
  assert.equal(stripAnsi("\x1b]0;title\x07$ ls\r\nfoo\r\n"), "$ ls\nfoo\n");
  assert.equal(stripAnsi("\x1b]633;A\x1b\\cmd"), "cmd");
  // Lone ESC + an Fe byte (0x40–0x5F, e.g. ESC M reverse index). Follow-up: ESC = / ESC > (keypad modes, Fp range 0x30–0x3F) are not stripped yet.
  assert.equal(stripAnsi("a\x1bMb\rc"), "abc");
  assert.equal(stripAnsi("\x1b[?25l\x1b[1;31mE\x1b[K"), "E");
  assert.equal(stripAnsi("a\r\r\nb\rc"), "a\nbc", "CR runs before LF collapse, bare CR is dropped");
  assert.equal(stripAnsi(null), "");
});

// --------------------------------------------------------------- chips (11.2)

test("contextChipLabel: provider glyph + label, # + label for files/steering, bare strings and empties", () => {
  assert.equal(contextChipLabel({ kind: "problems", label: "Problems (12)", glyph: "⚠" }), "⚠ Problems (12)");
  assert.equal(contextChipLabel({ kind: "file", label: "src/main.js" }), "#src/main.js");
  assert.equal(contextChipLabel({ kind: "steering", label: "rules.md", glyph: "#" }), "#rules.md");
  assert.equal(contextChipLabel("src/main.js"), "#src/main.js");
  assert.equal(contextChipLabel({ kind: "spec" }), "#spec", "kind stands in for a missing label");
  assert.equal(contextChipLabel(null), "");
  assert.equal(contextChipLabel(undefined), "");
});

test("contextChipTooltip: the note; a truncated entry always mentions truncation; file chips get none", () => {
  assert.equal(contextChipTooltip({ kind: "file", label: "a.js" }), "");
  assert.equal(contextChipTooltip({ kind: "problems", note: "3 diagnostics" }), "3 diagnostics");
  assert.equal(contextChipTooltip({ kind: "folder", note: "Truncated: 36000 of 90000 bytes shown.", truncated: true }), "Truncated: 36000 of 90000 bytes shown.");
  assert.equal(contextChipTooltip({ kind: "folder", note: "5 of 9 files read", truncated: true }), "5 of 9 files read Truncated to the size cap.");
  assert.equal(contextChipTooltip({ kind: "terminal", truncated: true }), "Truncated to the size cap.");
  assert.equal(contextChipTooltip("a.js"), "");
  assert.equal(contextChipTooltip(null), "");
  const e = providerEntry(provider("spec"), { text: "0123456789", note: "2 of 3 documents written" }, 4);
  assert.equal(contextChipTooltip(e), "2 of 3 documents written Truncated: 4 of 10 bytes shown.", "the providerEntry note is the tooltip");
});

test("contextChipEcho: bare label for file/steering entries, chip fields without content for providers", () => {
  assert.equal(contextChipEcho({ kind: "file", label: "a.js", content: "--- a.js ---\n…", paths: ["/w/a.js"] }), "a.js");
  assert.equal(contextChipEcho("a.js"), "a.js");
  assert.equal(contextChipEcho(null), null);
  const full = providerEntry(provider("problems"), { label: "Problems (1)", text: "x".repeat(20), note: "1 diagnostic", paths: ["/w/a"] }, 8);
  const echo = contextChipEcho(full);
  assert.deepEqual(echo, { kind: "problems", label: "Problems (1)", truncated: true, glyph: "⚠", note: "1 diagnostic Truncated: 8 of 20 bytes shown." });
  assert.equal("content" in echo, false);
  assert.equal("paths" in echo, false);
  assert.deepEqual(contextChipEcho({ kind: "git-diff", label: "Git diff", glyph: "±", content: "d" }), { kind: "git-diff", label: "Git diff", truncated: false, glyph: "±" });
  assert.equal(contextChipLabel(echo), contextChipLabel(full), "the bubble draws the composer's chip");
  assert.equal(contextChipTooltip(echo), contextChipTooltip(full));
});
