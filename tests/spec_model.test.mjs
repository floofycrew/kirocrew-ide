// node --test: the SpecModel pieces of the extension (config, document order,
// task block ends, requirements, properties, context keys, config diagnostic,
// navigation) under the same stub `vscode` module extension_unit.test.mjs uses.
import assert from "node:assert/strict";
import fs from "node:fs";
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
  parseSpecConfig, newSpecConfig, serializeSpecConfig, documentOrder, requirementsFileOf,
  WORKFLOW_TYPES, SPEC_TYPES, DOCUMENT_ORDER, DEFAULT_WORKFLOW_TYPE, DEFAULT_SPEC_TYPE,
  parseTasks, parseTaskTree, taskBlockEnd,
  parseRequirements, findRequirement, parseProperties, findProperty, correctnessSection,
  buildSpecModel, specDirOf, specFileOf,
  specContextKeyValues, specConfigDiagnostic, SPEC_CONTEXT_KEYS,
  specNavigationTargets, adjacentSpecDocument,
} = ext.__test;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULTS = { specId: null, workflowType: "requirements-first", specType: "feature" };

// ------------------------------------------------------------------ .config.kiro

test("parseSpecConfig: a missing file is the defaults with no specId and no problem", () => {
  assert.deepEqual(parseSpecConfig(null), DEFAULTS);
  assert.deepEqual(parseSpecConfig(undefined), DEFAULTS);
  assert.equal(DEFAULT_WORKFLOW_TYPE, "requirements-first");
  assert.equal(DEFAULT_SPEC_TYPE, "feature");
});

test("parseSpecConfig: a valid file is read as written", () => {
  const cfg = parseSpecConfig('{"specId": " abc-1 ", "workflowType": "fast-task", "specType": "bugfix"}');
  assert.deepEqual(cfg, { specId: "abc-1", workflowType: "fast-task", specType: "bugfix" });
  assert.equal("problem" in cfg, false);
  // Fields left out are defaulted without complaint.
  assert.deepEqual(parseSpecConfig("{}"), DEFAULTS);
  assert.deepEqual(parseSpecConfig('{"workflowType": "design-first"}'), { ...DEFAULTS, workflowType: "design-first" });
});

test("parseSpecConfig: invalid JSON and non-objects fall back to the defaults and name the problem", () => {
  for (const text of ["{ nope", "", "not json at all", "{\"specId\": }"]) {
    const cfg = parseSpecConfig(text);
    assert.deepEqual({ specId: cfg.specId, workflowType: cfg.workflowType, specType: cfg.specType }, DEFAULTS, text);
    assert.match(cfg.problem, /not valid JSON/, text);
  }
  for (const text of ["[]", "null", "42", '"string"']) {
    const cfg = parseSpecConfig(text);
    assert.deepEqual({ specId: cfg.specId, workflowType: cfg.workflowType, specType: cfg.specType }, DEFAULTS, text);
    assert.equal(cfg.problem, ".config.kiro must be a JSON object", text);
  }
});

test("parseSpecConfig: one bad field is defaulted on its own, the valid ones are kept", () => {
  const cfg = parseSpecConfig('{"specId": "keep", "workflowType": "waterfall", "specType": "bugfix"}');
  assert.equal(cfg.specId, "keep");
  assert.equal(cfg.workflowType, "requirements-first", "the unknown workflow type is defaulted");
  assert.equal(cfg.specType, "bugfix", "the valid spec type survives");
  assert.match(cfg.problem, /^workflowType must be one of requirements-first, design-first, fast-task \(got "waterfall"\)$/);

  const two = parseSpecConfig('{"specId": "", "specType": 7}');
  assert.equal(two.specId, null);
  assert.equal(two.specType, "feature");
  assert.match(two.problem, /specId must be a non-empty string; specType must be one of feature, bugfix \(got 7\)/);
});

test("newSpecConfig / serializeSpecConfig: fresh v4 specId, unknown choices defaulted, three fields only", () => {
  const fresh = newSpecConfig();
  assert.match(fresh.specId, UUID_V4);
  assert.equal(fresh.workflowType, "requirements-first");
  assert.equal(fresh.specType, "feature");
  assert.notEqual(newSpecConfig().specId, fresh.specId, "each call mints a new id");
  const chosen = newSpecConfig({ workflowType: "fast-task", specType: "bugfix" });
  assert.equal(chosen.workflowType, "fast-task");
  assert.equal(chosen.specType, "bugfix");
  assert.deepEqual(newSpecConfig({ workflowType: "nope", specType: "nope" }).workflowType, "requirements-first");

  const body = serializeSpecConfig({ specId: "id-1", workflowType: "design-first", specType: "feature", extra: true });
  assert.ok(body.endsWith("\n"));
  assert.deepEqual(JSON.parse(body), { specId: "id-1", workflowType: "design-first", specType: "feature" });
  assert.deepEqual(parseSpecConfig(body), { specId: "id-1", workflowType: "design-first", specType: "feature" }, "round trip");
  assert.match(JSON.parse(serializeSpecConfig({})).specId, UUID_V4, "a missing specId is minted on write");
});

// --------------------------------------------------------------- document order

