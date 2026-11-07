// node --test: the Specs view's pure helpers — the rename/create name
// validator, the directory name derived from an idea, the document rows per
// `.config.kiro`, and the pick defaults (requirements 2.3, 1.3, 1.4, 2.2).
// Loads the extension under the same stub `vscode` module spec_model.test.mjs uses.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const stub = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  FileType: { Directory: 2 },
  Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }), parse: (s) => ({ toString: () => s }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
  window: {},
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
  SPEC_NAME_PATTERN, SPEC_NAME_MAX, SPEC_NAME_FALLBACK,
  specNameFromIdea, validateSpecName, specDocumentRows,
  WORKFLOW_TYPE_PICKS, SPEC_TYPE_PICKS, WORKFLOW_TYPES, SPEC_TYPES,
} = ext.__test;

// ------------------------------------------------------------ validateSpecName

test("validateSpecName accepts a name of letters, digits, _ and - that is not taken", () => {
  assert.equal(validateSpecName("my-feature_2", []), null);
  assert.equal(validateSpecName("A", []), null);
  assert.equal(validateSpecName("under_score", new Set(["other"])), null);
  assert.equal(validateSpecName("  padded  ", []), null, "surrounding whitespace is trimmed before checking");
});

test("validateSpecName refuses an empty or whitespace-only name", () => {
  for (const v of ["", "   ", "\t\n", undefined, null]) {
    const err = validateSpecName(v, []);
    assert.equal(typeof err, "string", `expected an error for ${JSON.stringify(v)}`);
    assert.match(err, /name/i);
  }
});

test("validateSpecName refuses names outside ^[A-Za-z0-9_-]+$", () => {
  const bad = ["two words", "dotted.name", "a/b", "a\\b", "ünïcode", "日本語", "name!", "x@y", "semi;colon", "a b-c"];
  for (const v of bad) {
    const err = validateSpecName(v, []);
    assert.equal(typeof err, "string", `expected an error for ${JSON.stringify(v)}`);
    assert.match(err, /only/i);
    assert.equal(SPEC_NAME_PATTERN.test(v), false);
  }
});

test("validateSpecName refuses a taken name, given as an array or a Set", () => {
  assert.match(validateSpecName("auth", ["auth", "billing"]), /already exists/);
  assert.match(validateSpecName("auth", new Set(["auth"])), /already exists/);
  assert.equal(validateSpecName("auth", ["billing"]), null);
  assert.equal(validateSpecName("auth", undefined), null, "no taken list means nothing is taken");
});

test("validateSpecName refuses the unchanged current name only when `current` is given", () => {
  // Rename: the spec's own name is in `taken` too, but the "unchanged" message wins.
  assert.match(validateSpecName("auth", ["auth"], "auth"), /current name/);
  assert.match(validateSpecName(" auth ", ["auth"], "auth"), /current name/, "compared after trimming");
  // Create: the same name is fine when nobody holds it and there is no current.
  assert.equal(validateSpecName("auth", []), null);
  assert.equal(validateSpecName("auth", [], undefined), null);
  assert.equal(validateSpecName("auth", [], null), null);
  // Rename to something else: fine when free, refused when another spec holds it.
  assert.equal(validateSpecName("auth-v2", ["auth"], "auth"), null);
  assert.match(validateSpecName("billing", ["auth", "billing"], "auth"), /already exists/);
});

test("validateSpecName compares names case-sensitively, as given", () => {
  assert.equal(validateSpecName("Auth", ["auth"]), null, "a different case is a different directory name");
  assert.equal(validateSpecName("AUTH", ["auth"], "auth"), null);
  assert.match(validateSpecName("auth", ["auth"]), /already exists/);
});

// ------------------------------------------------------------ specNameFromIdea

test("specNameFromIdea lower-cases and joins words with hyphens", () => {
  assert.equal(specNameFromIdea("Add Dark Mode"), "add-dark-mode");
  assert.equal(specNameFromIdea("Add dark mode to the settings page!"), "add-dark-mode-to-the-settings-page");
  assert.equal(specNameFromIdea("  spaced   out\tidea\n"), "spaced-out-idea");
});

