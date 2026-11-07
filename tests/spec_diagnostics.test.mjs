// node --test: task format diagnostics (requirement 5.1), "Fix task line"
// (5.2) and the no-task-lines case (5.3): one `taskFormatIssues` case per
// rule with line/column range, level and parent; `fixTaskLine` output per
// fixable rule, the nesting-only line left alone, byte-identical titles,
// non-colliding sequential fixes, bare top-level style; one preferred
// `SpecTaskFixProvider` action per flagged line. Same stub `vscode` module as
// spec_task_state.test.mjs.
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
  SPEC_TASK_DIAGNOSTICS, TASK_FORMAT_RULES, TASK_FORMAT_BOXES, TASK_FORMAT_LINE,
  taskFormatIssues, toTaskDiagnostic, SpecTaskDiagnostics,
  TASK_FIX_TITLE, TASK_FIX_NUMBER_RULES, fixTaskLine, SpecTaskFixProvider,
} = ext.__test;

const TASKS_PATH = "/w/.kiro/specs/foo/tasks.md";
const doc = (text, p = TASKS_PATH) => ({ uri: { path: p, toString: () => "file://" + p }, getText: () => text });
const rulesOf = (issues) => issues.map((i) => i.rule);
const only = (issues, rule) => { const r = issues.filter((i) => i.rule === rule); assert.equal(r.length, 1, "exactly one " + rule); return r[0]; };

/** One sample covering every rule: line 3 box, 4 box+number-missing, 5 number-format, 6 number-missing+nesting, 7 duplicate, 10 box+number-missing (optional, tab); 2, 8, 9, 11 clean. */
const SAMPLE = [
  "# Plan", "", "- [ ] 1. First", "  - [o] 1.1 Bad box", "  - [] Missing", "  - [ ] 1a Malformed", "      - [ ] Deep jump", "  - [ ] 1.1 Dup",
  "- [ ]* 2. Second  ", "  - [ ] 2.1 Fine", "  - [?]* No number here\t", "- [X] 3. Done", "", "See [link](http://x) and - [text](url) are not tasks.",
].join("\n");

// ---- taskFormatIssues: one case per rule (5.1)

test("TASK_FORMAT_RULES, TASK_FORMAT_BOXES and the line pattern are what the design names", () => {
  assert.deepEqual(TASK_FORMAT_RULES, ["box", "number-missing", "number-format", "nesting", "duplicate"]);
  assert.deepEqual(TASK_FORMAT_BOXES, [" ", "~", "-", "x", "X"]);
  assert.deepEqual(TASK_FIX_NUMBER_RULES, ["number-missing", "number-format", "duplicate"]);
  assert.equal(SPEC_TASK_DIAGNOSTICS, "kirocrew-spec");
  assert.ok(!TASK_FORMAT_LINE.test("- [text](url)"), "a link bullet is not a task line");
});

test("box: an unknown box character is flagged at the box's column range", () => {
  const issue = only(taskFormatIssues(SAMPLE).filter((i) => i.line === 3), "box");
  assert.deepEqual([issue.startCol, issue.endCol, issue.box, issue.number, issue.title], [4, 7, "o", "1.1", "Bad box"]);
});

test("every accepted box (including X) passes the box rule", () => {
  for (const box of TASK_FORMAT_BOXES) assert.deepEqual(taskFormatIssues("- [" + box + "] 1. Title"), [], "box [" + box + "]");
});

test("number-missing: a title without a number is flagged over the title", () => {
  const line = SAMPLE.split("\n")[4];
  const issues = taskFormatIssues(SAMPLE).filter((i) => i.line === 4);
  assert.deepEqual(rulesOf(issues), ["box", "number-missing"], "`- []` breaks two rules");
  const box = only(issues, "box");
  assert.deepEqual([box.startCol, box.endCol], [4, 6], "an empty box still has a non-empty range");
  const missing = only(issues, "number-missing");
  assert.deepEqual([missing.startCol, missing.endCol, missing.number, missing.title], [line.indexOf("Missing"), line.length, null, "Missing"]);
});

test("number-format: a token that starts with a digit but is not N(.M)* is flagged over the token", () => {
  const issue = only(taskFormatIssues("- [ ] 1. A\n  - [ ] 1a Bad"), "number-format");
  assert.deepEqual([issue.line, issue.startCol, issue.endCol, issue.number, issue.title], [1, 8, 10, null, "Bad"]);
  assert.deepEqual(rulesOf(taskFormatIssues("- [ ] 1. A\n  - [ ] 1.2 B\n    - [ ] 1.2.3 C")), [], "N.M.K is a valid shape");
});