test("documentOrder: one order per workflow type, bugfix overrides them all, unknown input gets the default", () => {
  assert.deepEqual(WORKFLOW_TYPES, ["requirements-first", "design-first", "fast-task"]);
  assert.deepEqual(SPEC_TYPES, ["feature", "bugfix"]);
  assert.deepEqual(documentOrder({ workflowType: "requirements-first", specType: "feature" }), ["requirements.md", "design.md", "tasks.md"]);
  assert.deepEqual(documentOrder({ workflowType: "design-first", specType: "feature" }), ["design.md", "requirements.md", "tasks.md"]);
  assert.deepEqual(documentOrder({ workflowType: "fast-task", specType: "feature" }), ["tasks.md", "requirements.md", "design.md"]);
  for (const workflowType of WORKFLOW_TYPES) {
    assert.deepEqual(documentOrder({ workflowType, specType: "bugfix" }), ["bugfix.md", "design.md", "tasks.md"], workflowType + " + bugfix");
  }
  assert.deepEqual(documentOrder(null), DOCUMENT_ORDER["requirements-first"]);
  assert.deepEqual(documentOrder({ workflowType: "nope" }), DOCUMENT_ORDER["requirements-first"]);
  const order = documentOrder({ workflowType: "fast-task" });
  order.push("x");
  assert.equal(DOCUMENT_ORDER["fast-task"].length, 3, "callers get a copy, not the table");
});

test("requirementsFileOf: bugfix.md plays requirements for a bugfix spec", () => {
  assert.equal(requirementsFileOf({ specType: "bugfix" }), "bugfix.md");
  assert.equal(requirementsFileOf({ specType: "feature" }), "requirements.md");
  assert.equal(requirementsFileOf(null), "requirements.md");
});

// ------------------------------------------------------------- task block ends

test("parseTasks endLine: a parent spans its children, the last task reaches the end, trailing blanks are trimmed", () => {
  const md = [
    "# Plan",                           // 0
    "",                                 // 1
    "- [ ] 1. Parent",                  // 2
    "  - [x] 1.1 Child",                // 3
    "    - _Requirements: 1.1_",        // 4
    "",                                 // 5  (gap before the next sub-task: not part of 1.1)
    "  - [~]* 1.2 Child two",           // 6
    "    - detail",                     // 7
    "- [-] 2. Last",                    // 8
    "  - detail",                       // 9
    "",                                 // 10
    "",                                 // 11
  ].join("\n");
  const tasks = parseTasks(md);
  assert.deepEqual(tasks.map((t) => [t.number, t.level, t.box, t.line, t.endLine]), [
    ["1", 1, " ", 2, 7], ["1.1", 2, "x", 3, 4], ["1.2", 2, "~", 6, 7], ["2", 1, "-", 8, 9],
  ]);
  assert.equal(tasks[2].optional, true);
  assert.equal(tasks[0].leaf, false);
  assert.equal(tasks[3].leaf, true);
  for (const t of tasks) assert.ok(t.endLine >= t.line, t.number + ": endLine is never before line");
});

test("parseTasks endLine: three levels of nesting roll up to the root; a leaf with no details ends on its own line", () => {
  const md = [
    "- [ ] 1. A",            // 0
    "  - [ ] 1.1 B",         // 1
    "    - [ ] 1.1.1 C",     // 2
    "      - detail",        // 3
    "- [ ] 2. D",            // 4
  ].join("\n");
  const tasks = parseTasks(md);
  assert.deepEqual(tasks.map((t) => [t.number, t.level, t.line, t.endLine]), [["1", 1, 0, 3], ["1.1", 2, 1, 3], ["1.1.1", 3, 2, 3], ["2", 1, 4, 4]]);
});

test("parseTasks endLine: unnumbered tasks nest by indent and a document ending in blank lines is clamped", () => {
  const md = ["- [ ] Outer", "  - [ ] Inner", "    note", "", "", ""].join("\n");
  const tasks = parseTasks(md);
  assert.deepEqual(tasks.map((t) => [t.title, t.level, t.line, t.endLine]), [["Outer", 1, 0, 2], ["Inner", 2, 1, 2]]);
  assert.deepEqual(parseTasks(""), []);
  assert.deepEqual(parseTasks(null), []);
});

test("taskBlockEnd without the document text keeps the parser's end (no blank trimming)", () => {
  const md = ["- [ ] 1. A", "  - detail", "", "", "- [ ] 2. B"].join("\n");
  const tree = parseTaskTree(md);
  assert.equal(taskBlockEnd(tree[0], null), 3, "the parser's exclusive endLine minus one");
  assert.equal(taskBlockEnd(tree[0], md.split("\n")), 1, "with lines, trailing blanks are trimmed");
  assert.equal(taskBlockEnd(tree[1], md.split("\n")), 4);
});

// ------------------------------------------------------------- requirements.md

const REQUIREMENTS_MD = [
  "# Requirements — Fixture",
  "",
  "## Introduction",
  "",
  "Some prose with 1. a numbered thing that is not a criterion.",
  "",
  "### Requirement 1 — Spec configuration and types",
  "",
  "**User Story:** As a developer, I want each spec",
  "to declare its type.",
  "",
  "#### Acceptance Criteria",
  "",
  "1. WHEN a spec directory contains `.config.kiro` THEN the Bridge SHALL read",
  "   it.",
  "2. WHEN the Bridge creates a spec THEN it SHALL write a config.",
  "",
  "",
  "### Requirement 2 — No story",
  "",
  "#### Acceptance Criteria",
  "",
  "1. Something happens.",
  "",
  "### Requirement 3: No criteria",
  "",
  "**User Story:** Only a story.",
  "",
  "## Glossary",
  "",
  "1. Not a criterion either: the section ended at the level-2 heading.",
].join("\n");

