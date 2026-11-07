// node --test: requirement and property hovers (requirements 6.1, 6.2, 6.3):
// the ref finders, the markdown builders (fixtures parsed from small documents,
// so the parsers' tolerance of missing parts is covered too), `propertyAtLine`,
// the resolvers, and `provideHover` against a spec directory on disk. Same stub
// `vscode` as spec_diagnostics.test.mjs plus a disk-backed `workspace.fs.readFile`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { after, test } from "node:test";
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
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [], fs: { readFile: (uri) => fs.promises.readFile(uri.path) } },
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
  SPEC_HOVER_PATTERN, REVEAL_REQUIREMENT_COMMAND, PROPERTY_HOVER_FILE, SPEC_CONFIG_FILE,
  requirementRefsAt, requirementHoverMarkdown, requirementHoverResolver,
  propertyRefsAt, propertyHoverMarkdown, propertyAtLine, propertyHoverResolver,
  SpecRequirementHoverProvider, parseRequirements, parseProperties, findRequirement, buildSpecModel,
} = ext.__test;

// ---- fixtures: parsed from documents (6.3: headings, user story, numbered criteria, missing parts tolerated)

const REQUIREMENTS = [
  "# Requirements", "", "### Requirement 1 — Spec configuration", "",
  "**User Story:** As a developer, I want a config file.", "", "#### Acceptance Criteria", "",
  "1. WHEN a spec is created THEN the Bridge SHALL write `.config.kiro`.",
  "2. WHEN the file is missing THEN defaults SHALL apply.", "",
  "### Requirement 2", "", "1. Second requirement, first criterion.", "",
].join("\n");
const DESIGN = [
  "# Design", "", "## Correctness Properties", "", "### Property 1: Config round-trip", "",
  "Serialising then parsing a config returns the same fields.", "", "**Validates: Requirements 1.1, 1.2**", "",
  "**Property 2: Orphan**", "", "No validates line here.", "",
  "### Property 3: Whole requirement", "", "_Validates: Requirements 2, 9.1, 1.7_", "", "## Testing Strategy", "",
].join("\n");
const reqs = parseRequirements(REQUIREMENTS);
const props = parseProperties(DESIGN);
const DIR = "/w/.kiro/specs/foo";
const ctx = { feature: "foo", dir: DIR, file: "requirements.md" };
const LINK = "command:" + REVEAL_REQUIREMENT_COMMAND + "?";
/** The decoded `{dir, file, req}` of every reveal link in `md`, in order. */
const linkArgs = (md) => [...md.matchAll(/\]\(command:kirocrew\.spec\.revealRequirement\?([^)]+)\)/g)].map((m) => JSON.parse(decodeURIComponent(m[1])));
const refOf = (text) => { const [req, criterion] = text.split("."); return { text, req, criterion: criterion || null }; };

test("fixtures: the parsers tolerate a requirement without title or story and a property without Validates (6.3)", () => {
  assert.deepEqual(reqs.map((r) => [r.number, r.title, r.criteria.map((c) => c.ref)]), [["1", "Spec configuration", ["1.1", "1.2"]], ["2", "", ["2.1"]]]);
  assert.equal(reqs[0].userStory, "As a developer, I want a config file.");
  assert.equal(reqs[1].userStory, "");
  assert.deepEqual(props.map((p) => [p.number, p.title, p.validates]), [["1", "Config round-trip", ["1.1", "1.2"]], ["2", "Orphan", []], ["3", "Whole requirement", ["2", "9.1", "1.7"]]]);
  assert.equal(SPEC_HOVER_PATTERN, "**/.kiro/specs/*/*.md");
  assert.equal(PROPERTY_HOVER_FILE, "design.md");
});

// ---- requirementRefsAt (6.1)