test("nesting: a jump of two levels is flagged over the whole line, one level is fine", () => {
  const jump = "- [ ] 1. A\n    - [ ] 1.1.1 Deep";
  const issue = only(taskFormatIssues(jump), "nesting");
  assert.deepEqual([issue.line, issue.startCol, issue.endCol], [1, 4, jump.split("\n")[1].length]);
  assert.match(issue.message, /level 1 to level 3/);
  assert.deepEqual(taskFormatIssues("- [ ] 1. A\n  - [ ] 1.1 B\n    - [ ] 1.1.1 C\n- [ ] 2. D"), [], "stepping one level at a time");
  assert.equal(only(taskFormatIssues("  - [ ] 1.1 Starts nested"), "nesting").level, 2, "the first line counts from level 0");
});

test("duplicate: a repeated number is flagged over the number and names the first line", () => {
  const issue = only(taskFormatIssues(SAMPLE).filter((i) => i.line === 7), "duplicate");
  assert.deepEqual([issue.startCol, issue.endCol], [8, 11]);
  assert.match(issue.message, /"1\.1".*line 4/);
  const top = only(taskFormatIssues("- [ ] 1. A\n- [ ] 1. B"), "duplicate");
  assert.deepEqual([top.line, top.startCol, top.endCol], [1, 6, 8], "the `1.` token with its dot");
});

test("level and parent on numbered and unnumbered lines", () => {
  const issues = taskFormatIssues(SAMPLE);
  const at = (line, rule) => only(issues.filter((i) => i.line === line), rule);
  assert.deepEqual([at(3, "box").level, at(3, "box").parent], [2, "1"], "numbered: parent is the number minus its last segment");
  assert.deepEqual([at(4, "number-missing").level, at(4, "number-missing").parent], [2, "1"], "unnumbered: level from indent, parent the last number one level up");
  assert.deepEqual([at(10, "box").level, at(10, "box").parent], [2, "2"]);
  assert.equal(at(10, "box").optional, true);
  const top = only(taskFormatIssues("- [ ] 1. A\n- [ ] Top missing"), "number-missing");
  assert.deepEqual([top.level, top.parent], [1, null]);
});

test("the sample yields exactly the expected (line, rule) pairs in line order", () => {
  assert.deepEqual(taskFormatIssues(SAMPLE).map((i) => [i.line, i.rule]), [
    [3, "box"], [4, "box"], [4, "number-missing"], [5, "number-format"],
    [6, "number-missing"], [6, "nesting"], [7, "duplicate"], [10, "box"], [10, "number-missing"],
  ]);
  for (const i of taskFormatIssues(SAMPLE)) assert.ok(TASK_FORMAT_RULES.includes(i.rule) && i.endCol > i.startCol && i.text === SAMPLE.split("\n")[i.line]);
});

// ---- no task lines (5.3) and a clean file

test("a file without task lines yields no issues", () => {
  assert.deepEqual(taskFormatIssues(""), []);
  assert.deepEqual(taskFormatIssues("# Heading\n\nProse here.\n\n- [link](http://x)\n- plain bullet\n* another\n"), []);
  assert.deepEqual(taskFormatIssues(null), []);
});

test("a clean real-world plan has no issues (CRLF included)", () => {
  const clean = [
    "# Implementation Plan", "", "- [x] 1. Set up the project", "  - [x] 1.1 Create the package", "    - _Requirements: 1.1_",
    "  - [~] 1.2 Add the config", "- [-] 2. Build the view", "  - [ ]* 2.1 Optional polish", "  - [ ] 2.2 Wire the commands", "- [ ] 3. Checkpoint",
  ];
  assert.deepEqual(taskFormatIssues(clean.join("\n")), []);
  assert.deepEqual(taskFormatIssues(clean.join("\r\n")), []);
});

// ---- toTaskDiagnostic and SpecTaskDiagnostics