test("parseRequirements: headings, titles, wrapped stories and wrapped criteria with hover refs and line ranges", () => {
  const reqs = parseRequirements(REQUIREMENTS_MD);
  assert.deepEqual(reqs.map((r) => r.number), ["1", "2", "3"]);
  const r1 = reqs[0];
  assert.equal(r1.heading, "Requirement 1 — Spec configuration and types");
  assert.equal(r1.title, "Spec configuration and types");
  assert.equal(r1.story, "As a developer, I want each spec to declare its type.");
  assert.equal(r1.userStory, r1.story, "design.md names the field userStory");
  assert.deepEqual(r1.criteria.map((c) => [c.number, c.ref, c.line]), [["1", "1.1", 13], ["2", "1.2", 15]]);
  assert.equal(r1.criteria[0].text, "WHEN a spec directory contains `.config.kiro` THEN the Bridge SHALL read it.");
  assert.equal(r1.line, 6);
  assert.equal(r1.endLine, 15, "trailing blank lines before the next requirement are not part of it");
});

test("parseRequirements: a requirement without a story, one without criteria, and nothing outside the sections", () => {
  const reqs = parseRequirements(REQUIREMENTS_MD);
  const [, r2, r3] = reqs;
  assert.equal(r2.story, "");
  assert.deepEqual(r2.criteria.map((c) => c.ref), ["2.1"]);
  assert.equal(r2.title, "No story");
  assert.equal(r3.title, "No criteria", "a colon separator is stripped like the dash");
  assert.equal(r3.story, "Only a story.");
  assert.deepEqual(r3.criteria, []);
  assert.equal(r3.endLine, 26, "the level-2 Glossary heading closes the last requirement");
  assert.deepEqual(parseRequirements(""), []);
  assert.deepEqual(parseRequirements(null), []);
  assert.deepEqual(parseRequirements("# Just a title\n\nNo requirements here.\n"), []);
});

test("findRequirement resolves N and N.M references; unknown or malformed refs give nulls", () => {
  const reqs = parseRequirements(REQUIREMENTS_MD);
  const hit = findRequirement(reqs, "1.2");
  assert.equal(hit.requirement.number, "1");
  assert.equal(hit.criterion.ref, "1.2");
  const whole = findRequirement(reqs, "2");
  assert.equal(whole.requirement.number, "2");
  assert.equal(whole.criterion, null);
  assert.deepEqual(findRequirement(reqs, "1.9"), { requirement: reqs[0], criterion: null });
  assert.deepEqual(findRequirement(reqs, "9"), { requirement: null, criterion: null });
  assert.deepEqual(findRequirement(reqs, "abc"), { requirement: null, criterion: null });
  assert.deepEqual(findRequirement(null, "1"), { requirement: null, criterion: null });
});

// ------------------------------------------------------------------ design.md

const DESIGN_MD = [
  "# Design",                                                           // 0
  "",                                                                   // 1
  "## Overview",                                                        // 2
  "",                                                                   // 3
  "Property 0: outside the section, ignored.",                          // 4
  "",                                                                   // 5
  "## Correctness Properties",                                          // 6
  "",                                                                   // 7
  "### Property 1: Config defaults",                                    // 8
  "*For any* text that is not valid JSON, parsing yields the defaults.", // 9
  "**Validates: Requirements 1.1, 1.4**",                               // 10
  "",                                                                   // 11
  "**Property 2: Document order**",                                     // 12
  "",                                                                   // 13
  "The order follows the workflow type.",                               // 14
  "",                                                                   // 15
  "_Validates: Requirements 1.3_",                                      // 16
  "",                                                                   // 17
  "- Property 3: Bullet form",                                          // 18
  "  - Validates: Requirement 6.3",                                     // 19
  "",                                                                   // 20
  "### Property 4 - No validates line",                                 // 21
  "Just a description.",                                                // 22
  "",                                                                   // 23
  "## Error Handling",                                                  // 24
  "",                                                                   // 25
  "Property 5: after the section, ignored.",                            // 26
  "**Validates: Requirements 9.9**",                                    // 27
].join("\n");

test("correctnessSection finds the section's line span and ends it at the next heading of the same level", () => {
  const lines = DESIGN_MD.split("\n");
  assert.deepEqual(correctnessSection(lines), { start: 7, end: 24 });
  assert.equal(correctnessSection(["# Design", "## Overview", "text"]), null);
  assert.deepEqual(correctnessSection(["## Correctness Properties", "x", "### deeper heading stays inside"]), { start: 1, end: 3 }, "runs to the end of the document");
});

test("parseProperties: heading, bold and bullet forms with bold, italic and plain Validates lines", () => {
  const props = parseProperties(DESIGN_MD);
  assert.deepEqual(props.map((p) => [p.number, p.title, p.validates, p.line]), [
    ["1", "Config defaults", ["1.1", "1.4"], 8],
    ["2", "Document order", ["1.3"], 12],
    ["3", "Bullet form", ["6.3"], 18],
    ["4", "No validates line", [], 21],
  ]);
  assert.equal(props[0].description, "For any text that is not valid JSON, parsing yields the defaults.", "emphasis is stripped from the description");
  assert.equal(props[1].description, "The order follows the workflow type.");
  assert.equal(props[2].description, "");
  assert.equal(props[3].description, "Just a description.");
});

test("parseProperties: no Correctness Properties section means no properties", () => {
  assert.deepEqual(parseProperties(["# Design", "", "## Overview", "", "Property 1: looks like one", "**Validates: Requirements 1.1**"].join("\n")), []);
  assert.deepEqual(parseProperties(""), []);
  assert.deepEqual(parseProperties(null), []);
  assert.deepEqual(parseProperties("## Correctness Properties\n\nNothing numbered here.\n"), [], "an empty section");
});

test("findProperty matches by number as string or number", () => {
  const props = parseProperties(DESIGN_MD);
  assert.equal(findProperty(props, 2).title, "Document order");
  assert.equal(findProperty(props, "3").title, "Bullet form");
  assert.equal(findProperty(props, "9"), null);
  assert.equal(findProperty(null, 1), null);
});