test("requirementRefsAt: label, refs with req/criterion, and the cursor's active ref", () => {
  const line = "  - _Requirements: 1.1, 2_";
  const at = requirementRefsAt(line, line.indexOf("1.1") + 1);
  assert.deepEqual(at.label, { start: line.indexOf("Requirements:"), end: line.indexOf("Requirements:") + "Requirements:".length });
  assert.deepEqual(at.refs.map((r) => [r.text, r.req, r.criterion, line.slice(r.start, r.end)]), [["1.1", "1", "1", "1.1"], ["2", "2", null, "2"]]);
  assert.deepEqual(at.active.map((r) => r.text), ["1.1"]);
  assert.deepEqual(requirementRefsAt(line, line.indexOf("2_")).active.map((r) => r.text), ["2"]);
  assert.deepEqual(requirementRefsAt(line, line.indexOf("Requirements") + 3).active.map((r) => r.text), ["1.1", "2"], "on the label: every ref");
  assert.deepEqual(requirementRefsAt(line).active.map((r) => r.text), ["1.1", "2"], "no character: every ref");
});

test("requirementRefsAt: the bold label form, `none`, trailing prose, and lines without a label", () => {
  const bold = requirementRefsAt("**Requirements:** 1.1", 0);
  assert.deepEqual(bold.refs.map((r) => r.text), ["1.1"], "the label's own closing ** does not end the list");
  const none = requirementRefsAt("_Requirements: none_", 5);
  assert.ok(none && none.label.start === 1);
  assert.deepEqual(none.refs, []);
  assert.deepEqual(none.active, []);
  assert.deepEqual(requirementRefsAt("_Requirements: 1.1, 1.3_ and 2 more", 0).refs.map((r) => r.text), ["1.1", "1.3"]);
  assert.equal(requirementRefsAt("- [ ] 7.3 Unit tests for the hover builders", 4), null);
  assert.equal(requirementRefsAt("", 0), null);
});

// ---- requirementHoverMarkdown (6.1)

test("requirementHoverMarkdown with a sub-number: linked heading, italic story, the one criterion", () => {
  const md = requirementHoverMarkdown(refOf("1.2"), findRequirement(reqs, "1.2").requirement, ctx);
  const [heading, story, criterion] = md.split("\n\n");
  assert.ok(heading.startsWith("[**Requirement 1: Spec configuration**](" + LINK), heading);
  assert.deepEqual(linkArgs(md), [{ dir: DIR, file: "requirements.md", req: "1" }]);
  assert.equal(story, "*As a developer, I want a config file.*");
  assert.equal(criterion, "**1.2** WHEN the file is missing THEN defaults SHALL apply.");
  assert.ok(!md.includes("1.1"), "the sibling criterion is not shown");
});

test("requirementHoverMarkdown without a sub-number lists every criterion; no title or story → heading only", () => {
  const md = requirementHoverMarkdown(refOf("1"), findRequirement(reqs, "1").requirement, ctx);
  assert.ok(md.includes("\n\n- **1.1** WHEN a spec is created THEN the Bridge SHALL write `.config.kiro`.\n- **1.2** WHEN the file is missing"), md);
  const bare = requirementHoverMarkdown(refOf("2"), findRequirement(reqs, "2").requirement, ctx);
  assert.deepEqual(bare.split("\n\n").length, 2, "heading and criteria list, no story line");
  assert.ok(bare.startsWith("[**Requirement 2**](" + LINK), bare);
  assert.ok(bare.endsWith("- **2.1** Second requirement, first criterion."));
});

test("requirementHoverMarkdown: missing requirement, missing criterion, bugfix file name in link args and notes", () => {
  assert.equal(requirementHoverMarkdown(refOf("9"), null, ctx), "Requirement 9 not found in `requirements.md`");
  assert.equal(requirementHoverMarkdown({ text: "9.1" }, null, { file: "bugfix.md" }), "Requirement 9 not found in `bugfix.md`");
  assert.equal(requirementHoverMarkdown(refOf("9"), null), "Requirement 9 not found in `requirements.md`", "default file");
  const missing = requirementHoverMarkdown(refOf("1.7"), findRequirement(reqs, "1.7").requirement, ctx);
  assert.ok(missing.startsWith("[**Requirement 1: Spec configuration**](") && missing.includes("*As a developer"), missing);
  assert.ok(missing.endsWith("Criterion 1.7 not found in `requirements.md`"), missing);
  const bug = requirementHoverMarkdown(refOf("1.7"), reqs[0], { feature: "bug", dir: "/w/.kiro/specs/bug", file: "bugfix.md" });
  assert.deepEqual(linkArgs(bug), [{ dir: "/w/.kiro/specs/bug", file: "bugfix.md", req: "1" }]);
  assert.ok(bug.endsWith("not found in `bugfix.md`"));
});

