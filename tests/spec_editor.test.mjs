// node --test: the spec editor's pure pieces — markdown rendering, stage detection, continue logic.
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
  FileType: { Directory: 2, File: 1 },
  Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }), parse: (s) => ({ toString: () => s }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
  window: {}, commands: {}, StatusBarAlignment: { Left: 1 }, ConfigurationTarget: { Global: 1 },
};
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return "vscode-stub";
  return originalResolve.call(this, request, ...rest);
};
require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: stub };
const ext = require(path.join(here, "..", "extension", "extension.js"));
const { mdToHtml, stageOf, specNameOf, continueAction, specEditorHtml } = ext.__test;

test("stageOf and specNameOf read the spec path", () => {
  const s = stageOf("/ws/.kiro/specs/my-feature/design.md");
  assert.equal(s.label, "Design");
  assert.equal(s.n, 2);
  assert.equal(stageOf("/ws/.kiro/specs/my-feature/notes.md"), null);
  assert.equal(specNameOf("/ws/.kiro/specs/my-feature/tasks.md"), "my-feature");
});

test("mdToHtml renders headings, fences, checkbox lists, inline marks and escapes HTML", () => {
  const html = mdToHtml([
    "# Title", "Some **bold** and `code` here.", "", "```", "raw <tag> & stuff", "```",
    "- [x] 1. Done task", "- [ ] 2. Open task", "  - [-] 2.1 Partial", "- plain item", "> a quote", "---", "<script>alert(1)</script>",
  ].join("\n"));
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /raw &lt;tag&gt; &amp; stuff/);
  assert.match(html, /☑<\/span> 1\. Done task/);
  assert.match(html, /☐<\/span> 2\. Open task/);
  assert.match(html, /◪<\/span> 2\.1 Partial/);
  assert.match(html, /<blockquote><p>a quote<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.ok(!html.includes("<script>alert"), "html is escaped");
});

test("continueAction advances requirements → design → tasks → run all (resume) → optional → done", () => {
  const spec = { present: { "design.md": false, "tasks.md": false }, tasks: [] };
  const write = continueAction({ file: "requirements.md" }, spec);
  assert.deepEqual([write.label, write.command, write.open], ["Write design", "kirocrew.spec.design", undefined]);
  spec.present["design.md"] = true;
  // An existing successor OPENS the stage file — no chat is started (the label said "Open", the action must too).
  const open = continueAction({ file: "requirements.md" }, spec);
  assert.deepEqual([open.label, open.open], ["Open design", "design.md"]);
  assert.notEqual(open.command, "kirocrew.spec.design");
  assert.equal(continueAction({ file: "design.md" }, spec).label, "Write task list");
  spec.present["tasks.md"] = true;
  assert.deepEqual(continueAction({ file: "design.md" }, spec).open, "tasks.md");
  // tasks.md: the primary action is Kiro's "Run all tasks" — one session runs every remaining required
  // leaf task without stopping — never "run task N" (that is the ▶ on the row).
  spec.tasks = [
    { number: "1", title: "a", done: false, leaf: false, optional: false },
    { number: "1.1", title: "a1", done: false, leaf: true, optional: false },
    { number: "1.2", title: "a2", done: false, leaf: true, optional: false },
    { number: "2", title: "b", done: false, leaf: true, optional: true },
  ];
  const run = continueAction({ file: "tasks.md" }, spec);
  assert.deepEqual([run.label, run.command, run.remaining], ["Run all tasks (2 left)", "kirocrew.spec.runAll", 2]);
  spec.tasks[1].done = true;
  const resume = continueAction({ file: "tasks.md" }, spec);
  assert.deepEqual([resume.label, resume.command], ["Resume tasks (1 left)", "kirocrew.spec.runAll"]);
  spec.tasks[1].done = false; spec.tasks[1].partial = true;
  assert.equal(continueAction({ file: "tasks.md" }, spec).label, "Resume tasks (2 left)", "an in-progress mark also reads as started");
  spec.tasks[1].partial = false; spec.tasks[1].done = true; spec.tasks[2].done = true;
  const opt = continueAction({ file: "tasks.md" }, spec);
  assert.deepEqual([opt.label, opt.command], ["Run optional tasks (1)", "kirocrew.spec.runAllOptional"], "only optional work left");
  spec.tasks[3].done = true;
  assert.equal(continueAction({ file: "tasks.md" }, spec).command, null);
});