// ------------------------------------------------------------------- SpecModel

test("specDirOf / specFileOf locate the spec directory and the document for any path inside it", () => {
  assert.equal(specDirOf("/w/.kiro/specs/foo/tasks.md"), "/w/.kiro/specs/foo");
  assert.equal(specFileOf("/w/.kiro/specs/foo/tasks.md"), "tasks.md");
  assert.equal(specDirOf("/w/.kiro/specs/foo"), "/w/.kiro/specs/foo");
  assert.equal(specFileOf("/w/.kiro/specs/foo"), "");
  assert.equal(specDirOf("/w/.kiro/specs/foo/"), "/w/.kiro/specs/foo");
  assert.equal(specDirOf("C:\\w\\.kiro\\specs\\foo\\design.md"), "C:/w/.kiro/specs/foo");
  assert.equal(specFileOf("C:\\w\\.kiro\\specs\\foo\\design.md"), "design.md");
  assert.equal(specDirOf("/w/src/notes.md"), null);
  assert.equal(specFileOf("/w/src/notes.md"), "");
  assert.equal(specDirOf("/w/.kiro/specs"), null, "the specs root is not a spec");
  assert.equal(specDirOf(null), null);
});

test("buildSpecModel: documents, order, tasks with endLine, requirements and properties from the given texts", () => {
  const model = buildSpecModel({
    name: "fixture", dir: "/w/.kiro/specs/fixture",
    config: { specId: "id", workflowType: "fast-task", specType: "feature" },
    texts: { "requirements.md": REQUIREMENTS_MD, "design.md": DESIGN_MD, "tasks.md": "- [ ] 1. A\n  - [x] 1.1 B\n  - detail\n", "bugfix.md": null },
  });
  assert.equal(model.name, "fixture");
  assert.equal(model.requirementsFile, "requirements.md");
  assert.deepEqual(model.order, ["tasks.md", "requirements.md", "design.md"]);
  assert.deepEqual(Object.fromEntries(Object.entries(model.documents).map(([f, d]) => [f, d.exists])), { "requirements.md": true, "bugfix.md": false, "design.md": true, "tasks.md": true });
  assert.equal(model.documents["bugfix.md"].text, "");
  assert.deepEqual(model.tasks.map((t) => [t.number, t.line, t.endLine]), [["1", 0, 2], ["1.1", 1, 2]]);
  assert.equal(model.taskTree.length, 1);
  assert.deepEqual(model.requirements.map((r) => r.number), ["1", "2", "3"]);
  assert.deepEqual(model.properties.map((p) => p.number), ["1", "2", "3", "4"]);
  assert.ok(typeof model.builtAt === "number");
});

test("buildSpecModel: a bugfix spec reads its requirements from bugfix.md; a null config means the defaults", () => {
  const bugfix = buildSpecModel({
    name: "fix", config: { specId: "x", workflowType: "requirements-first", specType: "bugfix" },
    texts: { "bugfix.md": "### Requirement 1 — Bug\n\n1. It fails.\n", "requirements.md": "### Requirement 7 — Ignored\n" },
  });
  assert.equal(bugfix.requirementsFile, "bugfix.md");
  assert.deepEqual(bugfix.order, ["bugfix.md", "design.md", "tasks.md"]);
  assert.deepEqual(bugfix.requirements.map((r) => r.number), ["1"]);
  assert.equal(bugfix.requirements[0].criteria[0].ref, "1.1");

  const empty = buildSpecModel({});
  assert.deepEqual(empty.config, DEFAULTS);
  assert.equal(empty.name, "");
  assert.equal(empty.dir, null);
  assert.deepEqual(empty.order, ["requirements.md", "design.md", "tasks.md"]);
  assert.deepEqual([empty.tasks, empty.requirements, empty.properties], [[], [], []]);
  assert.equal(empty.documents["tasks.md"].exists, false);
});

// -------------------------------------------- context keys and config diagnostic

test("specContextKeyValues: the config's values inside a spec directory, defaults with no config, unset outside", () => {
  const W = SPEC_CONTEXT_KEYS.workflowType, S = SPEC_CONTEXT_KEYS.specType;
  assert.equal(W, "kirocrew.spec.workflowType");
  assert.equal(S, "kirocrew.spec.specType");
  assert.deepEqual(specContextKeyValues("/w/.kiro/specs/foo/tasks.md", { workflowType: "fast-task", specType: "bugfix" }), { [W]: "fast-task", [S]: "bugfix" });
  assert.deepEqual(specContextKeyValues("/w/.kiro/specs/foo/.config.kiro", null), { [W]: "requirements-first", [S]: "feature" });
  assert.deepEqual(specContextKeyValues("/w/src/index.js", { workflowType: "fast-task", specType: "bugfix" }), { [W]: undefined, [S]: undefined });
  assert.deepEqual(specContextKeyValues(null, null), { [W]: undefined, [S]: undefined });
});

test("specConfigDiagnostic: null for a missing or valid file, a warning with a range otherwise", () => {
  assert.equal(specConfigDiagnostic(null), null);
  assert.equal(specConfigDiagnostic('{"specId": "a", "workflowType": "design-first", "specType": "feature"}'), null);
  assert.equal(specConfigDiagnostic("{}"), null, "missing fields are defaults, not problems");

  const bad = specConfigDiagnostic("{ nope");
  assert.match(bad.message, /not valid JSON/);
  assert.equal(bad.severity, "warning");
  assert.equal(bad.source, "kirocrew-spec");
  assert.equal(bad.code, "spec-config");
  for (const k of ["line", "character", "endLine", "endCharacter"]) assert.ok(Number.isInteger(bad.range[k]) && bad.range[k] >= 0, k);
  assert.ok(bad.range.endLine >= bad.range.line);
  assert.ok(bad.range.line === bad.range.endLine ? bad.range.endCharacter > bad.range.character : true);

  const list = specConfigDiagnostic("[]");
  assert.equal(list.message, ".config.kiro must be a JSON object");
  assert.deepEqual(list.range, { line: 0, character: 0, endLine: 0, endCharacter: 2 }, "whole document");
});