// ---- propertyRefsAt (6.2)

test("propertyRefsAt: `_Property N_`, `**Property N**`, a `Property N:` heading; `Property-based` is not a reference", () => {
  for (const [line, number] of [["_Property 1_", "1"], ["**Property 2**", "2"], ["### Property 3: Title", "3"]]) {
    const at = propertyRefsAt(line, 0);
    assert.equal(at.kind, "property", line);
    assert.equal(at.label, null);
    assert.deepEqual(at.refs.map((r) => [r.text, r.number, line.slice(r.start, r.end)]), [[number, number, "Property " + number]], line);
  }
  assert.equal(propertyRefsAt("Property-based tests cover the parser", 3), null);
  assert.equal(propertyRefsAt("_Requirements: 1.1_", 3), null, "a requirements line is not a property line");
  const two = propertyRefsAt("See _Property 1_ and _Property 2_", 22);
  assert.deepEqual(two.refs.map((r) => r.number), ["1", "2"]);
  assert.deepEqual(two.active.map((r) => r.number), ["2"]);
});

test("propertyRefsAt: `Validates:` lines in plain, bold and bullet forms with the active selection", () => {
  const plain = "Validates: Requirements 1.1, 2.3";
  const at = propertyRefsAt(plain, plain.indexOf("2.3"));
  assert.equal(at.kind, "validates");
  assert.ok(at.label.start === 0 && at.label.end >= "Validates: Requirements".length && at.label.end <= plain.indexOf("1.1"), "label spans the words up to the first ref");
  assert.deepEqual(at.refs.map((r) => [r.text, r.req, r.criterion]), [["1.1", "1", "1"], ["2.3", "2", "3"]]);
  assert.deepEqual(at.active.map((r) => r.text), ["2.3"]);
  assert.deepEqual(propertyRefsAt(plain, 3).active.map((r) => r.text), ["1.1", "2.3"], "on the label: every ref");
  assert.deepEqual(propertyRefsAt("**Validates: Requirements 1.2, 3.4**").refs.map((r) => r.text), ["1.2", "3.4"]);
  const bullet = propertyRefsAt("- **Validates:** 2.1", 0);
  assert.equal(bullet.kind, "validates");
  assert.deepEqual(bullet.refs.map((r) => r.text), ["2.1"]);
});

// ---- propertyHoverMarkdown (6.2)

test("propertyHoverMarkdown with a Validates line: title, then one linked criterion with its text per ref", () => {
  const md = propertyHoverMarkdown({ number: "1" }, props[0], reqs, ctx);
  const [title, validates] = md.split("\n\n");
  assert.equal(title, "**Property 1: Config round-trip**");
  const rows = validates.split("\n");
  assert.equal(rows[0], "Validates:");
  assert.ok(rows[1].startsWith("- [**1.1**](" + LINK) && rows[1].endsWith(") WHEN a spec is created THEN the Bridge SHALL write `.config.kiro`."), rows[1]);
  assert.ok(rows[2].startsWith("- [**1.2**](" + LINK) && rows[2].endsWith(") WHEN the file is missing THEN defaults SHALL apply."), rows[2]);
  assert.deepEqual(linkArgs(md), [{ dir: DIR, file: "requirements.md", req: "1" }, { dir: DIR, file: "requirements.md", req: "1" }]);
  assert.equal(propertyHoverMarkdown({ text: "1" }, props[0], (ref) => findRequirement(reqs, ref), ctx), md, "a lookup function gives the same markdown");
});