test("toTaskDiagnostic: a Warning whose code is the rule and source kirocrew-spec", () => {
  const issue = only(taskFormatIssues(SAMPLE).filter((i) => i.line === 3), "box");
  const diag = toTaskDiagnostic(issue);
  assert.equal(diag.severity, 1, "DiagnosticSeverity.Warning");
  assert.equal(diag.code, "box");
  assert.equal(diag.source, SPEC_TASK_DIAGNOSTICS);
  assert.deepEqual(diag.range, { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } });
});

test("SpecTaskDiagnostics.update: only a spec tasks.md, entry present while flagged and dropped when clean", () => {
  const sd = new SpecTaskDiagnostics(null);
  assert.equal(sd.update(doc("- [o] 1. x", "/w/README.md")), false, "not a spec file");
  assert.equal(sd.update(doc("- [o] 1. x", "/w/.kiro/specs/foo/requirements.md")), false, "a spec file that is not tasks.md");
  const uri = doc("", TASKS_PATH).uri;
  assert.equal(sd.update(doc("- [o] 1. x")), true);
  assert.deepEqual(sd.collection.get(uri).map((d) => d.code), ["box"]);
  assert.equal(sd.update(doc("- [ ] 1. x")), true);
  assert.equal(sd.collection.has(uri), false, "a clean document has no entry");
  sd.update(doc("- [o] 1. x"));
  assert.equal(sd.update(doc("# Heading only")), true);
  assert.equal(sd.collection.has(uri), false, "no task lines publishes nothing (5.3)");
  sd.dispose();
});

// ---- fixTaskLine: the fix output for each rule (5.2)

test("fix box: the unknown box becomes [ ], number and title untouched", () => {
  assert.deepEqual(fixTaskLine(SAMPLE, 3), { newLine: "  - [ ] 1.1 Bad box", changed: ["box"] });
});

test("fix number-missing: parent + next free sibling index; the bad box on the same line is fixed too", () => {
  assert.deepEqual(fixTaskLine(SAMPLE, 4), { newLine: "  - [ ] 1.2 Missing", changed: ["number-missing", "box"] });
  assert.deepEqual(fixTaskLine("- [ ] 1. A\n- [ ] Top missing", 1), { newLine: "- [ ] 2. Top missing", changed: ["number-missing"] });
});

test("fix number-format: the malformed token is replaced, the rest of the title kept", () => {
  assert.deepEqual(fixTaskLine("- [ ] 1. A\n  - [ ] 1a Bad", 1), { newLine: "  - [ ] 1.1 Bad", changed: ["number-format"] });
  assert.deepEqual(fixTaskLine("- [ ] 1. A\n  - [ ] 1.1 Ok\n  - [ ] 1a Bad", 2), { newLine: "  - [ ] 1.2 Bad", changed: ["number-format"] });
});

test("fix duplicate: the repeated number becomes the next index under the same parent, nested and top-level", () => {
  assert.deepEqual(fixTaskLine(SAMPLE, 7), { newLine: "  - [ ] 1.2 Dup", changed: ["duplicate"] });
  assert.deepEqual(fixTaskLine("- [ ] 1. A\n- [ ] 1. B", 1), { newLine: "- [ ] 2. B", changed: ["duplicate"] });
});

test("nesting only: the line is left as it is with changed []", () => {
  const text = "- [ ] 1. A\n    - [ ] 1.1.1 Deep";
  assert.deepEqual(fixTaskLine(text, 1), { newLine: "    - [ ] 1.1.1 Deep", changed: [] });
  assert.deepEqual(fixTaskLine(text, 0), { newLine: "- [ ] 1. A", changed: [] }, "a clean line is unchanged");
  const jumpMissing = fixTaskLine(SAMPLE, 6);
  assert.deepEqual(jumpMissing.changed, ["number-missing"], "a nesting jump still gets its number fixed");
  assert.equal(jumpMissing.newLine, "      - [ ] 4. Deep jump", "the indent is kept, the parent resolves to the top");
});

test("fix keeps the optional marker, indent, trailing whitespace and title byte for byte", () => {
  assert.deepEqual(fixTaskLine(SAMPLE, 10), { newLine: "  - [ ]* 2.2 No number here\t", changed: ["number-missing", "box"] });
  assert.deepEqual(fixTaskLine("- [ ] 1. A\n\t- [o]*\t\t1.1   Title  with   spaces  ", 1), { newLine: "\t- [ ]*\t\t1.1   Title  with   spaces  ", changed: ["box"] });
  const escaped = fixTaskLine("- [ ] 1. A\n- [o]\\* 2. B", 1);
  assert.equal(escaped.newLine, "- [ ]\\* 2. B", "the escaped optional marker survives");
});