test("specConfigDiagnostic: a bad field underlines its own line", () => {
  const text = '{\n  "specId": "a",\n  "workflowType": "waterfall",\n  "specType": "feature"\n}\n';
  const d = specConfigDiagnostic(text);
  assert.match(d.message, /^workflowType must be one of/);
  assert.deepEqual(d.range, { line: 2, character: 2, endLine: 2, endCharacter: '  "workflowType": "waterfall",'.length });

  const two = specConfigDiagnostic('{\n  "specId": "",\n  "specType": "x"\n}');
  assert.match(two.message, /specId must be a non-empty string; specType must be one of/);
  assert.equal(two.range.line, 1, "the first bad key in field order is underlined");
});

// ----------------------------------------------------------------- navigation

test("specNavigationTargets: the other documents in workflow order, keeping their full-order positions", () => {
  const feature = { workflowType: "requirements-first", specType: "feature" };
  assert.deepEqual(specNavigationTargets("design.md", feature), [
    { file: "requirements.md", position: 1, command: "kirocrew.spec.goto.requirements" },
    { file: "tasks.md", position: 3, command: "kirocrew.spec.goto.tasks" },
  ]);
  assert.deepEqual(specNavigationTargets("/w/.kiro/specs/foo/tasks.md", { workflowType: "fast-task", specType: "feature" }).map((t) => t.file), ["requirements.md", "design.md"]);
  assert.deepEqual(specNavigationTargets("bugfix.md", { specType: "bugfix" }).map((t) => [t.file, t.position]), [["design.md", 2], ["tasks.md", 3]]);
  assert.deepEqual(specNavigationTargets("requirements.md", { specType: "bugfix" }).map((t) => t.file), ["bugfix.md", "design.md", "tasks.md"], "a file outside the order hides nothing");
});

test("adjacentSpecDocument steps through the order and stops at its ends", () => {
  const feature = { workflowType: "requirements-first", specType: "feature" };
  assert.equal(adjacentSpecDocument("requirements.md", feature, 1), "design.md");
  assert.equal(adjacentSpecDocument("design.md", feature, 1), "tasks.md");
  assert.equal(adjacentSpecDocument("tasks.md", feature, 1), null);
  assert.equal(adjacentSpecDocument("tasks.md", feature, -1), "design.md");
  assert.equal(adjacentSpecDocument("requirements.md", feature, -1), null);
  assert.equal(adjacentSpecDocument("/w/.kiro/specs/foo/tasks.md", { workflowType: "fast-task" }, 1), "requirements.md");
  assert.equal(adjacentSpecDocument("requirements.md", { specType: "bugfix" }, 1), null, "not one of a bugfix spec's documents");
  assert.equal(adjacentSpecDocument("bugfix.md", { specType: "bugfix" }, 1), "design.md");
  assert.equal(adjacentSpecDocument("design.md", feature, 0), "design.md");
});

// ------------------------------------------------- title-bar actions (3.3)

const { specDocumentHasContent, nextDocumentDecision, SPEC_CONTENT_KEY, SPEC_SYNC_WHEN, SPEC_NEXT_WHEN, SpecContentKey } = ext.__test;

test("specDocumentHasContent: non-blank text or unsaved edits count, a clean blank document does not", () => {
  assert.equal(specDocumentHasContent("# Design\n", false), true);
  assert.equal(specDocumentHasContent("", true), true, "a dirty document is being written");
  assert.equal(specDocumentHasContent("", false), false);
  assert.equal(specDocumentHasContent(" \n\t\n", false), false, "whitespace is not content");
  assert.equal(specDocumentHasContent(null, false), false, "a missing file");
  assert.equal(specDocumentHasContent(null, true), true);
});

test("nextDocumentDecision: open the next document when it has content, generate it otherwise, nothing at the end", () => {
  const feature = { workflowType: "requirements-first", specType: "feature" };
  assert.deepEqual(nextDocumentDecision("requirements.md", feature, true), { action: "open", file: "design.md" });
  assert.deepEqual(nextDocumentDecision("requirements.md", feature, false), { action: "generate", file: "design.md" });
  assert.deepEqual(nextDocumentDecision("/w/.kiro/specs/foo/design.md", feature, false), { action: "generate", file: "tasks.md" });
  assert.deepEqual(nextDocumentDecision("tasks.md", feature, true), { action: "none", file: null }, "tasks.md is the last document");
  assert.deepEqual(nextDocumentDecision("bugfix.md", { specType: "bugfix" }, false), { action: "generate", file: "design.md" });
  assert.deepEqual(nextDocumentDecision("requirements.md", { specType: "bugfix" }, true), { action: "none", file: null }, "off the order of a bugfix spec");
  assert.deepEqual(nextDocumentDecision("design.md", { workflowType: "fast-task" }, true), { action: "none", file: null }, "design.md is the last of a fast-task spec");
  assert.deepEqual(nextDocumentDecision("tasks.md", { workflowType: "fast-task" }, false), { action: "generate", file: "requirements.md" });
});