test("propertyHoverMarkdown: a whole-requirement ref nests its criteria; unknown requirement and criterion are noted", () => {
  const md = propertyHoverMarkdown({ number: "3" }, props[2], reqs, { feature: "foo", dir: DIR, file: "bugfix.md" });
  const rows = md.split("\n\n")[1].split("\n");
  assert.ok(rows[1].startsWith("- [**Requirement 2**](" + LINK) && rows[1].endsWith(")"), rows[1]);
  assert.equal(rows[2], "  - **2.1** Second requirement, first criterion.");
  assert.equal(rows[3], "- **9.1** Requirement 9 not found in `bugfix.md`");
  assert.ok(rows[4].startsWith("- [**1.7**](") && rows[4].endsWith(") Criterion 1.7 not found in `bugfix.md`"), rows[4]);
  assert.deepEqual(linkArgs(md).map((a) => [a.file, a.req]), [["bugfix.md", "2"], ["bugfix.md", "1"]]);
});

test("propertyHoverMarkdown: no Validates line → italic note; missing property → not found in design.md", () => {
  assert.equal(propertyHoverMarkdown({ number: "2" }, props[1], reqs, ctx), "**Property 2: Orphan**\n\n*No `Validates:` line for this property in `design.md`*");
  assert.equal(propertyHoverMarkdown({ number: "8" }, null, reqs, ctx), "Property 8 not found in `design.md`");
  assert.equal(propertyHoverMarkdown({ text: "8" }, null, [], {}), "Property 8 not found in `design.md`");
  assert.equal(propertyHoverMarkdown({ number: "4" }, { number: "4", title: "", validates: [] }, reqs, ctx).split("\n\n")[0], "**Property 4**", "no title → number only");
});

// ---- propertyAtLine and the resolvers' matches()

test("propertyAtLine: the nearest property at or above the line, none above the first or without properties", () => {
  assert.equal(propertyAtLine(props, props[0].line), props[0]);
  assert.equal(propertyAtLine(props, props[1].line + 1), props[1]);
  assert.equal(propertyAtLine(props, props[2].line + 2), props[2]);
  assert.equal(propertyAtLine(props, props[0].line - 1), null);
  assert.equal(propertyAtLine([], 10), null);
  assert.equal(propertyAtLine(null, 10), null);
});

test("matches(): the requirement resolver skips Validates lines, the property resolver skips _Requirements:_ lines", () => {
  assert.equal(requirementHoverResolver.matches("  - _Requirements: 6.1, 6.2_"), true);
  assert.equal(requirementHoverResolver.matches("**Validates: Requirements 1.1**"), false);
  assert.equal(requirementHoverResolver.matches("Plain prose about requirements"), false);
  assert.equal(propertyHoverResolver.matches("**Validates: Requirements 1.1**"), true);
  assert.equal(propertyHoverResolver.matches("_Property 1_"), true);
  assert.equal(propertyHoverResolver.matches("  - _Requirements: 6.1_"), false);
  assert.equal(propertyHoverResolver.matches("Property-based tests"), false);
});

test("propertyHoverResolver.hover: a Validates line in design.md shows the enclosing property, elsewhere the requirements", () => {
  const dir = { path: DIR };
  const model = buildSpecModel({ name: "foo", dir, config: null, texts: { "requirements.md": REQUIREMENTS, "design.md": DESIGN, "tasks.md": "", "bugfix.md": null } });
  const line = "**Validates: Requirements 1.1, 1.2**";
  const inDesign = propertyHoverResolver.hover({ line, character: 2, spec: { name: "foo", dir }, model, document: { uri: { path: DIR + "/design.md" } }, position: { line: props[0].line + 4 } });
  assert.ok(inDesign.markdown.startsWith("**Property 1: Config round-trip**"), inDesign.markdown);
  assert.deepEqual([inDesign.start, inDesign.end], [2, line.lastIndexOf("1.2") + 3]);
  const inTasks = propertyHoverResolver.hover({ line, character: line.indexOf("1.2"), spec: { name: "foo", dir }, model, document: { uri: { path: DIR + "/tasks.md" } }, position: { line: 3 } });
  assert.ok(inTasks.markdown.startsWith("[**Requirement 1: Spec configuration**](") && inTasks.markdown.includes("**1.2** WHEN"), inTasks.markdown);
});