test("specNameFromIdea drops characters outside the pattern and keeps _ and -", () => {
  assert.equal(specNameFromIdea("fix: login (OAuth2) / SSO!"), "fix-login-oauth2-sso");
  assert.equal(specNameFromIdea("keep_under-score"), "keep_under-score");
  assert.equal(specNameFromIdea("café naïve résumé"), "caf-na-ve-r-sum");
  assert.equal(specNameFromIdea("--leading and trailing--"), "leading-and-trailing");
  for (const idea of ["Hello, World!", "a.b.c", "x/y/z", "日本語 test"]) {
    assert.match(specNameFromIdea(idea), SPEC_NAME_PATTERN);
  }
});

test("specNameFromIdea cuts at a word boundary at most SPEC_NAME_MAX characters long", () => {
  assert.equal(SPEC_NAME_MAX, 48);
  const words = Array.from({ length: 20 }, (_, i) => "word" + i); // "word0-word1-..." grows past 48
  const name = specNameFromIdea(words.join(" "));
  assert.ok(name.length <= SPEC_NAME_MAX, `${name.length} > ${SPEC_NAME_MAX}`);
  assert.ok(!name.endsWith("-"), "no dangling hyphen");
  const kept = name.split("-");
  assert.deepEqual(kept, words.slice(0, kept.length), "whole words from the start, none cut mid-word");
  assert.ok((name + "-" + words[kept.length]).length > SPEC_NAME_MAX, "the next word would not have fit");
  // Exactly at the limit is kept whole.
  const exact = "a".repeat(20) + " " + "b".repeat(27); // 20 + 1 + 27 = 48
  assert.equal(specNameFromIdea(exact), exact.replace(" ", "-"));
  assert.equal(specNameFromIdea(exact).length, SPEC_NAME_MAX);
});

test("specNameFromIdea truncates a single over-long word instead of dropping it", () => {
  const long = "x".repeat(SPEC_NAME_MAX + 10);
  assert.equal(specNameFromIdea(long), "x".repeat(SPEC_NAME_MAX));
  assert.equal(specNameFromIdea(long + " tail"), "x".repeat(SPEC_NAME_MAX));
});

test("specNameFromIdea falls back to new-spec when nothing usable is left", () => {
  assert.equal(SPEC_NAME_FALLBACK, "new-spec");
  for (const idea of ["", "   ", "!!! ???", "日本語", "---", "...", undefined, null]) {
    assert.equal(specNameFromIdea(idea), "new-spec", `for ${JSON.stringify(idea)}`);
  }
});

// ------------------------------------------------------------ specDocumentRows

const R = "requirements.md", D = "design.md", T = "tasks.md", B = "bugfix.md";

const ROW_CASES = [
  // [label, config, expected [file, generated] in order]
  ["requirements-first feature", { workflowType: "requirements-first", specType: "feature" }, [[R, false], [D, false], [T, false]]],
  ["design-first feature", { workflowType: "design-first", specType: "feature" }, [[D, false], [R, false], [T, false]]],
  ["fast-task feature", { workflowType: "fast-task", specType: "feature" }, [[T, false], [R, true], [D, true]]],
  ["requirements-first bugfix", { workflowType: "requirements-first", specType: "bugfix" }, [[B, false], [D, false], [T, false]]],
  ["design-first bugfix", { workflowType: "design-first", specType: "bugfix" }, [[B, false], [D, false], [T, false]]],
  ["fast-task bugfix", { workflowType: "fast-task", specType: "bugfix" }, [[B, false], [D, false], [T, false]]],
  ["null config", null, [[R, false], [D, false], [T, false]]],
  ["undefined config", undefined, [[R, false], [D, false], [T, false]]],
  ["empty config", {}, [[R, false], [D, false], [T, false]]],
  ["unknown workflow type", { workflowType: "sideways", specType: "feature" }, [[R, false], [D, false], [T, false]]],
];