test("the Sync and Next when-clauses and the package.json entries agree", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "extension", "package.json"), "utf8"));
  const menus = pkg.contributes.menus["editor/title"];
  const sync = menus.find((e) => e.command === "kirocrew.spec.syncDocument");
  const next = menus.find((e) => e.command === "kirocrew.spec.nextDocument");
  assert.equal(SPEC_CONTENT_KEY, "kirocrew.spec.documentHasContent");
  assert.equal(sync.when, SPEC_SYNC_WHEN, "Sync shows only while the document has content");
  assert.equal(sync.group, "navigation@4");
  assert.equal(next.when, SPEC_NEXT_WHEN, "Next hides on the last document of the order");
  assert.ok(/resourceFilename != 'tasks.md'/.test(next.when) && /fast-task/.test(next.when));
  assert.equal(next.group, "navigation@5");
  const key = pkg.contributes.keybindings.find((k) => k.command === "kirocrew.spec.syncDocument");
  assert.equal(key.key, "ctrl+shift+enter");
  assert.equal(key.mac, "cmd+shift+enter");
  assert.ok(key.when.includes(SPEC_CONTENT_KEY) && key.when.startsWith("editorTextFocus"));
  assert.ok(pkg.contributes.commands.some((c) => c.command === "kirocrew.spec.syncDocument" && /Sync with project files/.test(c.title)));
});

// ------------------------------------------------- "Run all tasks" title action (3.5)

const { SPEC_RUN_ALL_WHEN, specRunNode } = ext.__test;

test("the Run all tasks title entry and keybinding target tasks.md only and agree with SPEC_RUN_ALL_WHEN", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "extension", "package.json"), "utf8"));
  const entries = pkg.contributes.menus["editor/title"].filter((e) => e.command === "kirocrew.spec.runAll");
  assert.equal(entries.length, 1, "one title entry");
  assert.equal(entries[0].when, SPEC_RUN_ALL_WHEN);
  assert.equal(entries[0].group, "navigation@6", "after the goto, Sync and Next entries");
  assert.ok(/resourceFilename == 'tasks.md'/.test(SPEC_RUN_ALL_WHEN), "only the tasks document");
  assert.ok(SPEC_RUN_ALL_WHEN.startsWith(ext.__test.SPEC_RESOURCE_WHEN), "built on the spec-resource fragment");
  const keys = pkg.contributes.keybindings.filter((k) => k.command === "kirocrew.spec.runAll");
  assert.equal(keys.length, 1, "one keybinding");
  assert.equal(keys[0].key, "ctrl+alt+enter");
  assert.equal(keys[0].mac, "cmd+alt+enter");
  assert.equal(keys[0].when, "editorTextFocus && " + SPEC_RUN_ALL_WHEN + " && !notebookEditorFocused");
  const sync = pkg.contributes.keybindings.find((k) => k.command === "kirocrew.spec.syncDocument");
  assert.notEqual(keys[0].key, sync.key, "does not collide with Sync's chord");
  assert.ok(pkg.contributes.commands.some((c) => c.command === "kirocrew.spec.runAll" && /Run all tasks/.test(c.title) && c.icon));
});

test("specRunNode: a view node passes through, a Uri or the active editor resolves to the spec holding the document, else null", () => {
  const foo = { name: "foo", dir: { path: "/w/.kiro/specs/foo" } };
  const bar = { name: "bar", dir: { path: "/local/home/u/w/.kiro/specs/bar" } };
  const specs = [foo, bar];
  const node = { spec: foo, contextValue: "spec-interrupted" };
  assert.equal(specRunNode(node, specs), node, "the Specs view's node is used as is");
  assert.deepEqual(specRunNode({ path: "/w/.kiro/specs/foo/tasks.md" }, specs), { spec: foo, contextValue: "spec" }, "the title bar's Uri");
  assert.deepEqual(specRunNode({ path: "/home/u/w/.kiro/specs/bar/tasks.md" }, specs), { spec: bar, contextValue: "spec" }, "a /local-prefixed home spelled the other way");
  assert.equal(specRunNode({ path: "/w/.kiro/specs/baz/tasks.md" }, specs), null, "a spec listSpecs does not know");
  assert.equal(specRunNode({ path: "/w/src/index.js" }, specs), null, "a Uri outside .kiro/specs");
  try {
    stub.window.activeTextEditor = { document: { uri: { path: "/w/.kiro/specs/foo/tasks.md" } } };
    assert.deepEqual(specRunNode(undefined, specs), { spec: foo, contextValue: "spec" }, "the keybinding: no argument, the active editor");
    stub.window.activeTextEditor = { document: { uri: { path: "/w/README.md" } } };
    assert.equal(specRunNode(undefined, specs), null, "no argument and an unrelated editor");
    assert.equal(specRunNode(undefined, specs, { activeDocumentUri: () => ({ path: "/w/.kiro/specs/foo/design.md" }) }).spec, foo, "the spec editor's document as the last resort");
    assert.equal(specRunNode(undefined, [], { activeDocumentUri: () => ({ path: "/w/.kiro/specs/foo/design.md" }) }), null, "no specs listed");
  } finally { delete stub.window.activeTextEditor; }
});

test("SpecContentKey sets the key from the active editor's text and dirty state, once per change", () => {
  const set = [];
  stub.commands.executeCommand = (cmd, key, value) => { set.push([cmd, key, value]); return Promise.resolve(); };
  const editorOf = (p, text, dirty) => ({ document: { uri: { path: p }, isDirty: dirty, getText: () => text } });
  try {
    const k = new SpecContentKey(null);
    k.refresh(editorOf("/w/.kiro/specs/foo/design.md", "", false));
    k.refresh(editorOf("/w/.kiro/specs/foo/design.md", "", false));
    assert.deepEqual(set, [["setContext", SPEC_CONTENT_KEY, false]], "the same value is not re-applied");
    k.refresh(editorOf("/w/.kiro/specs/foo/design.md", "", true));
    assert.deepEqual(set.at(-1), ["setContext", SPEC_CONTENT_KEY, true], "typing turns it on");
    k.refresh(editorOf("/w/src/index.js", "code", false));
    assert.deepEqual(set.at(-1), ["setContext", SPEC_CONTENT_KEY, false], "a file outside a spec never has it");
    k.refresh(undefined);
    assert.equal(set.length, 3, "a webview taking focus leaves the key alone");
  } finally { delete stub.commands.executeCommand; }
});