test("sequential fixes under one parent do not collide", () => {
  const lines = ["- [ ] 1. A", "  - [ ] 1.1 Ok", "  - [ ] 1.1 Dup", "  - [ ] Missing"];
  const first = fixTaskLine(lines.join("\n"), 2);
  assert.equal(first.newLine, "  - [ ] 1.2 Dup");
  lines[2] = first.newLine;
  const second = fixTaskLine(lines.join("\n"), 3);
  assert.equal(second.newLine, "  - [ ] 1.3 Missing");
  lines[3] = second.newLine;
  assert.deepEqual(taskFormatIssues(lines.join("\n")), [], "the file is clean after both fixes");
});

test("top-level numbering follows the file's style: bare N when the file writes them bare, N. otherwise", () => {
  assert.equal(fixTaskLine("- [ ] 1 One\n- [ ] 2 Two\n- [ ] Three", 2).newLine, "- [ ] 3 Three");
  assert.equal(fixTaskLine("- [ ] 1. One\n- [ ] 2. Two\n- [ ] Three", 2).newLine, "- [ ] 3. Three");
  assert.equal(fixTaskLine("- [ ] Only", 0).newLine, "- [ ] 1. Only", "no numbers yet: Kiro's `N.` style");
  assert.equal(fixTaskLine("- [ ] 1 One\n  - [ ] Child", 1).newLine, "  - [ ] 1.1 Child", "nested numbers are always N.M");
});

// ---- SpecTaskFixProvider under the stub

test("provideCodeActions: one preferred 'Fix task line' per flagged line, none for the nesting-only line", () => {
  const text = SAMPLE + "\n- [ ] 4. Fourth\n    - [ ] 4.1.1 Jump only";
  const diagnostics = taskFormatIssues(text).map(toTaskDiagnostic);
  const document = doc(text);
  const actions = new SpecTaskFixProvider().provideCodeActions(document, null, { diagnostics });
  assert.deepEqual(actions.map((a) => a.edit.entries()[0][1][0].range.start.line), [3, 4, 5, 6, 7, 10], "line 16 (nesting only) has no action");
  for (const a of actions) {
    assert.equal(a.title, "Fix task line");
    assert.equal(TASK_FIX_TITLE, a.title);
    assert.equal(a.isPreferred, true);
    assert.equal(a.kind, "quickfix");
    const [uri, [edit]] = a.edit.entries()[0];
    assert.equal(uri, document.uri);
    assert.equal(edit.range.start.character, 0);
    assert.equal(edit.range.end.character, text.split("\n")[edit.range.start.line].length, "the whole line is replaced");
    assert.equal(edit.newText, fixTaskLine(text, edit.range.start.line).newLine);
  }
  assert.deepEqual(actions[1].diagnostics.map((d) => d.code).sort(), ["box", "number-missing"], "one action carries both diagnostics of `- []`");
  assert.deepEqual(actions[3].diagnostics.map((d) => d.code), ["number-missing"], "the nesting diagnostic is not claimed by the fix");
});

test("provideCodeActions: filters by range and by source, empty without diagnostics", () => {
  const diagnostics = taskFormatIssues(SAMPLE).map(toTaskDiagnostic);
  const provider = new SpecTaskFixProvider();
  const cursor = (line, ch) => ({ start: { line, character: ch }, end: { line, character: ch } });
  const atLine7 = provider.provideCodeActions(doc(SAMPLE), cursor(7, 9), { diagnostics });
  assert.equal(atLine7.length, 1, "a cursor inside the duplicate number");
  assert.equal(atLine7[0].edit.entries()[0][1][0].newText, "  - [ ] 1.2 Dup");
  assert.deepEqual(provider.provideCodeActions(doc(SAMPLE), cursor(7, 1), { diagnostics }), [], "a cursor on the bullet touches no diagnostic");
  assert.deepEqual(provider.provideCodeActions(doc(SAMPLE), null, {}), []);
  const foreign = diagnostics.map((d) => ({ ...d, source: "eslint" }));
  assert.deepEqual(provider.provideCodeActions(doc(SAMPLE), null, { diagnostics: foreign }), [], "other sources' diagnostics are ignored");
});