for (const [label, config, expected] of ROW_CASES) {
  test(`specDocumentRows: ${label} → ${expected.map(([f]) => f.replace(/\.md$/, "")).join(" > ")}`, () => {
    const rows = specDocumentRows(config, {});
    assert.deepEqual(rows.map((r) => r.file), expected.map(([f]) => f), "order");
    assert.deepEqual(rows.map((r) => r.generated), expected.map(([, g]) => g), "generated flags");
    assert.deepEqual(rows.map((r) => r.stem), expected.map(([f]) => f.replace(/\.md$/, "")), "stems");
    assert.ok(rows.every((r) => r.exists === false), "nothing present → nothing exists");
  });
}

test("specDocumentRows: fast-task marks exactly the non-leading rows generated; bugfix never does", () => {
  const fast = specDocumentRows({ workflowType: "fast-task", specType: "feature" }, {});
  assert.deepEqual(fast.filter((r) => r.generated).map((r) => r.file), [R, D]);
  assert.equal(fast[0].file, T);
  for (const workflowType of WORKFLOW_TYPES) {
    const rows = specDocumentRows({ workflowType, specType: "bugfix" }, {});
    assert.deepEqual(rows.map((r) => r.file), [B, D, T], workflowType);
    assert.ok(rows.every((r) => r.generated === false), `${workflowType} bugfix has no generated rows`);
  }
});

test("specDocumentRows: `exists` comes from the present set, per file, missing files still get rows", () => {
  const cfg = { workflowType: "requirements-first", specType: "feature" };
  const rows = specDocumentRows(cfg, { [R]: true, [T]: true });
  assert.deepEqual(rows.map((r) => [r.file, r.exists]), [[R, true], [D, false], [T, true]]);
  // Truthy/falsy values are coerced to booleans; unrelated keys are ignored.
  const loose = specDocumentRows(cfg, { [R]: 1, [D]: 0, [T]: "yes", "notes.md": true });
  assert.deepEqual(loose.map((r) => r.exists), [true, false, true]);
  assert.equal(loose.length, 3);
  // A bugfix spec reads bugfix.md, not requirements.md, for its first row.
  const bug = specDocumentRows({ specType: "bugfix" }, { [R]: true, [B]: false });
  assert.deepEqual(bug.map((r) => [r.file, r.exists]), [[B, false], [D, false], [T, false]]);
  // No present set at all.
  assert.ok(specDocumentRows(cfg).every((r) => r.exists === false));
});

test("specDocumentRows returns fresh arrays and does not alias the shared order tables", () => {
  const a = specDocumentRows(null, {});
  const b = specDocumentRows(null, {});
  assert.notEqual(a, b);
  a[0].exists = true;
  assert.equal(b[0].exists, false);
  assert.deepEqual(Object.keys(a[0]).sort(), ["exists", "file", "generated", "stem"]);
});

// ------------------------------------------------------------ pick defaults (2.2)

test("WORKFLOW_TYPE_PICKS lists requirements-first first and covers every workflow type", () => {
  assert.equal(WORKFLOW_TYPE_PICKS[0].value, "requirements-first");
  assert.equal(WORKFLOW_TYPE_PICKS[0].picked, true);
  assert.deepEqual(WORKFLOW_TYPE_PICKS.map((p) => p.value), WORKFLOW_TYPES);
  assert.equal(WORKFLOW_TYPE_PICKS.filter((p) => p.picked).length, 1, "exactly one default");
  for (const p of WORKFLOW_TYPE_PICKS) assert.ok(p.label && p.description, p.value);
});

test("SPEC_TYPE_PICKS lists feature first and covers every spec type", () => {
  assert.equal(SPEC_TYPE_PICKS[0].value, "feature");
  assert.equal(SPEC_TYPE_PICKS[0].picked, true);
  assert.deepEqual(SPEC_TYPE_PICKS.map((p) => p.value), SPEC_TYPES);
  assert.equal(SPEC_TYPE_PICKS.filter((p) => p.picked).length, 1, "exactly one default");
  for (const p of SPEC_TYPE_PICKS) assert.ok(p.label && p.description, p.value);
});