// ------------------------------------------------------------- spec turns (3.2)

const { SPEC_TURN_KINDS, specTurnDocument, specSiblings, specTurnText, specTurnDisplay, specTurnTitle, specTabRecord, specTabMatches, phasePrompt } = ext.__test;
const specOf = (config) => ({ name: "foo", workspace: { uri: { path: "/w" } }, config: Object.assign({ specId: "x", workflowType: "requirements-first", specType: "feature" }, config || {}) });

test("specTurnDocument and specSiblings: bare names become files, siblings follow the spec's order", () => {
  assert.equal(specTurnDocument("design"), "design.md");
  assert.equal(specTurnDocument("/w/.kiro/specs/foo/tasks.md"), "tasks.md");
  assert.equal(specTurnDocument("notes.md"), "notes.md");
  assert.deepEqual(specSiblings("design.md", { workflowType: "requirements-first" }), ["requirements.md", "tasks.md"]);
  assert.deepEqual(specSiblings("tasks", { workflowType: "fast-task" }), ["requirements.md", "design.md"]);
  assert.deepEqual(specSiblings("design.md", { specType: "bugfix" }), ["bugfix.md", "tasks.md"]);
  assert.deepEqual(SPEC_TURN_KINDS, ["create", "generate", "update", "fix", "review"]);
});

test("specTurnText generate: the existing phase request, bugfix specs read bugfix.md", () => {
  const spec = specOf();
  assert.equal(specTurnText("generate", "requirements.md", { spec, idea: "an idea" }), phasePrompt("requirements", spec, "an idea"));
  assert.equal(specTurnText("generate", "design", { spec }), phasePrompt("design", spec));
  assert.match(specTurnText("generate", "design", { spec }), /Read \.kiro\/specs\/foo\/requirements\.md/);
  const bug = specOf({ specType: "bugfix" });
  assert.match(specTurnText("generate", "design.md", { spec: bug }), /Read \.kiro\/specs\/foo\/bugfix\.md/);
  assert.match(specTurnText("generate", "bugfix.md", { spec: bug, idea: "it crashes" }), /PHASE: BUG REPORT.*bugfix\.md for this bug: it crashes/);
  assert.throws(() => specTurnText("generate", "requirements.md", { spec: bug }), /not a document of foo/);
  assert.throws(() => specTurnText("generate", "design.md", {}), /no spec/);
});

test("specTurnText create: the first document of the order, seeded with the idea", () => {
  const first = specTurnText("create", "requirements.md", { spec: specOf(), idea: "dark mode" });
  assert.match(first, /PHASE: REQUIREMENTS.*for this feature: dark mode/);
  assert.match(first, /new spec \(workflow type requirements-first, spec type feature\)/);
  assert.match(specTurnText("create", "design.md", { spec: specOf({ workflowType: "design-first" }), idea: "dark mode" }), /PHASE: DESIGN FIRST.*design\.md for this feature: dark mode/);
  assert.match(specTurnText("create", "tasks.md", { spec: specOf({ workflowType: "fast-task" }), idea: "dark mode" }), /PHASE: FAST TASK.*write \.kiro\/specs\/foo\/tasks\.md/);
  assert.match(specTurnText("create", "bugfix.md", { spec: specOf({ specType: "bugfix" }), idea: "it crashes" }), /PHASE: BUG REPORT/);
});