test("mdToHtml renders Kiro's four task states and the optional mark, each box carrying its source line", () => {
  const html = mdToHtml(["- [ ] 1. Open", "- [~] 2. Queued", "- [-] 3. Running", "- [x] 4. Done", "- [ ]* 5. Optional", "- [X]\\* 6. Done optional"].join("\n"));
  assert.match(html, /<span class="box open" data-line="0">☐<\/span> 1\. Open/);
  assert.match(html, /<span class="box queued" data-line="1">◷<\/span> 2\. Queued/);
  assert.match(html, /<span class="box part" data-line="2">◪<\/span> 3\. Running/);
  assert.match(html, /<span class="box on" data-line="3">☑<\/span> 4\. Done/);
  assert.match(html, /<span class="box open optional" data-line="4" title="optional task">☐<\/span> 5\. Optional/);
  assert.match(html, /<span class="box on optional" data-line="5" title="optional task">☑<\/span> 6\. Done optional/, "the escaped star is the optional mark too");
  assert.ok(!html.includes("*"), "the optional mark is not left in the text");
});

test("the editor html carries the three stages with the current one marked and missing ones greyed", () => {
  const html = specEditorHtml("my-feature", { file: "design.md" }, { "requirements.md": true, "design.md": true, "tasks.md": false });
  assert.match(html, /class='stage' data-file='requirements\.md'/);
  assert.match(html, /class='stage on' data-file='design\.md'/);
  assert.match(html, /class='stage missing' data-file='tasks\.md'/);
  assert.ok(html.includes("Sync Files") && html.includes("Continue") && html.includes("Edit source"));
  assert.match(html, /const STAGE_FILE = "design\.md";/);
});

test("the editor's script parses and, on tasks.md, hangs a Start task on open rows and a state on queued/running ones", async () => {
  const vm = await import("node:vm");
  const html = specEditorHtml("my-feature", { file: "tasks.md" }, { "requirements.md": true, "design.md": true, "tasks.md": true });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script), "the inline script is valid JavaScript");
  assert.match(script, /STAGE_FILE!=='tasks\.md'\) return/, "other stages get no task buttons");
  assert.match(script, /postMessage\(\{type:'startTask', line:Number\(a\.dataset\.line\)\}\)/, "a Start posts the row's source line");
  assert.match(script, /'▶ Start task'/);
  assert.match(script, /'In progress'[\s\S]*'Queued'/);
  assert.match(script, /if\(box\.classList\.contains\('on'\)\) return;/, "done rows get nothing");
});

test("mdToHtml (GFM): tables, ordered/nested lists, fenced code with lang + copy, links, autolinks, strikethrough, file-path anchors", () => {
  const html = mdToHtml([
    "Fixed `src/app/main.py:42` and hook/__init__.py — see [docs](https://docs.example.invalid/x) and [t](tests/a.py:7).",
    "Plain https://docs.example.invalid/icon.svg and ~~gone~~ and ***both***.",
    "", "1. one", "   cont", "2. two", "   - nested", "   - [x] done", "3. three", "",
    "| Col | Val |", "|:----|----:|", "| a \\| b | 1 |", "",
    "```python", "x = a < b and `t`", "```",
  ].join("\n"));
  assert.match(html, /<code><a class="path" data-path="src\/app\/main\.py" data-line="42"[^>]*>src\/app\/main\.py:42<\/a><\/code>/, "path inside inline code");
  assert.match(html, /<a class="path" data-path="hook\/__init__\.py"[^>]*>hook\/__init__\.py<\/a>/, "underscores in a path are not emphasis");
  assert.match(html, /<a class="link" data-url="https:\/\/docs\.example\.invalid\/x"[^>]*>docs<\/a>/);
  assert.match(html, /<a class="path" data-path="tests\/a\.py" data-line="7"[^>]*>t<\/a>/, "relative link target opens in the editor");
  assert.match(html, /<a class="link" data-url="https:\/\/docs\.example\.invalid\/icon\.svg">/, "bare URL autolinked");
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<strong><em>both<\/em><\/strong>/);
  assert.match(html, /<ol>\n<li>one\ncont\n<\/li>\n<li>two\n<ul>\n<li>nested\n<\/li>\n<li><span class="box on" data-line="7">☑<\/span> done\n<\/li><\/ul>\n<\/li>\n<li>three\n<\/li><\/ol>/, "nested ordered/bulleted lists");
  assert.match(html, /<table><thead><tr><th style="text-align:left">Col<\/th><th style="text-align:right">Val<\/th>/);
  assert.match(html, /<td style="text-align:left">a \| b<\/td>/, "escaped pipe inside a cell");
  assert.match(html, /<span class="lang">python<\/span><button class="copy"/);
  assert.match(html, /<code class="lang-python">x = a &lt; b and `t`<\/code>/, "code body escaped, not inline-parsed");
  assert.ok(!/<a [^>]*href=/.test(html), "no hrefs: anchors are data-* and delegated to the host");
});
