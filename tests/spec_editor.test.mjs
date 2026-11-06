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
const { mdToHtml, stageOf, specNameOf, continueAction, specEditorHtml, isSpecDocument, openSpecPreview, markSpecEditor, renderMarkdown, localizeImages } = ext.__test;

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
  // A `[-]` / `[~]` mark is a run's own trace left behind: the primary action resumes THAT run
  // (in its session when the tab is still open), through kirocrew.spec.resume.
  spec.tasks[1].done = false; spec.tasks[1].partial = true;
  const interrupted = continueAction({ file: "tasks.md" }, spec);
  assert.deepEqual([interrupted.label, interrupted.command, interrupted.interrupted], ["Resume run (2 left)", "kirocrew.spec.resume", true], "an in-progress mark is an interrupted run");
  spec.tasks[1].partial = false; spec.tasks[2].queued = true;
  assert.equal(continueAction({ file: "tasks.md" }, spec).command, "kirocrew.spec.resume", "a queued mark too");
  spec.tasks[2].queued = false; spec.tasks[1].done = true; spec.tasks[2].done = true;
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
  assert.match(script, /if\(box\.classList\.contains\('on'\) \|\| Number\(box\.dataset\.line\)<0\) return;/, "done rows (and rows with no source line) get nothing");
  // The page dresses what the engine's renderer hands it: a bar with language + Copy on every
  // <pre><code class="language-x">, Kiro's task boxes carrying the SOURCE LINE (k-th task row ↔
  // k-th parsed task), and mermaid fences drawn when the vendored library is on the page.
  assert.match(script, /function dressCode\(\)/);
  assert.match(script, /l\.textContent=lang\|\|'text'/, "language label, 'text' when the fence named none");
  assert.match(script, /c\.textContent='Copy'/);
  assert.match(script, /function dressTasks\(\)[\s\S]*const task=tasks\[k\+\+\]/, "task rows map to the parsed tasks in order");
  assert.match(script, /box\.dataset\.line=String\(task\?task\.line:-1\)/);
  assert.match(script, /if\(!window\.mermaid\)\{ blocks\.forEach/, "no library: the fence stays a code block");
  assert.match(script, /window\.mermaid\.render\(/);
  // Plain anchors from the renderer: schemes open externally, '#' scrolls, anything else is a path relative to the spec dir.
  assert.match(script, /relative:true/);
});