test("specTurnText update, fix and review name the document, the siblings and the task", () => {
  const spec = specOf();
  const update = specTurnText("update", "design.md", { spec });
  assert.match(update, /PHASE: UPDATE DESIGN\. Re-read \.kiro\/specs\/foo\/design\.md and its sibling documents \(\.kiro\/specs\/foo\/requirements\.md, \.kiro\/specs\/foo\/tasks\.md, attached as context\)/);
  assert.match(update, /keep the user's edits/);
  assert.match(specTurnText("update", "tasks.md", { spec }), /Leave every task box/);
  assert.doesNotMatch(update, /Leave every task box/);
  assert.match(specTurnText("fix", "tasks.md", { spec, task: { number: "2.1", title: "Wire it" } }), /PHASE: FIX A FAILED TASK[\s\S]*\n\n2\.1 Wire it\n\n/);
  const full = { text: "2.1 Wire it", id: "2.1 Wire it", status: "not_started", content: "", subTasks: [], optional: false };
  assert.match(specTurnText("fix", "tasks.md", { spec, task: full }), /<task title="2\.1 Wire it">/);
  assert.match(specTurnText("review", "requirements.md", { spec, body: "> quoted\nmake it shorter" }), /PHASE: APPLY REVIEW COMMENTS to \.kiro\/specs\/foo\/requirements\.md\.\n\n> quoted\nmake it shorter$/);
  assert.throws(() => specTurnText("review", "requirements.md", { spec }), /needs its comments/);
  assert.throws(() => specTurnText("polish", "requirements.md", { spec }), /unknown spec turn kind/);
  for (const kind of SPEC_TURN_KINDS) assert.match(specTurnText(kind, "requirements.md", { spec, idea: "i", task: { title: "t" }, body: "b" }), /^You are executing the Kiro spec-driven workflow for the spec at \.kiro\/specs\/foo/);
});

test("specTurnDisplay and specTurnTitle: short labels, the idea titles a new spec", () => {
  const spec = specOf();
  assert.equal(specTurnDisplay("update", "design.md", { spec }), "Sync design with project files");
  assert.equal(specTurnDisplay("generate", "/w/.kiro/specs/foo/tasks.md", { spec }), "Generate tasks");
  assert.equal(specTurnDisplay("create", "requirements.md", { spec }), "Create spec: foo");
  assert.equal(specTurnDisplay("fix", "tasks.md", { spec, task: { id: "2.1", title: "Wire it" } }), "Fix task 2.1: Wire it");
  assert.equal(specTurnDisplay("review", "requirements.md", { spec }), "Review: requirements");
  assert.equal(specTurnTitle("generate", "design", { spec }), "spec foo: design");
  assert.equal(specTurnTitle("create", "requirements.md", { spec, idea: "  Dark   mode\nfor the editor " }), "Dark mode for the editor");
  assert.equal(specTurnTitle("create", "requirements.md", { spec }), "spec foo: requirements");
});

test("specTabRecord and specTabMatches: a tab is found by its run record or its spec record", () => {
  assert.deepEqual(specTabRecord({ name: "foo", dir: { path: "/w/.kiro/specs/foo" } }), { name: "foo", dir: "/w/.kiro/specs/foo" });
  assert.deepEqual(specTabRecord("foo"), { name: "foo", dir: null });
  assert.equal(specTabRecord(null), null);
  assert.equal(specTabRecord({ dir: "/x" }), null);
  const byRun = { key: "k", run: { spec: "foo", dir: "/w/.kiro/specs/foo" } };
  const bySpec = { key: "k", spec: { name: "foo", dir: "/local/w/.kiro/specs/foo" } };
  assert.equal(specTabMatches(byRun, "foo", "/w/.kiro/specs/foo"), true);
  assert.equal(specTabMatches(byRun, "foo", "/other/.kiro/specs/foo"), false);
  assert.equal(specTabMatches(byRun, "bar", undefined), false);
  assert.equal(specTabMatches(bySpec, "foo", undefined), true);
  assert.equal(specTabMatches({ key: "k" }, "foo", undefined), false);
});

// ---- kirocrew.spec.viewSession: argument shapes and the task → feature fallback (requirement 13.2)

const { viewSessionTarget, resolveViewSessionLink } = ext.__test;

test("viewSessionTarget: a Specs view node (spec or task row) and a plain {feature, dir, taskId} both resolve; anything else is null", () => {
  const spec = { name: "foo", dir: { path: "/w/.kiro/specs/foo" } };
  assert.deepEqual(viewSessionTarget({ spec, contextValue: "spec" }), { feature: "foo", dir: "/w/.kiro/specs/foo", taskId: null });
  assert.deepEqual(viewSessionTarget({ spec, task: { id: "2.1", title: "t" }, contextValue: "task-open" }), { feature: "foo", dir: "/w/.kiro/specs/foo", taskId: "2.1" });
  assert.deepEqual(viewSessionTarget({ feature: "foo", dir: "/w/.kiro/specs/foo", taskId: "2.1" }), { feature: "foo", dir: "/w/.kiro/specs/foo", taskId: "2.1" });
  assert.deepEqual(viewSessionTarget({ feature: "foo" }), { feature: "foo", dir: null, taskId: null });
  assert.equal(viewSessionTarget(null), null);
  assert.equal(viewSessionTarget({ path: "/w/.kiro/specs/foo/tasks.md" }), null);
  assert.equal(viewSessionTarget({ spec: { dir: "/x" } }), null);
});

test("resolveViewSessionLink: the task's latest link wins, the feature's latest is the fallback, links without a session do not count", () => {
  const dir = "/w/.kiro/specs/foo";
  const links = [
    { id: "a", feature: "foo", dir, taskIds: ["1", "2"], sessionId: "s-all", startedAt: 100 },
    { id: "b", feature: "foo", dir, taskIds: ["2"], sessionId: "s-two", startedAt: 200 },
    { id: "c", feature: "foo", dir, taskIds: ["3"], sessionId: "s-three", startedAt: 300, outcome: "error" },
    { id: "d", feature: "foo", dir, taskIds: ["4"], sessionId: null, startedAt: 400 },
    { id: "e", feature: "bar", dir: "/w/.kiro/specs/bar", taskIds: ["1"], sessionId: "s-bar", startedAt: 500 },
  ];
  // Task 2 ran twice; the newer run is the answer.
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir, taskId: "2" }).sessionId, "s-two");
  // Task 1 only ran in the run-all.
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir, taskId: "1" }).sessionId, "s-all");
  // Task 9 never ran: the feature's latest link with a session (c; d has none yet).
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir, taskId: "9" }).sessionId, "s-three");
  // Task 4's own run has no session yet: same fallback.
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir, taskId: "4" }).sessionId, "s-three");
  // A spec row (no task) is the feature's latest.
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir, taskId: null }).sessionId, "s-three");
  // Another directory of the same name, or a spec that never ran, has nothing.
  assert.equal(resolveViewSessionLink(links, { feature: "foo", dir: "/elsewhere/.kiro/specs/foo", taskId: "2" }), null);
  assert.equal(resolveViewSessionLink(links, { feature: "baz", dir: null, taskId: null }), null);
  assert.equal(resolveViewSessionLink(links, null), null);
  // A store (anything with all()) is read the same way.
  assert.equal(resolveViewSessionLink({ all: () => links }, { feature: "bar", dir: null, taskId: "1" }).sessionId, "s-bar");
});