// ---- SpecRequirementHoverProvider against a spec directory on disk (6.1, 1.4)

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kide-hovers-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const writeSpec = (name, specType, requirementsFile, requirementsText) => {
  const dir = path.join(root, ".kiro", "specs", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SPEC_CONFIG_FILE), JSON.stringify({ specId: name, workflowType: "requirements-first", specType }));
  fs.writeFileSync(path.join(dir, requirementsFile), requirementsText);
  fs.writeFileSync(path.join(dir, "design.md"), DESIGN);
  fs.writeFileSync(path.join(dir, "tasks.md"), TASKS);
  return dir;
};
const TASKS = ["# Plan", "", "- [ ] 1. Do the thing", "  - _Requirements: 1.2, 2_", "", "Prose without references."].join("\n");
const fooDir = writeSpec("foo", "feature", "requirements.md", REQUIREMENTS);
const bugDir = writeSpec("bug", "bugfix", "bugfix.md", REQUIREMENTS.replace("Spec configuration", "Broken config"));
const doc = (p, text) => ({ uri: { path: p }, getText: () => text });
const provider = new SpecRequirementHoverProvider({ models: () => null });

test("provideHover: a trusted hover over the ref on a _Requirements:_ line of tasks.md, read from disk", async () => {
  const hover = await provider.provideHover(doc(fooDir + "/tasks.md", TASKS), { line: 3, character: TASKS.split("\n")[3].indexOf("1.2") });
  assert.ok(hover, "a hover");
  const md = hover.contents[0];
  assert.equal(md.isTrusted, true);
  assert.ok(md.value.startsWith("[**Requirement 1: Spec configuration**](" + LINK) && md.value.includes("**1.2** WHEN the file is missing"), md.value);
  assert.deepEqual(linkArgs(md.value), [{ dir: fooDir, file: "requirements.md", req: "1" }]);
  assert.deepEqual([hover.range.start.line, hover.range.start.character, hover.range.end.character], [3, TASKS.split("\n")[3].indexOf("1.2"), TASKS.split("\n")[3].indexOf("1.2") + 3]);
  const both = await provider.provideHover(doc(fooDir + "/tasks.md", TASKS), { line: 3, character: 6 });
  assert.ok(both.contents[0].value.includes("\n\n---\n\n[**Requirement 2**]("), "on the label: both refs, joined with a rule");
});

test("provideHover: null off a reference line, outside .kiro/specs, and without a position", async () => {
  assert.equal(await provider.provideHover(doc(fooDir + "/tasks.md", TASKS), { line: 5, character: 2 }), null);
  assert.equal(await provider.provideHover(doc(fooDir + "/tasks.md", TASKS), { line: 2, character: 2 }), null, "a task line without refs");
  assert.equal(await provider.provideHover(doc(root + "/notes/tasks.md", TASKS), { line: 3, character: 20 }), null);
  assert.equal(await provider.provideHover(doc(fooDir + "/tasks.md", TASKS), null), null);
});

test("provideHover: a bugfix spec resolves to bugfix.md (1.4); a Validates line in design.md gives the property hover (6.2)", async () => {
  const hover = await provider.provideHover(doc(bugDir + "/tasks.md", TASKS), { line: 3, character: 20 });
  assert.ok(hover.contents[0].value.startsWith("[**Requirement 1: Broken config**](" + LINK), hover.contents[0].value);
  assert.deepEqual(linkArgs(hover.contents[0].value), [{ dir: bugDir, file: "bugfix.md", req: "1" }]);
  const missing = await provider.provideHover(doc(bugDir + "/tasks.md", "- _Requirements: 9_"), { line: 0, character: 17 });
  assert.equal(missing.contents[0].value, "Requirement 9 not found in `bugfix.md`");
  const property = await provider.provideHover(doc(fooDir + "/design.md", DESIGN), { line: props[0].line + 4, character: 4 });
  assert.ok(property.contents[0].value.startsWith("**Property 1: Config round-trip**\n\nValidates:\n- [**1.1**](" + LINK), property.contents[0].value);
  assert.deepEqual(linkArgs(property.contents[0].value).map((a) => a.file), ["requirements.md", "requirements.md"]);
});