test("find in the document: a bar in the banner, every match marked, Enter/Shift+Enter walk them, Esc closes; the task filter only on tasks.md; the host's 'find' message opens it", async () => {
  const vm = await import("node:vm");
  const html = specEditorHtml("my-feature", { file: "tasks.md" }, { "requirements.md": true, "design.md": true, "tasks.md": true });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(/<div id="find" role="search" hidden>/.test(html) && /id="findbtn"/.test(html), "the bar (hidden until asked) and a Find button in the actions");
  for (const id of ["findtext", "findcount", "findprev", "findnext", "findcase", "findfilter", "findclose"]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /#find\{flex:1 0 100%/, "the bar wraps onto its own row of the sticky banner");
  assert.match(html, /mark\.hit\{background:var\(--vscode-editor-findMatchHighlightBackground/, "matches use the editor's find colours");
  assert.match(html, /mark\.hit\.cur\{background:var\(--vscode-editor-findMatchBackground/);
  assert.match(html, /#doc li\.find-hide\{display:none\}/);
  // The keys: Ctrl/Cmd+F opens (the host already prevents the browser's own find), F3 walks, Esc closes.
  assert.match(script, /\(e\.ctrlKey\|\|e\.metaKey\) && !e\.altKey && \(e\.key==='f'\|\|e\.key==='F'\)\)\{ e\.preventDefault\(\); findOpen\(\)/);
  assert.match(script, /if\(e\.key==='Enter'\)\{ e\.preventDefault\(\); findGo\(e\.shiftKey\?-1:1\); \}/);
  assert.match(script, /e\.key==='Escape'\)\{ e\.preventDefault\(\); findClose\(\)/);
  assert.match(script, /if\(e\.key==='F3'\)/);
  assert.match(script, /if\(m\.type==='find'\)\{ findOpen\(\); \}/, "the extension's keybinding reaches the page as a message");
  // Matching: text nodes only, never inside drawn diagrams or the page's own labels; capped; regex metacharacters escaped.
  assert.match(script, /p\.closest\('svg, script, style, \.codebar, button\.start, \.box, \.mermaid-error'\)\) return NodeFilter\.FILTER_REJECT/);
  assert.match(script, /const FIND_CAP = 2000;/);
  assert.match(script, /function findEscape\(s\)\{ return s\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g, '\\\\\$&'\); \}/, "the escape regex survives the template literal");
  assert.match(script, /find\.cs \? 'g' : 'gi'/, "case-insensitive unless Aa is pressed");
  // Re-run on a document refresh, keeping the current match; marks are removed on close and the nodes re-joined.
  assert.match(script, /if\(!find\.bar\.hidden\) findRun\(true\);/);
  assert.match(script, /p\.replaceChild\(document\.createTextNode\(m\.textContent\), m\); p\.normalize\(\);/);
  // The task filter is shown on tasks.md only, and a row survives when a parent or sub-task matches.
  assert.match(script, /if\(STAGE_FILE==='tasks\.md'\) findBtn\('findfilter'\)\.hidden=false;/);
  assert.match(script, /if\(li\.querySelector\('mark\.hit'\)\) return;[\s\S]*if\(own\.has\(a\)\) return;[\s\S]*li\.classList\.add\('find-hide'\)/);
  const design = specEditorHtml("my-feature", { file: "design.md" }, { "requirements.md": true, "design.md": true, "tasks.md": true });
  assert.ok(design.includes('id="findfilter" class="filter"') && design.includes("hidden>Filter tasks"), "the filter button is in the markup for every stage, hidden; only tasks.md reveals it");
});

test("SpecEditorProvider.findInActive posts `find` to the active spec editor only", async () => {
  const { SpecEditorProvider } = ext.__test;
  const provider = new SpecEditorProvider({ extensionUri: { path: "/ext" } });
  assert.equal(provider.findInActive(), false, "no editor open: nothing to post, says so");
  const posted = [];
  const panel = (active) => { const disposers = []; return { active, webview: { postMessage: (m) => posted.push([active, m]) }, onDidDispose: (fn) => disposers.push(fn), dispose: () => disposers.forEach((fn) => fn()) }; };
  const a = panel(false), b = panel(true);
  provider.panels.add(a); a.onDidDispose(() => provider.panels.delete(a));
  provider.panels.add(b); b.onDidDispose(() => provider.panels.delete(b));
  assert.equal(provider.findInActive(), true);
  assert.deepEqual(posted, [[true, { type: "find" }]], "only the active panel is asked");
  b.dispose();
  assert.equal(provider.panels.size, 1, "a closed editor leaves the set");
  assert.equal(provider.findInActive(), false, "the remaining editor is not active");
});

test("the page loads the vendored mermaid only when the hook put it there", () => {
  const stage = { file: "design.md" }; const present = { "requirements.md": true, "design.md": true, "tasks.md": false };
  const with_ = specEditorHtml("s", stage, present, { mermaid: "https://webview.invalid/media/mermaid.min.js" });
  assert.match(with_, /<script src="https:\/\/webview\.invalid\/media\/mermaid\.min\.js"><\/script>/);
  const without = specEditorHtml("s", stage, present, { mermaid: null });
  assert.ok(!/<script src=/.test(without), "no library, no script tag");
  assert.ok(!/<script src=/.test(specEditorHtml("s", stage, present)), "callers that pass no assets");
  // highlight.js classes the engine's renderer emits have colours for each theme kind
  for (const cls of ["hljs-keyword", "hljs-string", "hljs-comment", "hljs-title", "hljs-number"]) assert.ok(with_.includes("." + cls), cls);
  assert.match(with_, /body\.vscode-light \.hljs-keyword/);
});

test("isSpecDocument: only the three spec files under .kiro/specs/<name>/", () => {
  assert.equal(isSpecDocument("/ws/.kiro/specs/my-feature/tasks.md"), true);
  assert.equal(isSpecDocument("C:\\ws\\.kiro\\specs\\x\\design.md"), true);
  assert.equal(isSpecDocument("/ws/.kiro/specs/my-feature/notes.md"), false);
  assert.equal(isSpecDocument("/ws/.kiro/specs/tasks.md"), false, "a spec needs its own directory");
  assert.equal(isSpecDocument("/ws/docs/tasks.md"), false);
});

test("openSpecPreview: a spec file opens the Kiro spec editor (beside when asked); any other file keeps the built-in preview", async () => {
  const calls = [];
  stub.commands.executeCommand = async (...a) => { calls.push(a); };
  stub.ViewColumn = { Beside: -2 };
  stub.window.activeTextEditor = { document: { uri: { path: "/ws/.kiro/specs/f/design.md" } } };
  await openSpecPreview(undefined, false);
  assert.deepEqual(calls.pop(), ["vscode.openWith", stub.window.activeTextEditor.document.uri, "kirocrew.spec", undefined]);
  await openSpecPreview({ path: "/ws/.kiro/specs/f/tasks.md" }, true);
  assert.deepEqual(calls.pop(), ["vscode.openWith", { path: "/ws/.kiro/specs/f/tasks.md" }, "kirocrew.spec", -2]);
  await openSpecPreview({ path: "/ws/README.md" }, true);
  assert.deepEqual(calls.pop(), ["markdown.showPreviewToSide", { path: "/ws/README.md" }]);
  // While a spec file's source is active, the built-in preview button steps aside (its own context key).
  markSpecEditor({ document: { uri: { path: "/ws/.kiro/specs/f/tasks.md" } } });
  assert.deepEqual(calls.splice(-2), [["setContext", "hasCustomMarkdownPreview", true], ["setContext", "kirocrew.specFile", "tasks.md"]]);
  markSpecEditor({ document: { uri: { path: "/ws/src/a.py" } } });
  assert.deepEqual(calls.splice(-2), [["setContext", "hasCustomMarkdownPreview", false], ["setContext", "kirocrew.specFile", ""]]);
  markSpecEditor(undefined);
  assert.equal(calls.length, 0, "a webview becoming active leaves the keys alone");
  delete stub.window.activeTextEditor;
});

test("renderMarkdown: the engine's own renderer when its command exists, mdToHtml otherwise; relative images point into the spec dir", async () => {
  stub.commands.getCommands = async () => ["markdown.api.render"];
  stub.commands.executeCommand = async (cmd, text) => { assert.equal(cmd, "markdown.api.render"); return "<p>" + text + "</p><pre><code class=\"language-js\"><span class=\"hljs-keyword\">const</span></code></pre>"; };
  const builtin = await renderMarkdown("hi");
  assert.equal(builtin.engine, "builtin");
  assert.match(builtin.html, /hljs-keyword/);
  stub.commands.executeCommand = async () => { throw new Error("gone"); };
  const fallback = await renderMarkdown("# T\n\n- [ ] 1. a");
  assert.equal(fallback.engine, "own");
  assert.match(fallback.html, /<h1>T<\/h1>/);
  assert.match(fallback.html, /class="box open" data-line="2"/, "the own renderer boxes task rows itself");
  const webview = { asWebviewUri: (u) => ({ toString: () => "https://wv.invalid" + u.path }) };
  const dir = { path: "/ws/.kiro/specs/f" };
  const out = localizeImages('<img src="diagrams/a.png"> <img src="https://x.invalid/b.png"> <img src="/abs.png"> <img alt="z" src="data:image/png;base64,AA">', dir, webview);
  assert.match(out, /<img src="https:\/\/wv\.invalid\/ws\/\.kiro\/specs\/f\/diagrams\/a\.png">/);
  assert.match(out, /src="https:\/\/x\.invalid\/b\.png"/);
  assert.match(out, /src="\/abs\.png"/);
  assert.match(out, /src="data:image\/png;base64,AA"/);
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
