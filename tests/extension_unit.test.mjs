// node --test: the extension's pure logic under a stub `vscode` module.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Minimal vscode stub: only what module load + the tested helpers touch.
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
const { parseTasks, parseTaskLine, parseTaskTree, findTask, serializeTask, makeAllTasksRequired, kiroTaskRequest, kiroRunAllRequest, phasePrompt, taskPrompt, runAllPrompt, normalizeRow, activate } = ext.__test;

test("parseTasks reads Kiro tasks.md checkboxes with numbering, nesting and partial marks", () => {
  const md = [
    "# Implementation Plan", "", "- [x] 1. Spikes", "  - [x] 1.1 Bootstrap the desk", "    - _Requirements: 13.1_",
    "  - [ ] 1.2 Create a workspace", "- [-] 2. Manifest", "- [ ] Untitled task without number", "not a task",
  ].join("\n");
  const tasks = parseTasks(md);
  assert.deepEqual(tasks.map((t) => [t.number, t.done, t.partial, t.indent, t.line]), [
    ["1", true, false, 0, 2], ["1.1", true, false, 2, 3], ["1.2", false, false, 2, 5], ["2", false, true, 0, 6], ["", false, false, 0, 7],
  ]);
  assert.equal(tasks[2].title, "Create a workspace");
  assert.equal(tasks[2].id, "1.2 Create a workspace", "a task's id is its full text, as Kiro's taskGet/taskUpdate expect");
  assert.deepEqual(tasks.map((t) => t.leaf), [false, true, true, true, true]);
  assert.deepEqual(parseTasks(null), []);
});

test("tasks.md grammar is Kiro's: four states, optional `*`, numbered hierarchy, details and sub-tasks", () => {
  // The line grammar (a port of @kiro/agent's parser).
  assert.deepEqual(parseTaskLine("- [~] 2. Queued one"), { isTask: true, indent: 0, status: "queued", text: "2. Queued one", number: "2", optional: false });
  assert.equal(parseTaskLine("  - [-]* 2.1 Optional running").optional, true);
  assert.equal(parseTaskLine("  - [-]* 2.1 Optional running").status, "in_progress");
  assert.equal(parseTaskLine("* [X] 3 star bullet").status, "completed");
  assert.equal(parseTaskLine("- [ ]\\* 4. escaped star").optional, true);
  assert.equal(parseTaskLine("- [?] not a mark").isTask, false);
  assert.equal(parseTaskLine("- plain bullet").isTask, false);

  const md = [
    "# Plan", "",
    "- [ ] 1. Parent", "  - _Requirements: 1.1_",
    "  - [ ] 1.1 Child A", "    - Detail line for A", "    - _Requirements: 1.2_",
    "  - [x] 1.2 Child B",
    "  - [ ]* 1.3 Optional child",
    "- [~] 2. Second parent", "", "  Some prose under 2.",
    "- [ ] 3. Leaf parent",
  ].join("\n");
  const tree = parseTaskTree(md);
  assert.deepEqual(tree.map((t) => t.id), ["1. Parent", "2. Second parent", "3. Leaf parent"], "numbered roots in document order");
  const parent = tree[0];
  assert.deepEqual(parent.subTasks.map((t) => [t.number, t.status, t.optional]), [["1.1", "not_started", false], ["1.2", "completed", false], ["1.3", "not_started", true]]);
  assert.equal(parent.content, "- _Requirements: 1.1_", "a numbered task's details stop at the next task line");
  assert.equal(parent.subTasks[0].content, "- Detail line for A\n- _Requirements: 1.2_");
  assert.equal(tree[1].status, "queued");
  assert.equal(tree[1].content, "Some prose under 2.");
  assert.equal(findTask(tree, "1.1 Child A").number, "1.1");
  assert.equal(findTask(tree, 4).id, "1.1 Child A", "found by source line too");
  assert.equal(findTask(tree, "nope"), null);

  // The <task> block Kiro's engine hands its executor: status words, details, required sub-tasks only.
  const block = serializeTask(parent);
  assert.match(block, /^<task title="1\. Parent">\n\nStatus: not started\n\nTask details:\n- _Requirements: 1\.1_\n\nSubtasks:\n\n<task title="1\.1 Child A">/);
  assert.match(block, /Status: done/, "the completed child is serialized with Kiro's word");
  assert.ok(!block.includes("Optional child"), "optional sub-tasks are left out");
  assert.match(block, /<\/task>$/);
  assert.equal(serializeTask(tree[1]).split("\n\n")[1], "Status: not started", "queued reads as not started, like Kiro");

  // Unnumbered tasks nest by indent (Kiro's fallback).
  const plain = parseTaskTree(["- [ ] Outer", "  - [ ] Inner", "    note", "- [x] Other"].join("\n"));
  assert.deepEqual(plain.map((t) => t.id), ["Outer", "Other"]);
  assert.equal(plain[0].subTasks[0].id, "Inner");
  assert.equal(plain[0].subTasks[0].content, "note");

  // "Make all required" drops the optional marks and nothing else.
  assert.equal(makeAllTasksRequired("- [ ]* a\n- [x]\\* b\n- [-] c *d*"), "- [ ] a\n- [x] b\n- [-] c *d*");
});

test("task requests to Kiro's own Spec agent are the engine's own texts (routes to its Task Orchestrator)", () => {
  const md = ["- [x] 1. Done one", "- [ ] 2. Open one", "  - _Requirements: 2.1_", "- [ ] 3. Third"].join("\n");
  const tree = parseTaskTree(md);
  const spec = { name: "my-feature", dir: { path: "/ws/.kiro/specs/my-feature" }, workspace: { uri: { path: "/ws" } }, taskTree: tree, tasks: parseTasks(md), tasksText: md };
  const one = kiroTaskRequest(spec, findTask(tree, "2. Open one"));
  assert.equal(one,
    "Execute the following task from the spec at /ws/.kiro/specs/my-feature/tasks.md:\n\n" +
    "<task title=\"2. Open one\">\n\nStatus: not started\n\nTask details:\n- _Requirements: 2.1_\n\n</task>" +
    "\n\nTask ID: 2. Open one\nSpec path: /ws/.kiro/specs/my-feature/tasks.md");
  // Run all: Kiro's sentence, plus its resume suffix once something is ticked.
  assert.equal(kiroRunAllRequest(spec), "Run all tasks for this spec. Resume from prior progress: tasks [1. Done one] are already completed (per tasks.md). Skip them and continue from the next ready task.");
  const fresh = Object.assign({}, spec, { taskTree: parseTaskTree("- [ ] 1. a\n- [ ] 2. b") });
  assert.equal(kiroRunAllRequest(fresh), "Run all tasks for this spec.");
  // These sentences are what the engine's local sub-intent patterns match on (run all tasks / execute the following task).
  assert.match(kiroRunAllRequest(fresh), /\brun\s+all\s+tasks?\b/i);
  assert.match(one, /\bexecute\s+the\s+following\s+task\b/i);
});

test("spec prompts name the spec dir, the phase and the single task, and never start the next phase", () => {
  const md = ["- [ ] 3. Routes", "  - [ ] 3.2 Wire the route", "    - _Requirements: 4.1_"].join("\n");
  const spec = { name: "my-feature", workspace: { uri: { path: "/ws" } }, taskTree: parseTaskTree(md), tasks: parseTasks(md), tasksText: md };
  const req = phasePrompt("requirements", spec, "add a login page");
  assert.match(req, /\.kiro\/specs\/my-feature\/requirements\.md/);
  assert.match(req, /PHASE: REQUIREMENTS/);
  assert.match(req, /add a login page/);
  assert.match(req, /Do not write design or tasks yet/);
  assert.match(phasePrompt("design", spec), /PHASE: DESIGN[\s\S]*design\.md[\s\S]*Do not write tasks yet/);
  assert.match(phasePrompt("tasks", spec), /PHASE: TASKS[\s\S]*tasks\.md/);
  // The crew-agent paraphrase carries Kiro's <task> block (details included) and Kiro's status marks.
  const one = taskPrompt(spec, spec.tasks[1]);
  assert.match(one, /implement exactly this task and nothing else:\n\n<task title="3\.2 Wire the route">\n\nStatus: not started\n\nTask details:\n- _Requirements: 4\.1_/);
  assert.match(one, /`- \[-\]`[\s\S]*`- \[x\]`/);
  assert.match(one, /Stop after this task/);
  // Without a tree (a bare task from an older caller) the block is built from the label.
  assert.match(taskPrompt({ name: "x", workspace: { uri: { path: "/ws" } } }, { number: "3.2", title: "Wire the route" }), /<task title="3\.2 Wire the route">/);
  const all = runAllPrompt(spec);
  assert.match(all, /Run all tasks for this spec\./);
  assert.match(all, /every unchecked required task in order[\s\S]*without stopping to ask between them/);
  assert.match(all, /skip tasks marked optional/);
  assert.throws(() => phasePrompt("nope", spec), /unknown phase/);
});

test("normalizeRow parses string meta and stringifies non-string content", () => {
  const row = normalizeRow({ role: "permission", content: "run ls", meta: JSON.stringify({ request_id: "r1", tool_title: "bash" }) });
  assert.deepEqual(row.meta, { request_id: "r1", tool_title: "bash" });
  assert.equal(row.cls, "");
  assert.equal(normalizeRow({ role: "tool", content: { a: 1 } }).content, "{\"a\":1}");
  assert.deepEqual(normalizeRow({ role: "user", content: "hi", meta: "{not json" }).meta, {});
});

test("findPathLinks picks up file paths with optional line:col and skips URLs, versions and prose", () => {
  const { findPathLinks, chatHtml } = ext.__test;
  const text = "Edited src/app/main.py:42:7 and hook/__init__.py, see a URL like http-colon-slash-slash and version 1.2.3 — also README.md.";
  const links = findPathLinks(text);
  assert.deepEqual(links.map((l) => [l.path, l.line, l.column]), [
    ["src/app/main.py", 42, 7], ["hook/__init__.py", undefined, undefined], ["README.md", undefined, undefined],
  ]);
  assert.equal(text.slice(links[0].start, links[0].end), "src/app/main.py:42:7");
  assert.deepEqual(findPathLinks("no paths here, just words and 3.14"), []);
  assert.deepEqual(findPathLinks("./relative/one.ts and /abs/path/two.go:9").map((l) => l.path), ["./relative/one.ts", "/abs/path/two.go"]);
  // the webview carries the same regex source so both sides agree on what is a link
  const html = chatHtml();
  assert.ok(html.includes("PATH_RE = new RegExp(") && html.includes("main.py") === false && html.includes("(?:py|js|mjs"), "regex embedded in the webview");
  assert.ok(html.includes("function question(id, card)") && html.includes("type:'answer'"), "question cards render and answer");
  assert.ok(html.includes("function renderTabs(") && html.includes("type:'close'") && html.includes("type:'select'"), "tab strip present");
});

test("sameDir treats the symlinked /local/home spelling and a trailing slash as the same folder", () => {
  const { sameDir } = ext.__test;
  assert.ok(sameDir("/local/home/me/proj", "/home/me/proj/"));
  assert.ok(!sameDir("/home/me/proj", "/home/me/other"));
  assert.ok(!sameDir("", "/home/me"));
});

test("asset templates are valid and name the asset", () => {
  const { HOOK_TEMPLATE, STEERING_TEMPLATE, SKILL_TEMPLATE } = ext.__test;
  const hook = JSON.parse(HOOK_TEMPLATE("on-save"));
  assert.equal(hook.name, "on-save");
  assert.ok(hook.when && hook.then && hook.enabled === true);
  assert.match(STEERING_TEMPLATE("my rules"), /^---\ninclusion: always\n---\n# my rules/);
  assert.match(SKILL_TEMPLATE("deploy"), /^---\nname: deploy\n/);
});

test("the module exports activate/deactivate for the web extension host", () => {
  assert.equal(typeof activate, "function");
  assert.equal(typeof ext.deactivate, "function");
});



test("workflows: the five Kiro modes; Default injects nothing, the others frame the procedure and name the root", () => {
  const { workflowContext, WORKFLOWS } = ext.__test;
  assert.deepEqual(WORKFLOWS.map((w) => w.label), ["Default", "Spec", "Quick Spec", "Bug Fix", "Plan"]);
  assert.equal(workflowContext("default", "/w"), "");
  const spec = workflowContext("spec", "/w/proj");
  assert.match(spec, /WORKFLOW: SPEC/);
  assert.match(spec, /\/w\/proj/);
  assert.match(spec, /requirements\.md/);
  assert.match(spec, /approval between phases/i);
  assert.match(workflowContext("quick-spec", "/w"), /without further pauses/);
  assert.match(workflowContext("bug-fix", "/w"), /REPRODUCE[\s\S]*DIAGNOSE[\s\S]*FIX[\s\S]*VERIFY/);
  assert.match(workflowContext("plan", "/w"), /Do NOT create, edit, delete/);
  for (const w of WORKFLOWS) assert.equal(typeof workflowContext(w.id, "/w"), "string");
});

test("splitOptions strips a trailing [OPTIONS: …] line into labels and leaves other text alone", () => {
  const { splitOptions } = ext.__test;
  const r = splitOptions("Done.\n\n[OPTIONS: Go deeper | Explain it | Draw a diagram]");
  assert.equal(r.text, "Done.");
  assert.deepEqual(r.options, ["Go deeper", "Explain it", "Draw a diagram"]);
  assert.deepEqual(splitOptions("no options here").options, []);
  assert.equal(splitOptions("no options here").text, "no options here");
  assert.deepEqual(splitOptions("mid [OPTIONS: a | b] text").options, [], "only a trailing line counts");
});

test("clip truncates with an explicit marker and passes short text through", () => {
  const { clip } = ext.__test;
  assert.equal(clip("abc", 10), "abc");
  const out = clip("x".repeat(50), 10);
  assert.ok(out.startsWith("xxxxxxxxxx\n… (truncated, 40 more chars)"));
});

test("chat webview: pick bar under the composer, no browser pop-ups, options chips, tab wheel scroll", () => {
  const { chatHtml, CONTEXT_KINDS } = ext.__test;
  const html = chatHtml("fox.svg");
  for (const id of ["p-agent", "p-model", "p-effort", "auto", "ctx", "att", "send", "file"]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(!html.includes('id="bar"'), "the old top bar (agent/history/stop/dashboard) is gone");
  assert.ok(!html.includes('id="p-mode"'), "one picker: modes live inside the Agent menu, as in Kiro");
  assert.ok(!/window\.(confirm|prompt|alert)\(/.test(html) && !/[^.\w](confirm|prompt|alert)\(/.test(html), "no browser pop-ups");
  assert.ok(html.includes("OPT_RE") && html.includes("[OPTIONS:"), "options chip renderer present");
  assert.ok(html.includes("tabsEl.addEventListener('wheel'"), "plain wheel scrolls the tab strip");
  assert.ok(html.includes("'paste'"), "pasted images become attachments");
  for (const k of CONTEXT_KINDS) assert.ok(html.includes(JSON.stringify(k.label)), k.label);
  assert.ok(html.includes("function scrollLog(") && !/function scroll\(/.test(html), "window.scroll must stay unshadowed");
});


test("a spec phase dispatched from the editor runs in a Spec-mode tab through the chat's own send path", async () => {
  // The bug: dispatch() used to create a session and post the phase prompt
  // directly, so the tab said "Default" and no Spec workflow frame was injected.
  const { ChatView } = ext.__test;
  const calls = { created: [], injected: [], sent: [] };
  const sessions = {
    projectPath: () => "/w",
    slot: () => null,
    onDidChange: () => ({ dispose() {} }),
    create: async (o) => { calls.created.push(o); return "k1"; },
    inject: async (key, content, source) => { calls.injected.push({ key, content, source }); },
    send: async (key, text, agent) => { calls.sent.push({ key, text, agent }); },
    setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {},
  };
  const context = { workspaceState: { get: () => undefined, update: () => {} } };
  const feed = { on: () => ({ dispose() {} }) };
  const chat = new ChatView(context, sessions, feed);
  const key = await chat.dispatch("PHASE: DESIGN …", { mode: "spec", agent: "spec-writer", title: "spec x: design", kind: "spec" });
  assert.equal(key, "k1");
  assert.deepEqual(calls.created[0], { agent: "spec-writer", kind: "spec", title: "spec x: design" });
  assert.equal(calls.injected.length, 1, "one background frame injected");
  assert.match(calls.injected[0].content, /WORKFLOW: SPEC/);
  assert.equal(calls.injected[0].source, "kirocrew-ide workflow");
  assert.deepEqual(calls.sent[0], { key: "k1", text: "PHASE: DESIGN …", agent: "spec-writer" });
  const tab = chat.tabForKey("k1");
  assert.equal(tab.settings.mode, "spec");
  assert.equal(tab.title, "spec x: design");
});

test("a task run dispatched to Kiro's Spec agent sends Kiro's own request, shows Kiro's short turn, runs on Autopilot; the crew agent gets the paraphrase", async () => {
  const { ChatView, parseTaskTree, parseTasks, kiroRunAllRequest, runAllPrompt } = ext.__test;
  const md = "- [x] 1. a\n- [ ] 2. b";
  const spec = { name: "f", dir: { path: "/w/.kiro/specs/f" }, workspace: { uri: { path: "/w" } }, taskTree: parseTaskTree(md), tasks: parseTasks(md), tasksText: md };
  const make = (agents) => {
    const calls = { created: [], injected: [], sent: [], trust: [], posted: [] };
    const sessions = {
      projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents,
      create: async (o) => { calls.created.push(o); return "k" + calls.created.length; },
      inject: async (key, content, source) => { calls.injected.push({ key, content, source }); },
      send: async (key, text, agent) => { calls.sent.push({ key, text, agent }); },
      setModel: async () => {}, setEffort: async () => {}, setTrust: async (key, on) => { calls.trust.push([key, on]); }, setSlotAgent: async () => {},
    };
    const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
    chat.post = (m) => calls.posted.push(m);
    return { chat, calls };
  };
  // With kiro-spec-plan installed: Kiro's sentence to Kiro's agent, no prompt frame, Autopilot on, "Run all tasks" shown.
  const kiro = make([{ name: "spec" }]);
  await kiro.chat.dispatch((agent) => (agent ? kiroRunAllRequest(spec) : runAllPrompt(spec)), { mode: "spec", title: "Run all tasks", kind: "spec", display: "Run all tasks", autopilot: true });
  assert.equal(kiro.calls.sent[0].agent, "spec");
  assert.equal(kiro.calls.sent[0].text, "Run all tasks for this spec. Resume from prior progress: tasks [1. a] are already completed (per tasks.md). Skip them and continue from the next ready task.");
  assert.equal(kiro.calls.injected.length, 0, "Kiro's own agent gets no paraphrase frame");
  assert.deepEqual(kiro.calls.trust, [["k1", true]], "Autopilot applied to the task session");
  assert.equal(kiro.calls.posted.find((m) => m.type === "user").text, "Run all tasks", "the transcript shows the short turn, like Kiro's IDE");
  const next = kiro.chat.newTab();
  assert.equal(next.settings.autopilot, false, "the forced Autopilot is not inherited by the next ordinary tab");
  // Without it: the paraphrase on the crew agent, with the Spec frame.
  const crew = make([]);
  await crew.chat.dispatch((agent) => (agent ? kiroRunAllRequest(spec) : runAllPrompt(spec)), { mode: "spec", title: "Run all tasks", kind: "spec", display: "Run all tasks", autopilot: true });
  assert.match(crew.calls.sent[0].text, /PHASE: EXECUTE REMAINING TASKS\. Run all tasks for this spec\./);
  assert.equal(crew.calls.injected.length, 1);
  assert.deepEqual(crew.calls.trust, [["k1", true]]);
});


test("attachments go the dashboard's way: [attached_file N] markers in the text plus meta.files, never 'Attached file:' prose or a markdown image", async () => {
  // Before: an image went as `![name](path)` and any other file as "Attached file: <path>" with no meta, a shape
  // the host never writes itself (the dashboard sends `[attached_file N] <path>` + meta.files); the host's own
  // renderer then had nothing to resolve and the model saw stray prose instead of a marker it knows.
  const { ChatView } = ext.__test;
  const calls = { sent: [], uploaded: [], posted: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [],
    create: async () => "k1", inject: async () => {}, setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {},
    upload: async (name) => { calls.uploaded.push(name); return "/data/uploads/" + calls.uploaded.length + "_" + name; },
    send: async (key, text, agent, meta) => { calls.sent.push({ key, text, agent, meta }); },
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  const t = chat.newTab(true);
  await chat.send(t, { text: "compare these", files: [{ name: "shot.png", mime: "image/png", data: "AAAA" }, { name: "app.log", mime: "text/plain", data: "AAAA" }] });
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].text, "compare these\n[attached_file 1] /data/uploads/1_shot.png\n[attached_file 2] /data/uploads/2_app.log");
  assert.deepEqual(calls.sent[0].meta, { files: ["/data/uploads/1_shot.png", "/data/uploads/2_app.log"] });
  const shown = calls.posted.find((m) => m.type === "user");
  assert.equal(shown.text, "compare these", "the transcript shows the typed text; the strip shows the files");
  // The bubble gets name, host path and kind per file; an image under the preview cap carries its data URL for the thumbnail.
  assert.deepEqual(shown.files, [
    { name: "shot.png", path: "/data/uploads/1_shot.png", image: true, data: "data:image/png;base64,AAAA" },
    { name: "app.log", path: "/data/uploads/2_app.log", image: false, data: undefined },
  ]);
  // No text at all: a stand-in sentence, markers, meta.
  await chat.send(t, { text: "", files: [{ name: "a.pdf", mime: "application/pdf", data: "AAAA" }] });
  assert.equal(calls.sent[1].text, "[attached_file 1] /data/uploads/3_a.pdf");
  assert.deepEqual(calls.sent[1].meta, { files: ["/data/uploads/3_a.pdf"] });
  // No attachments: no meta on the wire.
  await chat.send(t, { text: "hi" });
  assert.equal(calls.sent[2].meta, undefined);
});

test("steering front matter: Kiro's inclusion modes, patterns in every spelling, no front matter = always", () => {
  const { parseSteering } = ext.__test;
  assert.deepEqual(parseSteering("# Rules\nbe nice").inclusion, "always");
  assert.equal(parseSteering("\n---\ninclusion: manual\n---\nx").inclusion, "always", "front matter must start on line 1, as Kiro reads it");
  const fm = parseSteering('---\ninclusion: fileMatch\nfileMatchPattern: "**/*.test.ts"\n---\n# Tests\nuse vitest');
  assert.deepEqual([fm.inclusion, fm.patterns, fm.body], ["fileMatch", ["**/*.test.ts"], "# Tests\nuse vitest"]);
  assert.deepEqual(parseSteering("---\ninclusion: fileMatch\nfileMatchPattern: ['src/**/*.py', \"*.md\"]\n---\n").patterns, ["src/**/*.py", "*.md"]);
  assert.deepEqual(parseSteering("---\ninclusion: fileMatch\nfileMatchPattern: a.ts, b/*.ts\n---\n").patterns, ["a.ts", "b/*.ts"]);
  assert.equal(parseSteering("---\ninclusion: fileMatch\n---\n").inclusion, "manual", "fileMatch without a pattern can only be included by name");
  assert.equal(parseSteering("---\ninclusion: Manual\n---\n").inclusion, "manual");
  assert.equal(parseSteering("---\ninclusion: auto\ndescription: deploy steps\n---\n").description, "deploy steps");
  assert.equal(parseSteering("---\ninclusion: weird\n---\n").inclusion, "manual", "an unknown mode is not always");
  assert.equal(parseSteering("---\r\ninclusion: manual\r\n---\r\nbody").body, "body", "CRLF");
});

test("steering fileMatch: Kiro globs against the relative path and the basename", () => {
  const { globToRegExp, steeringMatches } = ext.__test;
  assert.ok(globToRegExp("**/*.py").test("src/a/b.py") && globToRegExp("**/*.py").test("b.py"));
  assert.ok(globToRegExp("src/**/*.tsx").test("src/components/x/y.tsx") && !globToRegExp("src/**/*.tsx").test("lib/y.tsx"));
  assert.ok(globToRegExp("README*").test("README.md") && !globToRegExp("README*").test("docs/README.md"));
  assert.ok(globToRegExp("*.{js,mjs}").test("a.mjs") && !globToRegExp("*.{js,mjs}").test("a.ts"));
  assert.ok(globToRegExp("a?c.txt").test("abc.txt") && !globToRegExp("a?c.txt").test("ac.txt"));
  const doc = { inclusion: "fileMatch", patterns: ["**/*.py"] };
  assert.equal(steeringMatches(doc, ["/w/src/x.py"], "/w"), true);
  assert.equal(steeringMatches(doc, ["/w/src/x.ts"], "/w"), false);
  assert.equal(steeringMatches({ inclusion: "fileMatch", patterns: ["src/api/**/*.ts"] }, ["/w/src/api/v1/u.ts"], "/w/"), true, "root with a trailing slash, nested dirs");
  assert.equal(steeringMatches({ inclusion: "fileMatch", patterns: ["src/api/**/*.ts"] }, ["/elsewhere/src/api/u.ts"], "/w"), false, "a file outside the workspace keeps its absolute path");
  assert.equal(steeringMatches({ inclusion: "always", patterns: [] }, ["/w/a.py"], "/w"), false, "always files are the agent's, not a match");
  assert.equal(steeringMatches({ inclusion: "manual", patterns: ["**/*"] }, ["/w/a.py"], "/w"), false);
});

test("steering mentions and agent resources: `#name` names a file; an agent with its own resources may leave steering out", () => {
  const { steeringMentions, agentLoadsSteering } = ext.__test;
  const docs = [{ name: "deploy-steps" }, { name: "api.rules" }, { name: "Style" }];
  assert.deepEqual(steeringMentions("please #deploy-steps and #API.RULES now, see #nope and a#b", docs).map((d) => d.name), ["deploy-steps", "api.rules"]);
  assert.deepEqual(steeringMentions("#style.md", docs).map((d) => d.name), ["Style"], "the .md suffix is tolerated");
  assert.deepEqual(steeringMentions("#deploy-steps #deploy-steps", docs).length, 1);
  // Nested files: the path under the steering dir names them; a bare name works when it is unique.
  const nested = [{ name: "amazon-builder/git" }, { name: "amazon-builder/coral" }, { name: "team/style" }, { name: "style" }];
  assert.deepEqual(steeringMentions("#amazon-builder/git and #git", nested).map((d) => d.name), ["amazon-builder/git"], "path or unique bare name, once");
  assert.deepEqual(steeringMentions("#coral.md #./amazon-builder/coral", nested).map((d) => d.name), ["amazon-builder/coral"]);
  assert.deepEqual(steeringMentions("#style", nested).map((d) => d.name), ["style"], "a top-level file wins its own name outright");
  assert.deepEqual(steeringMentions("#team/style", nested).map((d) => d.name), ["team/style"]);
  const dup = [{ name: "a/rules" }, { name: "b/rules" }];
  assert.deepEqual(steeringMentions("#rules", dup), [], "an ambiguous bare name resolves to nothing");
  assert.deepEqual(steeringMentions("#b/rules", dup).map((d) => d.name), ["b/rules"]);
  // Engine-aware (probed on kiro-cli 2.34): KAS loads steering for every agent; the legacy engine only through `resources`.
  assert.equal(agentLoadsSteering(null), null, "unknown agent, unknown engine: unknown (no warning)");
  assert.equal(agentLoadsSteering({ name: "x" }), null, "no resources key, unknown engine: unknown");
  assert.equal(agentLoadsSteering({ name: "x" }, "legacy"), false, "no resources key on the legacy engine: nothing loads (probe agent saw no steering)");
  assert.equal(agentLoadsSteering({ name: "x" }, "kas"), true, "no resources key on KAS: both tiers load");
  assert.equal(agentLoadsSteering({ resources: ["file://README.md"] }, "kas"), true, "KAS loads steering even when resources omit it");
  assert.equal(agentLoadsSteering(null, "kas"), true, "KAS: even an unknown agent (Kiro's built-in Spec mode) loads steering");
  assert.equal(agentLoadsSteering({ resources: ["file://README.md", "file://.kiro/steering/**/*.md"] }), true);
  assert.equal(agentLoadsSteering({ resources: ["file://README.md", "skill://.kiro/skills/*/SKILL.md"] }), false);
  assert.equal(agentLoadsSteering({ resources: ["file://README.md", "skill://.kiro/skills/*/SKILL.md"] }, "legacy"), false);
});

test("listSteering walks subdirectories like kiro-cli's `steering/**/*.md`: nested files are named by their relative path", async () => {
  const { listSteering } = ext.__test;
  const home = "/local/home/someone";
  const tree = {
    [home + "/.kiro/steering"]: [["amazon-builder", 2], ["zz-top.md", 1], [".hidden", 2], ["notes.txt", 1]],
    [home + "/.kiro/steering/amazon-builder"]: [["git.md", 1], ["crux.md", 1], ["deep", 2]],
    [home + "/.kiro/steering/amazon-builder/deep"]: [["deeper.md", 1]],
    [home + "/.kiro/steering/.hidden"]: [["secret.md", 1]],
    [home + "/proj/.kiro/steering"]: [["ws.md", 1]],
  };
  const files = {
    [home + "/.kiro/steering/zz-top.md"]: "top rules",
    [home + "/.kiro/steering/amazon-builder/git.md"]: "# Git\nalways by default",
    [home + "/.kiro/steering/amazon-builder/crux.md"]: "---\ninclusion: manual\n---\n# CRUX",
    [home + "/.kiro/steering/amazon-builder/deep/deeper.md"]: "---\ninclusion: fileMatch\nfileMatchPattern: '*.py'\n---\ndeep",
    [home + "/.kiro/steering/.hidden/secret.md"]: "never",
    [home + "/proj/.kiro/steering/ws.md"]: "workspace rules",
  };
  const saved = { fs: stub.workspace.fs, folders: stub.workspace.workspaceFolders, FileType: stub.FileType };
  stub.FileType = { Directory: 2, File: 1 };
  stub.workspace.workspaceFolders = [{ uri: { path: home + "/proj", with: ({ path }) => ({ path }) } }];
  stub.workspace.fs = {
    readDirectory: async (uri) => { if (!(uri.path in tree)) throw new Error("ENOENT " + uri.path); return tree[uri.path].map((e) => [...e]); },
    readFile: async (uri) => { reads.push(uri.path); if (!(uri.path in files)) throw new Error("ENOENT " + uri.path); return new TextEncoder().encode(files[uri.path]); },
  };
  const reads = [];
  ext.__test.invalidateSteeringCache();
  try {
    const docs = await listSteering(home + "/proj");
    assert.deepEqual(docs.map((d) => [d.scope, d.name, d.label, d.inclusion]), [
      ["workspace", "ws", "ws.md", "always"],
      ["global", "amazon-builder/crux", "amazon-builder/crux.md", "manual"],
      ["global", "amazon-builder/deep/deeper", "amazon-builder/deep/deeper.md", "fileMatch"],
      ["global", "amazon-builder/git", "amazon-builder/git.md", "always"],
      ["global", "zz-top", "zz-top.md", "always"],
    ], "nested files found at every depth, dot-dirs and non-.md files skipped, sorted within each directory");
    assert.equal(docs.find((d) => d.name === "amazon-builder/git").path, home + "/.kiro/steering/amazon-builder/git.md");
    assert.deepEqual(docs.find((d) => d.name === "amazon-builder/deep/deeper").patterns, ["*.py"]);
    // The inventory is cached between sends (every directory and file is a remote-fs RPC);
    // the Steering view's watcher invalidates it, and a new workspace set misses the cache.
    const before = reads.length;
    assert.equal(await listSteering(home + "/proj"), docs, "a second listing within the window is the same object, no RPC");
    assert.equal(reads.length, before);
    ext.__test.invalidateSteeringCache();
    assert.notEqual(await listSteering(home + "/proj"), docs, "invalidated: rescanned");
    assert.ok(reads.length > before);
  } finally {
    ext.__test.invalidateSteeringCache();
    stub.workspace.fs = saved.fs; stub.workspace.workspaceFolders = saved.folders; stub.FileType = saved.FileType;
  }
});

test("chat webview: steering indicator, `#name` hint, and a resizable input box with a remembered height", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(html.includes('data-testid="pinned-prompt"') && /function pinUpdate\(/.test(html) && /function pinJump\(/.test(html) && /addEventListener\('scroll', \(\)=>\{ pinSchedule\(\);/.test(html), "the pinned prompt overlay, measured on scroll");
  assert.ok(/-webkit-line-clamp:1/.test(html) && /\.pin-card:hover \.pin-text[^{]*\{-webkit-line-clamp:3\}/.test(html) && /\.pin\.open \.pin-text\{display:block/.test(html), "one line, three on hover, the whole prompt on ⌄");
  assert.ok(/function toolRow\(/.test(html) && /case 'toolResult':/.test(html) && /case 'toolUpdate':/.test(html) && /\.tool \.tool-head\{/.test(html), "tool rows open to Input/Output and complete on tool_result");
  assert.ok(html.includes('id="p-steer"') && /case 'steering':/.test(html) && /function renderSteering\(\)/.test(html), "steering indicator fed by the extension");
  assert.ok(/steeringPick/.test(html) && /steeringOpen/.test(html), "a manual file is included on pick, an always file opened");
  assert.ok(/#steering-name to include/.test(html), "the box says how to include a manual file");
  assert.ok(html.includes('id="grip"') && /function autoGrow\(\)/.test(html) && /case 'composerHeight':/.test(html) && /type:'composerHeight'/.test(html), "grip + auto-grow + persisted height");
  assert.ok(/textarea\{[^}]*max-height:45vh/.test(html) && /textarea\.manual\{max-height:none\}/.test(html), "auto height capped, manual height free");
});

test("a host that reserves Kiro's mode ids: the refusal falls back to the prompt-guided workflow on the pick, once per window", async () => {
  // KiroCrew 0.8.0.9 refuses a session whose agent is `spec`/`plan`/… ("reserved for a built-in agent"),
  // which is exactly the name kiro-spec-plan's handles carry. The tab must not die on it.
  const { ChatView, isReservedModeRefusal } = ext.__test;
  assert.equal(isReservedModeRefusal("Rename this crewmate's template: “spec” is reserved for a built-in agent, so …"), true);
  assert.equal(isReservedModeRefusal("'spec' is reserved by the KAS agent engine"), true);
  assert.equal(isReservedModeRefusal("HTTP 500 /chat"), false);
  // KiroCrew 0.11's coat of the same refusal (the verbatim host text of 2026-11-03): the id it
  // looked for was the wire alias `spec-crewmate`, which nothing registered. Only the four mode
  // ids count; the identical sentence about any other agent is a genuinely missing file.
  const v011 = "kiro_crew.acp.session_handle.AcpRuntimeError: Agent mode 'spec' is not available on this session (advertised modes: ['vibe', 'spec', 'quick-spec', 'bug-fix', 'plan', 'o3r_default']); its ~/.kiro/agents/spec.json is likely missing. Refusing to run the backend default mode vibe in its place. Run `kirocrew setup --agent-only` to materialize the agent config.";
  assert.equal(isReservedModeRefusal(v011), true);
  assert.equal(isReservedModeRefusal(v011.replace(/'spec'/, "'quick-spec'")), true);
  assert.equal(isReservedModeRefusal(v011.replace(/'spec'/, "'bug-fix'")), true);
  assert.equal(isReservedModeRefusal(v011.replace(/'spec'/, "'plan'")), true);
  assert.equal(isReservedModeRefusal(v011.replace(/'spec'/, "'o3r_default'")), false, "a missing ordinary agent is not a reserved-mode refusal");
  assert.equal(isReservedModeRefusal(v011.replace(/'spec'/, "'spec-crewmate'")), false);
  const calls = { sent: [], injected: [], slotAgent: [], posted: [] };
  let refuse = true;
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [{ name: "spec" }, { name: "o3r" }],
    create: async () => "k1", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {},
    inject: async (key, content, source) => { calls.injected.push(source); }, setSlotAgent: async (key, a) => { calls.slotAgent.push(a); },
    send: async (key, text, agent) => { calls.sent.push(agent); if (refuse && agent === "spec") throw new Error("Rename this crewmate's template: “spec” is reserved for a built-in agent, so the crewmate's own prompt and tools would not run under it."); },
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  const t = chat.newTab(true); t.settings.mode = "spec"; t.settings.agent = "o3r";
  await chat.send(t, { text: "build the thing" });
  assert.deepEqual(calls.sent, ["spec", "o3r"], "sent to Kiro's agent, refused, re-sent on the pick");
  assert.deepEqual(calls.slotAgent, ["o3r"], "the slot is retargeted to the pick");
  assert.ok(calls.injected.includes("kirocrew-ide workflow"), "the prompt-guided Spec frame is injected for the retry");
  assert.match(calls.posted.find((m) => m.type === "error").text, /refuses Kiro's mode agent "spec"/);
  // The next tab skips the doomed attempt.
  const t2 = chat.newTab(true); t2.settings.mode = "spec"; t2.settings.agent = "o3r";
  await chat.send(t2, { text: "again" });
  assert.equal(calls.sent[calls.sent.length - 1], "o3r");
  assert.equal(calls.sent.filter((a) => a === "spec").length, 1, "no second attempt on the reserved id in this window");
  // An unrelated error still surfaces.
  refuse = false;
  sessions.send = async () => { throw new Error("HTTP 502 /chat"); };
  await assert.rejects(chat.send(chat.newTab(true), { text: "x" }), /502/);
});

test("Spec on a KAS host: the steering receipt names the agent and is re-posted for the fallback agent after the mode-id refusal", async () => {
  const { ChatView } = ext.__test;
  const home = "/local/home/someone";
  const tree = { [home + "/proj/.kiro/steering"]: [["rules.md", 1], ["amazon-builder", 2]], [home + "/proj/.kiro/steering/amazon-builder"]: [["git.md", 1]], [home + "/.kiro/steering"]: [["crux.md", 1]] };
  const files = {
    [home + "/proj/.kiro/steering/rules.md"]: "always",
    [home + "/proj/.kiro/steering/amazon-builder/git.md"]: "always too",
    [home + "/.kiro/steering/crux.md"]: "---\ninclusion: manual\n---\nmanual",
    [home + "/.kiro/crew/config.json"]: JSON.stringify({ acp_backend: "kas", default_agent: "o3r" }),
    [home + "/.kiro/agents/spec.json"]: JSON.stringify({ name: "spec", prompt: "handle" }),            // no resources key
    [home + "/.kiro/agents/o3r.json"]: JSON.stringify({ name: "o3r", resources: ["file://README.md"] }), // resources omit steering
  };
  const saved = { fs: stub.workspace.fs, folders: stub.workspace.workspaceFolders, FileType: stub.FileType, window: stub.window };
  stub.FileType = { Directory: 2, File: 1 };
  stub.workspace.workspaceFolders = [{ uri: { path: home + "/proj", with: ({ path }) => ({ path }) } }];
  stub.workspace.fs = {
    readDirectory: async (uri) => { if (!(uri.path in tree)) throw new Error("ENOENT"); return tree[uri.path].map((e) => [...e]); },
    readFile: async (uri) => { if (!(uri.path in files)) throw new Error("ENOENT"); return new TextEncoder().encode(files[uri.path]); },
  };
  stub.window = { visibleTextEditors: [] };
  const calls = { sent: [], posted: [] };
  const sessions = {
    projectPath: () => home + "/proj", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [{ name: "spec" }, { name: "o3r" }],
    create: async () => "k2", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, inject: async () => {}, setSlotAgent: async () => {},
    send: async (key, text, agent) => { calls.sent.push(agent); if (agent === "spec") throw new Error("“spec” is reserved for a built-in agent"); },
  };
  try {
    const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
    chat.post = (m) => calls.posted.push(m);
    const t = chat.newTab(true); t.settings.mode = "spec"; t.settings.agent = "o3r";
    await chat.send(t, { text: "build the thing" });
    assert.deepEqual(calls.sent, ["spec", "o3r"]);
    const notes = calls.posted.filter((m) => m.type === "status").map((m) => m.text);
    assert.equal(notes.length, 2, "one receipt before the send, one after the fallback");
    assert.match(notes[0], /^Steered by workspace amazon-builder\/git\.md, rules\.md \(always, loaded with agent spec on KAS\)\. crux\.md is manual \(#crux\)$/, "nested workspace file listed; KAS loads steering for the mode agent too");
    assert.match(notes[1], /loaded with agent o3r on KAS/, "the fallback agent's receipt: on KAS its resources omitting steering does not matter");
    assert.ok(!notes.some((n) => /does not load/.test(n)), "no false warning on KAS");
  } finally {
    stub.workspace.fs = saved.fs; stub.workspace.workspaceFolders = saved.folders; stub.FileType = saved.FileType; stub.window = saved.window;
  }
});

test("the refusal that arrives as the turn's streamed error row (the send was accepted) also falls back, once", async () => {
  // On this host `/chat?ws=1` answers 200 and the turn runs asynchronously; the
  // KasReservedAgentIdError lands as an `error` row in the slot's history and a
  // chat_message frame. Seen 2026-10-23 in kirocrew-ide-chat-20261023042311.
  const { ChatView, isErrorRow } = ext.__test;
  assert.equal(isErrorRow({ role: "error", content: "x" }), true);
  assert.equal(isErrorRow({ role: "assistant", cls: "msg msg-err", content: "x" }), true);
  assert.equal(isErrorRow({ role: "assistant", content: "❌ failed" }), true);
  assert.equal(isErrorRow({ role: "assistant", content: "fine" }), false);
  const refusal = "Rename this crewmate's template: “spec” is reserved for a built-in agent, so the crewmate's own prompt and tools would not run under it.";
  const calls = { sent: [], injected: [], slotAgent: [], posted: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [{ name: "spec" }, { name: "o3r" }],
    create: async () => "k9", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {},
    inject: async (key, content, source) => { calls.injected.push(source); }, setSlotAgent: async (key, a) => { calls.slotAgent.push(a); },
    send: async (key, text, agent, meta) => { calls.sent.push([agent, text, meta]); },
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  const t = chat.newTab(true); t.settings.mode = "spec"; t.settings.agent = "o3r";
  await chat.send(t, { text: "check the drafted requirements file", files: [] });
  assert.equal(calls.sent.length, 1, "the send was accepted");
  assert.equal(calls.sent[0][0], "spec");
  // The host streams the refusal as the turn's error row.
  chat.onFrame({ type: "chat_message", data: { slot: "k9", role: "error", content: refusal } });
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.sent.length, 2, "re-sent on the pick");
  assert.deepEqual(calls.sent[1].slice(0, 2), ["o3r", "check the drafted requirements file"], "the same text, on the picked agent");
  assert.deepEqual(calls.slotAgent, ["o3r"]);
  assert.ok(calls.injected.includes("kirocrew-ide workflow"));
  assert.ok(!calls.posted.some((m) => m.type === "row" && /reserved for a built-in/.test(m.row && m.row.content)), "the host's refusal row is replaced by our one-line note");
  assert.match(calls.posted.find((m) => m.type === "error").text, /refuses Kiro's mode agent "spec"/);
  // A second copy of the same row (history replay) does nothing more.
  chat.onFrame({ type: "chat_message", data: { slot: "k9", role: "error", content: refusal } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.sent.length, 2, "the fallback runs once per turn");
  assert.equal(chat.modeAgentsRefused, true);
});

test("tool lifecycle frames reach the webview: tool_result and a tool_call update are forwarded by tool_call_id, the initial tool_call is not", async () => {
  const { ChatView } = ext.__test;
  const calls = { posted: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [],
    create: async () => "k7", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, inject: async () => {}, setSlotAgent: async () => {},
    send: async () => {},
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  const t = chat.newTab(true); t.settings.agent = "o3r";
  await chat.send(t, { text: "look" });
  calls.posted.length = 0;
  chat.onFrame({ type: "tool_call", data: { slot: "k7", tool: "List Directory", tool_call_id: "tc1", kind: "read" } });
  chat.onFrame({ type: "tool_result", data: { slot: "k7", tool_call_id: "tc1", output: "a.js\nb.js" } });
  chat.onFrame({ type: "tool_call", data: { slot: "k7", tool: "List Directory /w", tool_call_id: "tc1", is_update: true, input_preview: "/w" } });
  chat.onFrame({ type: "tool_result", data: { slot: "other", tool_call_id: "tc9", output: "x" } });
  assert.deepEqual(calls.posted.map((m) => [m.type, m.tcid, m.output !== undefined ? m.output : m.title]), [
    ["toolResult", "tc1", "a.js\nb.js"],
    ["toolUpdate", "tc1", "List Directory /w"],
  ], "the row comes as a chat_message; only its result and refinements are extra posts, and only for this tab's slot");
  assert.equal(calls.posted[0].id, t.id);
  assert.equal(calls.posted[1].input, "/w");
});

test("# context picks are clipped to the host's 40000-char entry cap (a 51 KB requirements.md used to be refused)", async () => {
  // Two functions named readText existed; the budget-less spec-model one was hoisted over
  // the clipping one, so every #File / #Spec / steering pick went to the host whole.
  const { readText, readWholeText, CONTEXT_BUDGET, HOST_CONTEXT_MAX, Sessions, clip } = ext.__test;
  const big = "r".repeat(51600);
  const savedFs = stub.workspace.fs;
  stub.workspace.fs = { readFile: async () => new TextEncoder().encode(big) };
  try {
    const clipped = await readText({ path: "/w/.kiro/specs/connect/requirements.md" }, CONTEXT_BUDGET);
    assert.ok(clipped.length <= CONTEXT_BUDGET + 60 && /truncated, \d+ more chars/.test(clipped), "readText honours the budget: " + clipped.length);
    assert.equal((await readWholeText({ path: "/w/x.md" })).length, 51600, "the spec model still reads whole files");
  } finally { stub.workspace.fs = savedFs; }
  // And inject() itself never sends more than the host accepts, whatever the caller built.
  const posted = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true }), text: async () => "{}" }; };
  try {
    const s = Object.create(Sessions.prototype);
    await s.inject("k", "[label]\n" + big, "kirocrew-ide #file");
    assert.ok(posted[0].content.length <= HOST_CONTEXT_MAX, "sent " + posted[0].content.length);
    assert.equal(clip("abc", 10), "abc");
  } finally { globalThis.fetch = savedFetch; }
});

test("chat webview: errors are a red/pink box — ours and the host's msg-err / ❌ rows", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(/\.error,\.row\.err\{[^}]*background:color-mix\(in srgb,var\(--vscode-errorForeground,#e5484d\) 10%/.test(html), "tinted background from the error colour");
  assert.ok(/\.error,\.row\.err\{[^}]*border:1px solid color-mix/.test(html) && /\.error,\.row\.err\{[^}]*border-radius:6px/.test(html), "bordered, small radius");
  assert.ok(/msg-err/.test(html) && /\[❌⏱\]/.test(html), "host failure rows are detected by class or prefix");
});

test("themeFor follows the dashboard only while the workbench theme is stock", () => {
  const { themeFor } = ext.__test;
  assert.equal(themeFor("dark", undefined), "Default Dark Modern", "unset -> the dashboard's polarity");
  assert.equal(themeFor("light", undefined), "Default Light Modern");
  assert.equal(themeFor("light", "Default Dark Modern"), "Default Light Modern", "stock dark follows a light dashboard");
  assert.equal(themeFor("dark", "Default Light+"), "Default Dark Modern", "older stock names count as stock");
  assert.equal(themeFor("dark", "Default Dark Modern"), null, "already matching -> nothing to do");
  assert.equal(themeFor("dark", "Monokai"), null, "a theme the user picked is never touched");
  assert.equal(themeFor("light", "Default High Contrast"), null, "high contrast is a deliberate choice");
  assert.equal(themeFor("system", undefined), null, "only resolved schemes are handled");
});

test("chat webview: compact spacing, message font size scoped to the transcript", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(html.includes("--kide-msg-size"), "font-size variable present");
  assert.ok(/\.log\{[^}]*font-size:var\(--kide-msg-size\)/.test(html), "applied on the transcript pane only");
  assert.ok(!/#compose\{[^}]*--kide-msg-size/.test(html) && !/#tabs\{[^}]*--kide-msg-size/.test(html), "UI keeps the workbench size");
  assert.ok(html.includes('id="p-font"'), "Aa picker in the bar");
  // The reading column: the dashboard's presets (compact 800px/816px scaled by the font size,
  // comfortable 84%/85%, full 92%/93%) as a gutter that is 8px (5px for the composer) in a
  // narrow pane and grows with the pane past the column width.
  assert.ok(/--kide-content-width:800px;--kide-input-width:816px/.test(html), "compact defaults");
  assert.ok(/--kide-gutter:max\(8px,calc\(\(100% - var\(--kide-content-width\)\)\/2\)\)/.test(html), "gutter derives from the column");
  assert.ok(/\.log\.on\{[^}]*padding:8px var\(--kide-gutter\) 4px/.test(html) && /#compose\{[^}]*padding:5px var\(--kide-input-gutter\) 4px/.test(html), "rows and composer use the gutters");
  assert.ok(/\.pin\{[^}]*left:var\(--kide-gutter\);right:calc\(var\(--kide-gutter\) \+ var\(--kide-scrollbar\)\)/.test(html), "the pinned card follows the column (and the scrollbar)");
  assert.ok(html.includes("const WIDTHS = { compact:['800px','816px'], comfortable:['84%','85%'], full:['92%','93%'] }"), "the dashboard's three presets");
  assert.ok(html.includes("msgs=Math.round(800*r)+'px'; input=Math.round(816*r)+'px'"), "compact scales with the message font size, as the dashboard does");
  assert.ok(/case 'width': applyWidth\(m\.preset\); pinSchedule\(\)/.test(html), "the extension pushes the preset");
});

test("mdToHtml: a markdown image is a picture — https loads as is, a local image path is a placeholder the page fetches, a non-image path stays a link", () => {
  const { mdToHtml } = ext.__test;
  assert.match(mdToHtml("see ![the chart](/tmp/out/chart.png) here"), /<img class="mdimg" data-path="\/tmp\/out\/chart\.png" alt="the chart" title="the chart">/);
  assert.match(mdToHtml("![](shots/a-b.png)"), /<img class="mdimg" data-path="shots\/a-b\.png" alt="" title="shots\/a-b\.png">/, "a relative path, no alt: the path is the title");
  assert.match(mdToHtml("![r](https://example.invalid/r.png)"), /<img class="mdimg" src="https:\/\/example\.invalid\/r\.png" alt="r" title="r">/);
  assert.match(mdToHtml("![doc](/tmp/report.pdf)"), /<a class="path" data-path="\/tmp\/report\.pdf"[^>]*>doc<\/a>/, "not an image: the usual path link");
  assert.match(mdToHtml("[a link](/tmp/out/chart.png)"), /<a class="path" data-path="\/tmp\/out\/chart\.png"/, "a plain link to an image file stays a link");
  assert.ok(!/<img/.test(mdToHtml("`![x](/a.png)`")), "inside a code span nothing is rendered");
});

test("imageData reads an image on the gateway host as a data URL: mime by extension, capped, cached; a non-image or a missing file is an error", async () => {
  const { imageData, IMAGE_PREVIEW_MAX } = ext.__test;
  const reads = [];
  const files = { "/home/u/.kiro/crew/uploads/x_shot.png": new Uint8Array([137, 80, 78, 71]), "/w/big.jpg": new Uint8Array(0), "/w/rel/pic.webp": new Uint8Array([1, 2, 3]) };
  const sizes = { "/w/big.jpg": IMAGE_PREVIEW_MAX + 1 };
  const saved = { fs: stub.workspace.fs, folders: stub.workspace.workspaceFolders, Uri: stub.Uri };
  stub.workspace.workspaceFolders = [{ uri: { path: "/w", with: ({ path }) => ({ path }) } }];
  stub.Uri = Object.assign({}, stub.Uri, { file: (p) => ({ path: p, file: true }) });
  stub.workspace.fs = {
    stat: async (uri) => { if (!(uri.path in files)) throw new Error("ENOENT " + uri.path); return { size: sizes[uri.path] != null ? sizes[uri.path] : files[uri.path].length }; },
    readFile: async (uri) => { reads.push(uri.path); return files[uri.path]; },
  };
  try {
    assert.deepEqual(await imageData("/home/u/.kiro/crew/uploads/x_shot.png"), { data: "data:image/png;base64," + Buffer.from([137, 80, 78, 71]).toString("base64") }, "an upload outside the workspace, read through the folder's remote fs");
    assert.deepEqual(await imageData("/home/u/.kiro/crew/uploads/x_shot.png"), { data: "data:image/png;base64," + Buffer.from([137, 80, 78, 71]).toString("base64") });
    assert.equal(reads.length, 1, "the second ask is served from the cache");
    assert.deepEqual(await imageData("rel/pic.webp"), { data: "data:image/webp;base64," + Buffer.from([1, 2, 3]).toString("base64") }, "a relative path resolves against the workspace folder");
    assert.deepEqual(await imageData("/w/big.jpg"), { error: "too large to preview (8.0 MB)" });
    assert.deepEqual(await imageData("/w/notes.txt"), { error: "not an image file" });
    const gone = await imageData("/gone/x.png");
    assert.match(gone.error, /ENOENT/);
  } finally { stub.workspace.fs = saved.fs; stub.workspace.workspaceFolders = saved.folders; stub.Uri = saved.Uri; }
});

test("chat webview: images — composer thumbnails, bubble attachments from markers + meta.files, markdown pictures, the lightbox, drop", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(/<div id="lightbox" role="dialog" aria-modal="true"/.test(html) && /class="lb-open">Open file</.test(html), "a lightbox with Open file");
  assert.ok(/\.chip\.img img\{display:block;height:48px/.test(html), "a 48px thumbnail chip in the composer");
  assert.ok(/\.user \.att img,\.md img\.mdimg\{[^}]*cursor:zoom-in/.test(html), "pictures in the bubble and in answers open on click");
  assert.ok(html.includes("function attachmentsOf(content, files)") && html.includes("src.startsWith(f.path, end)"), "markers resolve losslessly against meta.files (a path with a space survives)");
  assert.ok(html.includes("function userBubble(d, content, contexts, files)") && /const d=el\(st,'user'\); userBubble\(d, m\.text, m\.contexts, m\.files\)/.test(html) && /if\(cls==='user'\)\{userBubble\(d, r\.content, null, \(r\.meta&&r\.meta\.files\)\|\|\[\]\);\}/.test(html), "one bubble renderer for a live send and a history row");
  assert.ok(html.includes("vscode.postMessage({type:'image', id:active, path})") && /case 'image': imgArrived\(m\)/.test(html), "a local image is fetched through the extension");
  assert.ok(html.includes("const imgCache = new Map(), imgPending = new Set();"), "fetched images are cached per path, one request in flight per path");
  assert.ok(/function renderMd\(node, s\)\{[^\n]*hydrateImages\(node\)/.test(html), "a rendered answer fetches its local images");
  assert.ok(html.includes("composeEl.addEventListener('drop'") && html.includes("async function takeFile(st, f, name)"), "picker, paste and drop share one intake");
  assert.ok(html.includes("if(e.key==='Escape' && lightbox.classList.contains('on'))"), "Esc closes the lightbox");
});

test("chat webview: your turn is drawn the instant you send; the extension's user message completes that bubble in place", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(/function sendText\(t\)\{[\s\S]*?const d=el\(st,'user'\); d\.dataset\.local=local;[\s\S]*?userBubble\(d, shown, contexts\.map/.test(html), "the page draws the bubble before posting the send");
  assert.ok(/st\.running=true; setWork\(st\); scrollLog\(st, true\);\n  vscode\.postMessage\(\{type:'send', id:active, text:t, contexts, files, local\}\)/.test(html), "the pane goes to working at once; the send carries the local id");
  assert.ok(html.includes("const shown = t || (files.length ? 'See the attached file(s).' : 'See the context provided.');"), "the stand-in text matches the extension's");
  assert.ok(/case 'user': \{[\s\S]*?const own = m\.local \? st\.log\.querySelector\('\.row\.user\[data-local="'\+m\.local\+'"\]'\) : null;\n\s*if\(own\)\{ own\.innerHTML=''; userBubble\(own, m\.text, m\.contexts, m\.files\); break; \}/.test(html), "a user message naming the local id updates that bubble instead of appending");
});

test("ChatView.send: the user message carries the page's local id, and a failed send releases the pane the page already set to working", async () => {
  const { ChatView } = ext.__test;
  const calls = { posted: [], sent: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents: [],
    create: async () => "k1", inject: async () => {}, setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {},
    upload: async (name) => "/data/uploads/" + name,
    send: async (key, text) => { if (/boom/.test(text)) throw new Error("host down"); calls.sent.push(text); },
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => calls.posted.push(m);
  const t = chat.newTab(true);
  await chat.onMessage({ type: "send", id: t.id, text: "hello", local: "l7", files: [{ name: "shot.png", mime: "image/png", data: "AAAA" }] });
  const user = calls.posted.find((m) => m.type === "user");
  assert.equal(user.local, "l7", "the bubble the page drew is the one completed");
  assert.deepEqual(user.files.map((f) => f.path), ["/data/uploads/shot.png"], "with the uploaded paths");
  assert.ok(!calls.posted.some((m) => m.type === "done"), "a send that went out does not release the pane (the turn is running)");
  // A dispatch (Run all tasks) has no local id: the user row is appended as before.
  await chat.dispatch(() => "Run all tasks for this spec.", { mode: "spec", kind: "spec", display: "Run all tasks" });
  const disp = calls.posted.filter((m) => m.type === "user").pop();
  assert.equal(disp.local, undefined);
  assert.equal(disp.text, "Run all tasks");
  // The host refuses the send: the error row lands and the page's pane is released with a done.
  const before = calls.posted.length;
  await chat.onMessage({ type: "send", id: t.id, text: "boom", local: "l8" });
  const after = calls.posted.slice(before).map((m) => m.type);
  assert.ok(after.includes("done") && after.includes("error"), "released and told: " + after.join(","));
  assert.equal(calls.posted.slice(before).find((m) => m.type === "error").text, "host down");
});

test("chat webview: follow mode and the Jump-to-latest pill (the dashboard's scroll-to-bottom)", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(/<button type="button" id="jump" class="jump" hidden data-testid="jump-to-latest"/.test(html), "the pill is in the pane, hidden until the view is scrolled up");
  assert.ok(/\.jump\{position:absolute;left:50%;bottom:10px;transform:translateX\(-50%\)/.test(html), "centred over the pane's bottom edge");
  assert.ok(/\.jump\.new\{background:var\(--vscode-button-background\)/.test(html), "accented once new content arrived unseen");
  assert.ok(html.includes("const FOLLOW_PX = 8;") && /function atBottom\(log\)\{ return log\.scrollHeight - log\.scrollTop - log\.clientHeight <= FOLLOW_PX; \}/.test(html), "at-bottom within 8px, as the dashboard's follow threshold");
  assert.ok(/function scrollLog\(st, force\)\{[\s\S]*if\(st\.follow !== false\)\{ st\.log\.scrollTop = st\.log\.scrollHeight; st\.unseen = false; \}\n  else st\.unseen = true;/.test(html), "a new row scrolls only while following; otherwise it is noted as unseen");
  assert.ok(/case 'scroll': scrollLog\(st, true\)/.test(html) && /st\.running=true; setWork\(st\); scrollLog\(st, true\); break; \}/.test(html), "a reload and your own turn always land at the bottom");
  assert.ok(/case 'clear':[^\n]*st\.follow=true; st\.unseen=false; jumpUpdate\(st\)/.test(html), "a cleared pane follows again");
  assert.ok(/log\.addEventListener\('scroll', \(\)=>\{ pinSchedule\(\); followUpdate\(state\.get\(id\)\); \}, \{ passive:true \}\)/.test(html), "the pane's own scroll re-judges following");
  assert.ok(html.includes("jumpLabel.textContent = st.unseen ? 'New messages' : 'Jump to latest';"), "two labels");
  assert.ok(/jump\.onclick = \(\)=>\{[\s\S]*st\.follow = true; st\.unseen = false; jumpUpdate\(st\);[\s\S]*scrollTo\(\{ top: st\.log\.scrollHeight, behavior: reduce \? 'auto' : 'smooth' \}\)/.test(html), "the click re-arms following and scrolls smoothly (instant under reduced motion)");
  assert.ok(/function show\(id\)\{[^\n]*jump\.hidden=true; const st=state\.get\(id\); if\(st\) followUpdate\(st\);/.test(html), "the pill belongs to the active tab");
});

test("chat webview: KiroCrew's transcript shape — user bubble on the right, bare assistant text, small radii, four hopping foxes while working", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(/\.log\.on\{[^}]*flex-direction:column/.test(html), "rows stack in a flex column");
  assert.ok(/\.user\{[^}]*align-self:flex-end/.test(html) && /\.user\{[^}]*width:fit-content/.test(html), "user turn is a right-aligned bubble");
  assert.ok(/\.user\{[^}]*border-radius:6px/.test(html), "bubble radius stays small (squared look)");
  assert.ok(!/\.options button\{[^}]*border-radius:12px/.test(html), "no pill buttons");
  assert.ok(/\.md code\{[^}]*font-size:\.9em/.test(html) && /\.md pre\{[^}]*padding:10px 12px/.test(html), "code styling as the dashboard's msg-content");
  assert.ok(/\.work img:nth-child\(4\)\{animation-delay/.test(html), "four staggered foxes");
  assert.ok(/@keyframes kide-hop/.test(html) && /prefers-reduced-motion/.test(html), "hop keyframe with a reduced-motion fallback");
  assert.ok(/for\(let i=0;i<4;i\+\+\)/.test(html) && /function setWork\(st\)/.test(html), "the indicator is built per pane and driven by setWork");
});

test("chat webview: every inline script parses (it is JavaScript inside a template literal), and a hint pick only asks", async () => {
  const vm = await import("node:vm");
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
  assert.ok(scripts.length >= 1, "the composer script is inline");
  for (const body of scripts) new vm.Script(body, { filename: "chat-webview.js" });
  const composer = scripts.find((s) => s.includes("p-agent"));
  assert.ok(composer && composer.includes("kind==='hint'") && composer.includes("type:'hint'"), "a hint row posts `hint` and changes no setting");
});

test("ChatView remembers which tab was in front: a restored window opens on it, not on the first tab", async () => {
  const { ChatView } = ext.__test;
  const feed = { on: () => ({ dispose() {} }) };
  const sessions = { projectPath: () => "/w", slot: () => null, mine: () => [], onDidChange: () => ({ dispose() {} }), transcript: async () => [] };
  const store = { saved: undefined };
  const context = { workspaceState: { get: () => store.saved, update: (k, v) => { store.saved = v; } } };
  const three = [{ key: "k1", title: "oldest" }, { key: "k2", title: "middle" }, { key: "k3", title: "newest" }];

  // A record from before 0.30.8 (no `active`): the newest tab, not the oldest.
  store.saved = { tabs: three };
  let chat = new ChatView(context, sessions, feed);
  chat.post = () => {};
  assert.equal(chat.tab(chat.active).key, "k3", "no record of the front tab: the last (newest) one");

  // A record naming the front tab: that one.
  store.saved = { tabs: three, active: "k2" };
  chat = new ChatView(context, sessions, feed);
  chat.post = () => {};
  assert.equal(chat.tab(chat.active).key, "k2");

  // Selecting a tab (the webview's click) is persisted at once, so a reload comes back on it.
  await chat.onMessage({ type: "select", id: chat.tabForKey("k1").id });
  assert.equal(store.saved.active, "k1", "select saves the front tab");
  assert.deepEqual(store.saved.tabs.map((t) => t.key), ["k1", "k2", "k3"], "the tabs themselves are unchanged");
  // Opening a session from History selects and persists it too.
  await chat.open("k3");
  assert.equal(store.saved.active, "k3");
  // Closing the front tab moves the selection and persists the move.
  chat.closeTab(chat.tabForKey("k3").id);
  assert.equal(chat.tab(chat.active).key, "k2");
  assert.equal(store.saved.active, "k2");
  // A draft tab in front has no key: the record says null, and a restore falls back to the newest chat.
  chat.newTab(true);
  chat.saveTabs();
  assert.equal(store.saved.active, null);
  chat = new ChatView(context, sessions, feed);
  chat.post = () => {};
  assert.equal(chat.tab(chat.active).key, "k2", "a draft in front at save time: the newest saved chat on restore");
  // A stale key (the session was closed elsewhere and its tab dropped) falls back the same way.
  store.saved = { tabs: three.slice(0, 2), active: "gone" };
  chat = new ChatView(context, sessions, feed);
  chat.post = () => {};
  assert.equal(chat.tab(chat.active).key, "k2");
  // An unknown id is ignored by select.
  const before = chat.active;
  chat.select(999);
  assert.equal(chat.active, before);
});

test("chat webview: the host's inject rows parse into the dashboard's recovery card (its prefix table, wording, chip and severity)", async () => {
  const vm = await import("node:vm");
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("function parseInject("));
  assert.ok(script, "the parser lives in the webview script");
  const start = script.indexOf("const INJECT_KINDS="), end = script.indexOf("// The dashboard's lucide icons");
  assert.ok(start > 0 && end > start, "the parser block is self-contained");
  const ctx = vm.createContext({});
  vm.runInContext(script.slice(start, end) + "\nthis.parseInject = parseInject; this.INJECT_KINDS = INJECT_KINDS;", ctx);
  const { parseInject, INJECT_KINDS } = ctx;
  assert.equal(INJECT_KINDS.length, 15, "the dashboard's fifteen prefixes");
  // The real thing: a blocked shell call, the first word after the prefix picks the detail, the pattern is the chip.
  const blocked = "[Tool blocked — reason sent to the agent] policy\n[Kiro Crew host notice] The tool call you just made was blocked by a Kiro Crew safety policy. This was NOT a user action — the user did not cancel, reject, or interrupt anything.\n\nBlocked: cd ~/.kiro/crew && python - <<'EOF'\nprint(1)\nEOF: Blocked by security policy: (?:\\A|[;&|\\n`]|\\$\\()[\\s\"'(]*[\\w.:/\\\\-]*kiro[-.]?crew\\b[^|;&#>/*]*\\btoken\\b\nMatched structurally on the command's argv, not by the pattern text above.";
  const c = parseInject(blocked, { mid: "m-1" });
  assert.equal(c.kind, "tool_blocked");
  assert.equal(c.severity, "attention");
  assert.equal(c.title, "Tool call blocked");
  assert.equal(c.detail, "safety policy blocked the call · the agent was told why, in this turn");
  assert.equal(c.chip, "(?:\\A|[;&|\\n`]|\\$\\()[\\s\"'(]*[\\w.:/\\\\-]*kiro[-.]?crew\\b[^|;&#>/*]*\\btoken\\b", "the pattern after 'Blocked by security policy:' is the chip");
  assert.ok(c.body.startsWith("[Kiro Crew host notice]") && !c.body.includes("reason sent to the agent] policy"), "the body is the notice without the prefix line");
  assert.equal(parseInject("[Tool blocked — reason sent to the agent] invalid_name\nx", {}).detail, "tool name validation blocked the call · the agent was told why, in this turn");
  assert.equal(parseInject("[Tool blocked — reason sent to the agent] hook_error\nx", {}).detail, "a hook faulted before the call · the agent was told why, in this turn");
  // Several blocked calls: a bullet per call, the distinct patterns counted.
  const multi = "[Tool refusal — automatic recovery]\n- a: Blocked by security policy: one\n- b: Blocked by security policy: two\n- c: Blocked by security policy: one";
  const m = parseInject(multi, {});
  assert.deepEqual([m.kind, m.title, m.chip, m.severity, m.detail], ["refusal", "3 tool calls blocked", "2 patterns", "attention", "safety policy blocked the call · continuation sent automatically"]);
  assert.ok(m.body.startsWith("- a:"), "a refusal keeps the whole text after the prefix as its body");
  // The routine kinds: title + detail from the table, no chip, the text after the prefix as the body.
  const cont = parseInject("[Continue — requested by the user]\nThe previous turn was interrupted before it finished…", { injectKind: "recovery" });
  assert.deepEqual([cont.kind, cont.title, cont.detail, cont.chip, cont.severity], ["manual", "Continued at your request", "resuming the interrupted turn", "", "routine"]);
  assert.equal(cont.body, "The previous turn was interrupted before it finished…");
  assert.deepEqual([parseInject("[Interrupted turn — automatic recovery]\nx", {}).title, parseInject("[Interrupted turn — automatic recovery]\nx", {}).detail], ["Turn interrupted", "backend error · continuation sent automatically"]);
  assert.equal(parseInject("[Tool stall — automatic recovery]\nx", {}).severity, "attention");
  assert.equal(parseInject("[Stalled turn — automatic recovery]\nx", {}).title, "Turn stalled");
  assert.equal(parseInject("[SYSTEM] Sub-agent synthesis: all sub-agents returned", {}).title, "Sub-agents finished");
  const halted = parseInject("[Stop-hook nudge cap reached] loop #7\nthe hook asked 7 times", {});
  assert.deepEqual([halted.title, halted.chip, halted.body, halted.severity], ["Hook loop halted", "#7", "the hook asked 7 times", "attention"]);
  // No known prefix: the generic card only for recovery/synthesis kinds; a cron or replayed turn is not a card.
  const g = parseInject("something the gateway said", { injectKind: "recovery" });
  assert.deepEqual([g.kind, g.title, g.detail, g.body, g.severity], ["generic", "System notice", "injected by the gateway", "something the gateway said", "routine"]);
  assert.equal(parseInject('[Cron notification from "x"]\nhello', { injectKind: "cron" }), null);
  assert.equal(parseInject("looks like its done now", { injectKind: "user_replay" }), null);
  assert.equal(parseInject("plain", {}), null);
  // The renderer: a card row with the chevron header and a hidden body; automation notices are not drawn.
  assert.ok(/if\(r\.role==='inject'\)\{\s*const meta=r\.meta\|\|\{\}; if\(meta\.injectKind==='automation_notice'\) return;/.test(script), "an automation_notice row renders nothing");
  assert.ok(script.includes("injectCard(el(st,'recov'), c)"), "a parsed row is the recovery card, not a tool row");
  assert.ok(script.includes("d.dataset.testid='recovery-card'") && script.includes("ch.dataset.testid='recovery-card-chip'") && script.includes("body.dataset.testid='recovery-card-body'"), "the dashboard's test ids");
  assert.ok(/\.recov\{[^}]*border-radius:6px/.test(html) && /\.recov\[data-severity="attention"\] \.rc-ico\{color:var\(--vscode-editorWarning-foreground/.test(html), "a squared card; the attention icon in the warning colour");
});

test("chat webview: Kiro's task_status bookkeeping rows name the task from the action id and explain themselves instead of '(no output)'", async () => {
  const vm = await import("node:vm");
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("function taskStatusOf("));
  const start = script.indexOf("const TASK_STATUS_NOTE="), end = script.indexOf("function toolRow(");
  const ctx = vm.createContext({});
  vm.runInContext(script.slice(start, end) + "\nthis.taskStatusOf = taskStatusOf;", ctx);
  const taskStatusOf = (meta, title) => { const r = ctx.taskStatusOf(meta, title); return r === null ? null : JSON.parse(JSON.stringify(r)); };  // out of the vm realm for deepEqual
  // The ids KAS emits: <model tool id>_taskStatus_<task line sanitized>, capped at 64 chars (17 left for the task).
  assert.deepEqual(taskStatusOf({ tool_call_id: "toolu_bdrk_018Vex9cLiVXZq8nmRBxV3t5_taskStatus_1_1_Create__conne" }, "task_status"), { id: "1.1", text: "Create conne", label: "Task status · 1.1 Create conne…" }, "a dotted sub-task number and the title's start");
  assert.deepEqual(taskStatusOf({ tool_call_id: "toolu_bdrk_01BuNqZR7F5Z7NQJXrd84GHx_taskStatus_3__S2___case_reco" }, "task_status"), { id: "3", text: "S2 case reco", label: "Task status · 3 S2 case reco…" }, "punctuation sanitized to underscores collapses to spaces");
  assert.deepEqual(taskStatusOf({ tool_call_id: "x_taskStatus_12" }, "task_status"), { id: "12", text: "", label: "Task status · 12" });
  assert.deepEqual(taskStatusOf({ tool_call_id: "x_taskStatus_" }, "task_status").label, "Task status", "a truncated-away task keeps the plain label");
  assert.deepEqual(taskStatusOf({ tool_call_id: "toolu_1" }, "task_status").label, "Task status", "the title alone marks the row when the id carries nothing");
  assert.equal(taskStatusOf({ tool_call_id: "toolu_1" }, "Read File"), null, "an ordinary tool row is untouched");
  assert.equal(taskStatusOf({}, "execute_bash"), null);
  assert.ok(script.includes("ic.textContent=ts ? '📋'") && script.includes("note: ts?TASK_STATUS_NOTE:''"), "the row gets the clipboard icon and the note in its body");
  assert.ok(script.includes("else if(t.note){ t.outPre.textContent=t.note; k.textContent='Note'; }"), "an empty output on a bookkeeping row shows the note, not '(no output)'");
  assert.ok(script.includes("if(title && !t.note){"), "a later tool_call update does not rename the decoded row back to task_status");
});

test("chat webview: thinking deltas accumulate into one collapsed block (KiroCrew's ThinkingBlock), never one row per delta", () => {
  const { chatHtml } = ext.__test;
  const html = chatHtml("fox.svg");
  assert.ok(!html.includes("'… '+m.text"), "no '…'-prefixed row per delta");
  assert.ok(!/el\(st,'thinking'/.test(html), "thinking is not a plain transcript row");
  assert.ok(/case 'thinking': if\(m\.text\)\{thinkDelta\(st, m\.text\)/.test(html), "a delta feeds the block");
  assert.ok(html.includes("const THINK_QUIET_MS = 1200, THINK_LIVE_CHARS = 240"), "the host's quiet window and live-line tail");
  assert.ok(html.includes("label.textContent='Thinking'") && html.includes("t.label.textContent='Thought process'"), "the host's two labels");
  assert.ok(/case 'row': thinkClose\(st\); row\(/.test(html) && /case 'segment': finishStream\(st\); thinkClose\(st\)/.test(html) && /case 'done': finishStream\(st\); thinkClose\(st\)/.test(html), "a row, a segment cut and done close the phase");
  assert.ok(html.includes("if(st.streaming) st.log.insertBefore(box, st.streaming)"), "the block goes above the answer streaming under it");
  assert.ok(/\.think\.live\[data-open="false"\] \.think-live\{display:block\}/.test(html), "the live line shows only while live and collapsed");
  assert.ok(html.includes("if(r.role==='thinking'){ if(r.content){ thinkDelta(st, r.content); thinkClose(st);"), "a persisted thinking row renders as a closed block");
});


test("Sessions.mine() is scoped to the open workspace's project, not the IDE folder or key prefix", () => {
  const { Sessions } = ext.__test;
  const feed = { on: () => ({ dispose() {} }) };
  const s = new Sessions(feed);
  s.folderId = "ide-folder";
  s.slots = [
    { key: "kirocrew-ide-chat-1", project: "/local/home/u/workplace/A", folder_id: "ide-folder" },
    { key: "kirocrew-ide-chat-2", project: "/home/u/workplace/B", folder_id: "ide-folder" },      // another workspace, same IDE folder
    { key: "chat-1-1790180959", project: "/home/u/workplace/A" },                                // dashboard-created, this folder (symlinked spelling)
    { key: "chat-1-1790180960", project: "" },                                                   // dashboard, no project
    { key: "kirocrew-ide-chat-3", project: "" },                                                 // ours, no project
  ];
  s.projectPath = () => "/local/home/u/workplace/A";
  assert.deepEqual(s.mine().map((x) => x.key), ["kirocrew-ide-chat-1", "chat-1-1790180959"]);
  s.projectPath = () => "";
  assert.deepEqual(s.mine().map((x) => x.key), ["kirocrew-ide-chat-3"], "no folder open: only our own project-less sessions");
});

test("slotTime reads the host's ISO stamps as well as epoch seconds and milliseconds", () => {
  const { slotTime, slotActivity } = ext.__test;
  // What the dashboard actually projects: datetime.isoformat() strings (with and without a +00:00 offset / microseconds).
  assert.equal(slotTime("2026-10-05T14:27:09.258+00:00"), Date.UTC(2026, 9, 5, 14, 27, 9, 258));
  assert.equal(slotTime("2026-10-05T14:27:09Z"), Date.UTC(2026, 9, 5, 14, 27, 9));
  assert.equal(slotTime("2026-10-05T14:27:09.258123+00:00"), Date.UTC(2026, 9, 5, 14, 27, 9, 258), "microseconds are tolerated");
  assert.equal(slotTime(1791000000), 1791000000 * 1000, "epoch seconds");
  assert.equal(slotTime("1791000000"), 1791000000 * 1000, "numeric string of seconds");
  assert.equal(slotTime(1791000000123), 1791000000123, "epoch milliseconds");
  for (const bad of ["", null, undefined, "garbage", "NaN", 0, -5]) assert.equal(slotTime(bad), 0, "unparsable -> 0: " + JSON.stringify(bad));
  // The row's activity is the newest of its stamps, whatever the host filled in.
  assert.equal(slotActivity({ created: "2026-10-01T00:00:00Z", last_activity_ts: "2026-10-03T00:00:00Z" }), Date.UTC(2026, 9, 3));
  assert.equal(slotActivity({ created: "2026-10-01T00:00:00Z", last_activity_ts: "" }), Date.UTC(2026, 9, 1), "a fresh session with no assistant turn yet dates from its creation");
  assert.equal(slotActivity({}), 0);
});

test("ageLabel never prints 'Invalid Date': a relative age under a week, a date past it, nothing for no stamp", () => {
  const { ageLabel } = ext.__test;
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  assert.equal(ageLabel(0, now), "");
  assert.equal(ageLabel(now - 20 * 1000, now), "just now");
  assert.equal(ageLabel(now - 7 * 60000, now), "7 min ago");
  assert.equal(ageLabel(now - 3 * 3600000, now), "3 h ago");
  assert.equal(ageLabel(now - 2 * 86400000, now), "2 d ago");
  const old = ageLabel(now - 30 * 86400000, now);
  assert.ok(/2026/.test(old) && !/Invalid/.test(old), "older than a week shows a real date: " + old);
  assert.ok(!/Invalid/.test(ageLabel(NaN, now)));
});

test("Sessions.history() lists the most recent activity first from the host's ISO stamps", () => {
  const { Sessions } = ext.__test;
  const s = new Sessions({ on: () => ({ dispose() {} }) });
  s.projectPath = () => "/home/u/p";
  s.slots = [
    { key: "old-created-only", project: "/home/u/p", created: "2026-09-20T10:00:00+00:00", last_activity_ts: "" },
    { key: "newest", project: "/home/u/p", created: "2026-10-01T00:00:00+00:00", last_activity_ts: "2026-10-05T09:30:00.120000+00:00" },
    { key: "middle", project: "/home/u/p", created: "2026-09-28T00:00:00+00:00", last_activity_ts: "2026-10-02T08:00:00+00:00" },
    { key: "no-stamps", project: "/home/u/p" },
    { key: "running-same-stamp", project: "/home/u/p", created: "2026-09-28T00:00:00+00:00", last_activity_ts: "2026-10-02T08:00:00+00:00", running: true },
  ];
  assert.deepEqual(s.history().map((x) => x.key), ["newest", "running-same-stamp", "middle", "old-created-only", "no-stamps"]);
  // The old comparator did Number(iso) - Number(iso) = NaN, which left the host's order untouched; make sure that is gone.
  assert.notDeepEqual(s.history().map((x) => x.key), s.slots.map((x) => x.key));
});


test("kasAgentFor: a Kiro Spec & Plan agent takes over a mode; otherwise the prompt frame stays", async () => {
  const { kasAgentFor, ChatView } = ext.__test;
  const agents = [{ name: "desk-default" }, { name: "spec" }, { name: "plan" }];
  assert.equal(kasAgentFor("spec", agents), "spec");
  assert.equal(kasAgentFor("plan", agents), "plan");
  assert.equal(kasAgentFor("bug-fix", agents), null, "mod agent absent -> fall back");
  assert.equal(kasAgentFor("default", agents), null);
  assert.equal(kasAgentFor("spec", []), null);

  // Through send(): with the agent present, the session is created ON it and no frame is injected.
  const calls = { created: [], injected: [], sent: [] };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }), agents,
    create: async (o) => { calls.created.push(o); return "k2"; },
    inject: async (k, c, src) => { calls.injected.push(src); },
    send: async (k, text, agent) => { calls.sent.push(agent); },
    setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {},
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
  await chat.dispatch("PHASE: DESIGN …", { mode: "spec", title: "t", kind: "spec" });
  assert.equal(calls.created[0].agent, "spec");
  assert.deepEqual(calls.injected, [], "Kiro's own workflow: no paraphrased frame");
  assert.deepEqual(calls.sent, ["spec"]);
});

test("agentPicks: one sectioned picker — Kiro modes when the mod's agents exist, prompt workflows otherwise, then agents", () => {
  const { agentPicks, modeOfAgent, mergeRosters } = ext.__test;
  const withMod = agentPicks([{ name: "desk-default" }, { name: "spec" }, { name: "plan" }, { name: "kirocrew-skill-view-abc" }]);
  assert.deepEqual(withMod.map((p) => p.section + "|" + p.id), [
    "Kiro modes|agent:spec", "Kiro modes|agent:plan", "Your agents|", "Your agents|agent:desk-default",
  ], "mode agents and skill views never appear as plain agents");
  assert.ok(withMod[0].kiro);
  const without = agentPicks([{ name: "desk-default" }]);
  // Seen live: with kiro-spec-plan absent the picker showed the stand-ins with nothing saying
  // where Kiro's own modes come from, and "Spec" silently ran on the default agent. The
  // section now opens with a hint row that names the mod; it is not a pick (id kind `hint`).
  assert.deepEqual(without.map((p) => p.id), ["hint:kiro-spec-plan", "workflow:spec", "workflow:quick-spec", "workflow:bug-fix", "workflow:plan", "", "agent:desk-default"]);
  assert.equal(without[0].section, "Workflows (prompt-guided)");
  assert.ok(without[0].hint && /kiro-spec-plan/.test(without[0].label) && /floofy install kiro-spec-plan/.test(without[0].description));
  assert.ok(without.slice(1).every((p) => !p.hint), "exactly one hint row");
  assert.ok(!withMod.some((p) => p.hint), "no hint once the mode agents exist");
  // The webview's pick handler derives kind from the id; a hint must never be mistaken for an agent or a workflow.
  assert.ok(!without[0].kiro && without[0].id.split(":")[0] === "hint");
  assert.equal(modeOfAgent("quick-spec"), "quick-spec");
  assert.equal(modeOfAgent("desk-default"), null);
  const merged = mergeRosters([{ name: "desk-default", description: "d" }], [{ name: "desk-default" }, { name: "spec", description: "Kiro mode" }, { name: "kirocrew-lite" }]);
  assert.deepEqual(merged.map((a) => a.name + ":" + a.source), ["desk-default:crew", "spec:installed"]);
});



test("chat view: nothing is pushed before the webview says ready; a silent visible view is reloaded, then reported", async () => {
  // Seen live (0.11.1): the chat pane came up blank on a cold workbench start and only a
  // close/reopen of the panel cured it. The extension now waits for the document's `ready`
  // and reloads a visible view that never sends it, so the cure is automatic.
  const { ChatView } = ext.__test;
  const warnings = [];
  stub.window.createOutputChannel = () => ({ appendLine() {}, show() {} });
  stub.window.showWarningMessage = (text, ...actions) => { warnings.push({ text, actions }); return Promise.resolve(undefined); };
  const sessions = {
    projectPath: () => "/w", slot: () => null, onDidChange: () => ({ dispose() {} }),
    refresh: async () => {}, agents: async () => [], transcript: async () => [], mine: () => [],
  };
  const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} }, extensionUri: { path: "/ext" } }, sessions, { on: () => ({ dispose() {} }) });
  chat.pushChoices = async () => { chat.post({ type: "choices" }); };
  const posted = [];
  const htmls = [];
  let receive = null;
  const view = {
    visible: true,
    webview: { options: null, set html(v) { htmls.push(v); }, asWebviewUri: (u) => ({ toString: () => "wv:" + u.path }), postMessage: (m) => posted.push(m), onDidReceiveMessage: (fn) => { receive = fn; } },
    onDidDispose() {}, onDidChangeVisibility() {},
  };
  const timers = [];
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  const pending = () => timers.filter((t) => t.fn).length;
  const fire = () => { const t = timers.filter((t) => t.fn).pop(); const fn = t.fn; t.fn = null; fn(); };
  try {
    chat.resolveWebviewView(view);
    assert.equal(htmls.length, 1, "the document is set once on resolve");
    assert.equal(posted.length, 0, "no tabs/choices are posted before ready");
    assert.equal(pending(), 1, "a watchdog is armed for the visible view");
    // the document never loads: the watchdog reloads it (twice), then gives up with a notification
    fire();
    assert.equal(htmls.length, 2, "first reload");
    fire();
    assert.equal(htmls.length, 3, "second reload");
    fire();
    assert.equal(htmls.length, 3, "no third reload");
    assert.equal(warnings.length, 1, "the user is told once");
    assert.ok(warnings[0].actions.includes("Reload chat view"), "with a reload action");
    // the document finally says hello: tabs and choices go out, the watchdog is quiet
    await receive({ type: "ready" });
    assert.ok(posted.some((m) => m.type === "tabs") && posted.some((m) => m.type === "choices"), "tabs and choices pushed on ready");
    assert.equal(pending(), 0, "watchdog disarmed");
    // a hidden view is never reloaded (nothing to see), and the manual command always reloads
    view.visible = false;
    chat.setHtml();
    assert.equal(pending(), 0, "no watchdog while hidden");
    chat.reload("command");
    assert.equal(htmls.length, 5);
  } finally {
    // Both, or every later test's clearTimeout is this stub's no-op and real timers fire twice.
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("a slot's served model is shown but never becomes a pick: new tabs do not inherit it, and a retired id is dropped, not pinned", async () => {
  // The bug: pushTabs() wrote the slot's model into the tab's picks, the last
  // tab's picks seeded every new tab, and send() pinned that model on the new
  // session. Once the host default was a model the catalog had retired
  // (claude-fable-5 after kiro-cli 2.26.0), every new IDE session died with
  // InvalidModelError, and kept doing so after the host default was fixed.
  const { ChatView } = ext.__test;
  const slots = { k1: { model: "claude-fable-5", reasoning_effort: "high", trust: false, agent: "default" } };
  const calls = { setModel: [] };
  const posted = [];
  const sessions = {
    projectPath: () => "/w", agents: [],
    slot: (k) => slots[k] || null,
    onDidChange: () => ({ dispose() {} }),
    refresh: async () => {},
    models: async () => [{ id: "claude-fable-5.1", label: "Fable 5.1" }],
    effortLevels: async () => ["low", "high"],
    create: async () => "k2", inject: async () => {}, send: async () => {},
    setModel: async (key, model) => { calls.setModel.push({ key, model }); }, setEffort: async () => {}, setTrust: async () => {}, setSlotAgent: async () => {},
  };
  const saved = { tabs: [{ key: "k1", title: "old", settings: { agent: "", model: "claude-fable-5", effort: "", mode: "default", autopilot: false } }] };
  const context = { workspaceState: { get: () => saved, update: (k, v) => { saved.tabs = v.tabs; } } };
  const chat = new ChatView(context, sessions, { on: () => ({ dispose() {} }) });
  chat.post = (m) => posted.push(m);

  // Display follows the slot; the pick stays what the user chose (here: the persisted retired id, pruned below).
  chat.pushTabs();
  const shown = posted.filter((m) => m.type === "tabs").pop().tabs[0].settings;
  assert.equal(shown.model, "claude-fable-5", "the served model is displayed");
  assert.equal(shown.effort, "high");
  assert.equal(chat.tabForKey("k1").live.model, "claude-fable-5");

  // Reading the catalog prunes the retired id from the tab, from the inherited defaults, and from what is saved.
  await chat.pushChoices();
  assert.equal(chat.tabForKey("k1").settings.model, "", "retired pick dropped on the tab");
  assert.equal((chat.lastSettings || {}).model || "", "", "retired pick dropped from the inherited defaults");
  assert.equal(saved.tabs[0].settings.model, "", "the saved picks no longer carry it");

  // A slot now serving the live default must not leak into the next tab's picks either.
  slots.k1.model = "claude-fable-5.1";
  chat.pushTabs();
  assert.equal(chat.tabForKey("k1").settings.model, "", "served model is not written into the picks");
  const fresh = chat.newTab(true);
  assert.equal(fresh.settings.model, "", "a new tab inherits picks, not the served model");

  // And a draft tab carrying a retired pick sends on the agent's model instead of pinning it.
  fresh.settings.model = "claude-fable-5";
  await chat.send(fresh, { text: "hi" });
  assert.deepEqual(calls.setModel, [], "no setModel call with a retired id");
  assert.equal(fresh.settings.model, "");
  assert.ok(posted.some((m) => m.type === "error" && /no longer offered/.test(m.text)), "the user is told why");
});

test("the host's turn-ceiling card is recognised in both row shapes, and only that card", () => {
  const { isTurnLimitRow, turnLimitOf } = ext.__test;
  const card = "⏱️ This turn hit the 4-hour limit and was stopped. Work already written to disk is still there — nothing was rolled back. Send a message to continue from where it stopped.";
  assert.equal(isTurnLimitRow({ role: "error", cls: "msg msg-err", content: card }), true, "as the slot log writes it");
  assert.equal(isTurnLimitRow({ role: "assistant", cls: "msg msg-err", content: card }), true, "as a msg-err assistant row");
  assert.equal(isTurnLimitRow({ role: "error", content: "⏱️ This turn hit the 30-minute limit and was stopped. …" }), true, "a raised/lowered ceiling");
  assert.equal(isTurnLimitRow({ role: "assistant", content: card }), true, "the ⏱ prefix alone marks the row as a failure");
  assert.equal(isTurnLimitRow({ role: "error", content: "⏱️ A tool needed your approval and nothing came back within 2 hours, so I declined it…" }), false, "the approval-timeout card is a different thing");
  assert.equal(isTurnLimitRow({ role: "assistant", content: "we hit the 4-hour limit and was stopped by the referee" }), false, "plain prose is not a failure row");
  assert.equal(turnLimitOf(card), "4-hour");
  assert.equal(turnLimitOf("⏱️ This turn hit the 30-minute limit and was stopped."), "30-minute");
  assert.equal(turnLimitOf("something else"), "time");
});

/** A workspace with one spec whose tasks.md is partly ticked, for the resume tests. */
function specWorkspace(tasksMd) {
  const home = "/local/home/someone";
  const spec = home + "/proj/.kiro/specs/thing";
  const tree = { [home + "/proj/.kiro/specs"]: [["thing", 2]], [home + "/proj/.kiro/steering"]: [] , [home + "/.kiro/steering"]: [] };
  const files = { [spec + "/requirements.md"]: "# R", [spec + "/design.md"]: "# D", [spec + "/tasks.md"]: tasksMd, [home + "/.kiro/crew/config.json"]: JSON.stringify({ acp_backend: "kas" }) };
  const saved = { fs: stub.workspace.fs, folders: stub.workspace.workspaceFolders, FileType: stub.FileType, window: stub.window };
  stub.FileType = { Directory: 2, File: 1 };
  stub.workspace.workspaceFolders = [{ uri: { path: home + "/proj", with: ({ path }) => ({ path }) } }];
  stub.workspace.fs = {
    readDirectory: async (uri) => { if (!(uri.path in tree)) throw new Error("ENOENT " + uri.path); return tree[uri.path].map((e) => [...e]); },
    readFile: async (uri) => { if (!(uri.path in files)) throw new Error("ENOENT " + uri.path); return new TextEncoder().encode(files[uri.path]); },
  };
  stub.window = { visibleTextEditors: [] };
  ext.__test.invalidateSteeringCache(); // the steering inventory is cached between sends; this fixture's tree is new
  return { home, spec, files, restore() { stub.workspace.fs = saved.fs; stub.workspace.workspaceFolders = saved.folders; stub.FileType = saved.FileType; stub.window = saved.window; } };
}

test("resumeRequest rebuilds the run's request from tasks.md as it is now, and says when nothing is left", async () => {
  const { resumeRequest, RESUME_NOTE } = ext.__test;
  const ws = specWorkspace(["- [x] 1. Done", "- [-] 2. Half way", "  - [x] 2.1 Part", "  - [ ] 2.2 Rest", "- [ ] 3. Next", "- [ ]* 4. Optional"].join("\n"));
  try {
    const all = { spec: "thing", dir: ws.spec, task: null, optional: false, display: "Run all tasks" };
    const kiro = await resumeRequest(all, "spec");
    assert.match(kiro.text, /^Run all tasks for this spec\. Resume from prior progress: tasks \[1\. Done, 2\.1 Part\] are already completed/, "Kiro's own request, with the ticked tasks to skip");
    assert.ok(kiro.text.endsWith(RESUME_NOTE), "the note about the half-done [-] row rides along");
    assert.equal(kiro.display, "Resume: Run all tasks (2 left)", "2.2 and 3; the optional one is not counted");
    const para = await resumeRequest(all, null);
    assert.match(para.text, /PHASE: EXECUTE REMAINING TASKS\. Run all tasks for this spec\. Resume from prior progress/, "the crew-agent paraphrase otherwise");
    const withOptional = await resumeRequest(Object.assign({}, all, { optional: true, display: "Run all required and optional tasks" }), "spec");
    assert.equal(withOptional.display, "Resume: Run all required and optional tasks (3 left)");
    const one = await resumeRequest({ spec: "thing", dir: ws.spec, task: "3. Next", optional: false, display: "Execute Task: 3. Next" }, "spec");
    assert.match(one.text, /^Execute the following task from the spec at .*\/tasks\.md:\n\n<task title="3\. Next">[\s\S]*Task ID: 3\. Next/, "a single task sends its own request again");
    assert.equal(one.display, "Resume: Execute Task: 3. Next");
    const ticked = await resumeRequest({ spec: "thing", dir: ws.spec, task: "1. Done", optional: false }, "spec");
    assert.equal(ticked.text, null); assert.match(ticked.reason, /task 1\. Done is ticked/);
    const gone = await resumeRequest({ spec: "other", dir: ws.spec, task: null, optional: false }, "spec");
    assert.equal(gone.text, null); assert.match(gone.reason, /spec other is no longer in the workspace/);
    // Every required task ticked: nothing to resume (the optional one does not count unless asked for).
    ws.files[ws.spec + "/tasks.md"] = ["- [x] 1. Done", "- [x] 2. Done too", "- [ ]* 3. Optional"].join("\n");
    const done = await resumeRequest(all, "spec");
    assert.equal(done.text, null); assert.match(done.reason, /every required task in thing is ticked/);
    const optLeft = await resumeRequest(Object.assign({}, all, { optional: true }), "spec");
    assert.match(optLeft.display, /\(1 left\)$/);
  } finally { ws.restore(); }
});

test("a task run resumes itself from tasks.md when the host's ceiling card arrives, up to the cap; a plain chat only gets the button", async () => {
  const { ChatView, RESUME_NOTE, RESUME_CHAT_TEXT } = ext.__test;
  const card = "⏱️ This turn hit the 4-hour limit and was stopped. Work already written to disk is still there — nothing was rolled back. Send a message to continue from where it stopped.";
  const ws = specWorkspace(["- [x] 1. Done", "- [-] 2. Half way", "- [ ] 3. Next"].join("\n"));
  const calls = { sent: [], posted: [], saved: [] };
  const slots = { k1: { running: false } };
  const sessions = {
    projectPath: () => ws.home + "/proj", slot: (k) => slots[k] || null, onDidChange: () => ({ dispose() {} }), agents: [{ name: "spec" }, { name: "o3r" }],
    create: async () => "k1", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, inject: async () => {}, setSlotAgent: async () => {},
    send: async (key, text, agent, meta) => { calls.sent.push({ key, text, agent, meta }); },
  };
  try {
    const chat = new ChatView({ workspaceState: { get: () => undefined, update: (k, v) => calls.saved.push(v) } }, sessions, { on: () => ({ dispose() {} }) });
    chat.post = (m) => calls.posted.push(m);
    chat.settleMs = 0;
    // Run all tasks, the way the Specs view dispatches it (Kiro's request on the Spec agent).
    const key = await chat.dispatch((kiro) => (kiro ? "Run all tasks for this spec." : "paraphrase"), { mode: "spec", title: "Run all tasks", kind: "spec", display: "Run all tasks", autopilot: true, run: { spec: "thing", dir: ws.spec, task: null, optional: false, display: "Run all tasks" } });
    assert.equal(key, "k1");
    const t = chat.tabForKey("k1");
    assert.deepEqual(t.run, { resumed: 0, spec: "thing", dir: ws.spec, task: null, optional: false, display: "Run all tasks" }, "the run record is kept on the tab");
    assert.equal(calls.saved.at(-1).tabs[0].run.spec, "thing", "and persisted with it");
    assert.equal(calls.sent.length, 1);
    // The host cuts the turn: chat_done first, then the card.
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "error", cls: "msg msg-err", content: card, meta: { mid: "m1" } } });
    for (let i = 0; i < 12 && calls.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(calls.posted.some((m) => m.type === "row" && m.row.role === "error" && m.row.content === card), "the card itself is shown (the webview adds Continue)");
    assert.match(calls.posted.filter((m) => m.type === "status").at(-1).text, /^The host stopped this turn at its 4-hour limit; resuming the run from tasks\.md \(1 of 3\)…$/);
    assert.equal(calls.sent.length, 2, "resumed once");
    assert.equal(calls.sent[1].agent, "spec", "on the same Spec agent");
    assert.match(calls.sent[1].text, /^Run all tasks for this spec\. Resume from prior progress: tasks \[1\. Done\] are already completed/, "Kiro's request rebuilt from the current tasks.md");
    assert.ok(calls.sent[1].text.endsWith(RESUME_NOTE));
    assert.equal(calls.posted.filter((m) => m.type === "user").at(-1).text, "Resume: Run all tasks (2 left)", "the transcript shows the short label, as Kiro does");
    assert.equal(t.run.resumed, 1);
    // A replay of the same card (history reload) does not resume again: the mid is seen by the webview, and the counter still moves only per card the extension sees — so feed a fresh one to reach the cap.
    t.run.resumed = 3;
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "error", cls: "msg msg-err", content: card, meta: { mid: "m2" } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.sent.length, 2, "past the cap nothing is sent");
    assert.match(calls.posted.filter((m) => m.type === "error").at(-1).text, /Stopped at the host's 4-hour limit 4 times on this run; not resuming again on its own \(kirocrew\.specResumeLimit = 3\)\. Continue resumes it by hand; agent\.chat_turn_timeout_secs/);
    // The button still works past the cap (the webview posts `resume`).
    await chat.onMessage({ type: "resume", id: t.id });
    assert.equal(calls.sent.length, 3, "Continue resumes by hand");
    assert.match(calls.sent[2].text, /^Run all tasks for this spec\./);
    // While the session runs, Continue sends nothing.
    slots.k1.running = true;
    await chat.onMessage({ type: "resume", id: t.id });
    assert.equal(calls.sent.length, 3);
    assert.match(calls.posted.filter((m) => m.type === "status").at(-1).text, /still running; nothing to resume/);
    slots.k1.running = false;
    // Every task ticked: the card arrives, nothing is sent, and the reason is said.
    ws.files[ws.spec + "/tasks.md"] = "- [x] 1. Done\n- [x] 2. Done\n- [x] 3. Done";
    t.run.resumed = 0;
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "error", cls: "msg msg-err", content: card, meta: { mid: "m3" } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.sent.length, 3);
    assert.match(calls.posted.filter((m) => m.type === "status").at(-1).text, /^Nothing to resume: every required task in thing is ticked\.$/);
    // A plain chat tab: the card is shown, nothing automatic; Continue sends the continuation.
    slots.k2 = { running: false };
    sessions.create = async () => "k2";
    const plain = chat.newTab(true); plain.settings.mode = "default"; plain.settings.agent = "o3r";
    await chat.send(plain, { text: "hello" });
    const before = calls.sent.length;
    chat.onFrame({ type: "chat_message", data: { slot: "k2", role: "error", cls: "msg msg-err", content: card, meta: { mid: "m4" } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.sent.length, before, "a chat does not resume on its own");
    await chat.onMessage({ type: "resume", id: plain.id });
    assert.equal(calls.sent.length, before + 1);
    assert.equal(calls.sent.at(-1).text, RESUME_CHAT_TEXT);
    assert.equal(calls.sent.at(-1).agent, "o3r");
  } finally { ws.restore(); }
});

test("runState / describeLeft / looksLikeQuestion / isSpecTab: the run is judged from tasks.md marks", async () => {
  const { runState, describeLeft, looksLikeQuestion, isSpecTab } = ext.__test;
  const ws = specWorkspace(["- [x] 1. Done", "- [-] 2. Half way", "- [~] 3. Next", "- [~] 4. After", "- [ ] 5. Later", "- [~]* 6. Optional queued"].join("\n"));
  try {
    const all = { spec: "thing", dir: ws.spec, task: null, optional: false };
    assert.deepEqual(await runState(all), { spec: "thing", queued: 2, partial: 1, remaining: 4 }, "required leaves only");
    assert.deepEqual(await runState(Object.assign({}, all, { optional: true })), { spec: "thing", queued: 3, partial: 1, remaining: 5 });
    assert.deepEqual(await runState({ spec: "thing", dir: ws.spec, task: "2. Half way" }), { spec: "thing", queued: 0, partial: 1, remaining: 1 }, "a single-task run reads its task");
    assert.equal(await runState({ spec: "gone", dir: ws.spec, task: null }), null);
    assert.equal(describeLeft({ partial: 1, queued: 10, remaining: 11 }), "1 task in progress and 10 queued");
    assert.equal(describeLeft({ partial: 2, queued: 0, remaining: 3 }), "2 tasks in progress");
    assert.equal(describeLeft({ partial: 0, queued: 0, remaining: 3 }), "3 tasks left");
    assert.equal(describeLeft({ partial: 0, queued: 0, remaining: 0 }), "");
    assert.equal(looksLikeQuestion("Tests fail on 16.1. Fix the fixture or skip it?"), true);
    assert.equal(looksLikeQuestion("Which one?\n\n[OPTIONS: Fix it | Skip it]"), true);
    assert.equal(looksLikeQuestion("Done with 16.1; moving to 17.1."), false);
    assert.equal(looksLikeQuestion(""), false);
    assert.equal(isSpecTab({ kind: "spec", key: "k" }), true);
    assert.equal(isSpecTab({ key: "kirocrew-ide-spec-20261102085551" }), true, "a tab from before tabs carried a kind");
    assert.equal(isSpecTab({ key: "kirocrew-ide-chat-1" }), false);
    assert.equal(isSpecTab(null), false);
  } finally { ws.restore(); }
});

test("a run that stops without the ceiling card is judged from tasks.md: Kiro's [-]/[~] marks left behind resume it; a question, a Stop or startup only offer the card", async () => {
  const { ChatView } = ext.__test;
  const ws = specWorkspace(["- [x] 1. Done", "- [-] 2. Half way", "- [~] 3. Next"].join("\n"));
  const calls = { sent: [], posted: [] };
  const slots = { k1: { running: false } };
  const sessions = {
    projectPath: () => ws.home + "/proj", slot: (k) => slots[k] || null, onDidChange: () => ({ dispose() {} }), agents: [{ name: "spec" }, { name: "o3r" }],
    create: async () => "k1", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, inject: async () => {}, setSlotAgent: async () => {}, stop: async () => {},
    send: async (key, text, agent) => { calls.sent.push({ key, text, agent }); },
  };
  const settle = () => new Promise((r) => setTimeout(r, 25));
  const lastOf = (type) => calls.posted.filter((m) => m.type === type).at(-1);
  try {
    const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
    chat.post = (m) => calls.posted.push(m);
    chat.settleMs = 0;
    await chat.dispatch(() => "Run all tasks for this spec.", { mode: "spec", title: "Run all tasks", kind: "spec", display: "Run all tasks", autopilot: true, run: { spec: "thing", dir: ws.spec, task: null, optional: false, display: "Run all tasks" } });
    const t = chat.tabForKey("k1");
    // 1. The turn ends with no error at all (the model simply stopped): the marks say the run is unfinished.
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "assistant", content: "Dispatching 2 and 3 in parallel.", meta: { mid: "a1" } } });
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    await settle();
    assert.equal(calls.sent.length, 2, "resumed");
    assert.equal(lastOf("status").text, "The turn ended with 1 task in progress and 1 queued, without finishing the run; resuming the run from tasks.md (1 of 3)…");
    assert.match(calls.sent[1].text, /^Run all tasks for this spec\. Resume from prior progress: tasks \[1\. Done\]/);
    // 2. A non-terminal error row mid-turn ("⟳ Connection unstable — resuming…") arms nothing on its own.
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "error", content: "⟳ Connection unstable — resuming…", meta: { mid: "e1" } } });
    await settle();
    assert.equal(calls.sent.length, 2, "no resume while the host is still on the turn");
    // 3. The turn then ends on a host error: the error is the reason, tasks.md the judge.
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "error", cls: "msg msg-err", content: "❌ Backend error: stream reset by peer\nmore detail", meta: { mid: "e2" } } });
    await settle();
    assert.equal(calls.sent.length, 3);
    assert.equal(lastOf("status").text, "The turn ended on an error (❌ Backend error: stream reset by peer); resuming the run from tasks.md (2 of 3)…");
    // 4. The turn ends on a question: nothing is sent, the card offers Resume run.
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "assistant", content: "The fixture for 2 is gitignored. Fix the fixture, or skip the test?", meta: { mid: "a2" } } });
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    await settle();
    assert.equal(calls.sent.length, 3, "a question is not answered with a resume");
    let card = lastOf("interrupted");
    assert.ok(card && card.resume && /seems to be asking you something; answer it, or Resume run/.test(card.text), JSON.stringify(card));
    // 5. A pending question card (ask_question) blocks too, without a Resume button.
    chat.onFrame({ type: "question_card", data: { slot: "k1", ask_id: "q1", questions: [] } });
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "assistant", content: "Picking the next task.", meta: { mid: "a3" } } });
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    await settle();
    assert.equal(calls.sent.length, 3);
    card = lastOf("interrupted");
    assert.ok(card && !card.resume && /waiting on your answer above \(1 task in progress and 1 queued\)/.test(card.text), JSON.stringify(card));
    chat.onFrame({ type: "question_card_resolved", data: { slot: "k1", ask_id: "q1" } });
    // 6. The user pressed Stop: not resumed on its own, the card says so.
    await chat.onMessage({ type: "stop", id: t.id });
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    await settle();
    assert.equal(calls.sent.length, 3);
    card = lastOf("interrupted");
    assert.ok(card && card.resume && /^Stopped with 1 task in progress and 1 queued\. Resume run continues from tasks\.md\.$/.test(card.text), JSON.stringify(card));
    // 7. The cap counts every automatic resume, whatever ended the turn.
    t.run.resumed = 3;
    chat.onFrame({ type: "chat_message", data: { slot: "k1", role: "assistant", content: "Continuing.", meta: { mid: "a4" } } });
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    await settle();
    assert.equal(calls.sent.length, 3);
    card = lastOf("interrupted");
    assert.ok(card && card.resume && /4 times on this run; not resuming again on its own \(kirocrew\.specResumeLimit = 3\)\. Resume run continues it by hand\./.test(card.text), JSON.stringify(card));
    // 8. The run finished: no marks left, every required task ticked → silence.
    ws.files[ws.spec + "/tasks.md"] = "- [x] 1. Done\n- [x] 2. Done\n- [x] 3. Done";
    const before = calls.posted.length;
    chat.onFrame({ type: "chat_done", data: { slot: "k1" } });
    await settle();
    assert.deepEqual(calls.posted.slice(before).map((m) => m.type), ["done"], "a finished run posts nothing beyond the frame's own done");
    assert.equal(calls.sent.length, 3);
  } finally { ws.restore(); }
});

test("a Spec tab without a run record (an older tab, a dashboard-started run) adopts the one interrupted spec; startup only offers the card; a plain chat is left alone", async () => {
  const { ChatView } = ext.__test;
  const ws = specWorkspace(["- [x] 1. Done", "- [~] 2. Next", "- [~] 3. After"].join("\n"));
  const calls = { sent: [], posted: [], saved: [] };
  const slots = { "kirocrew-ide-spec-20261102085551": { running: false }, "kirocrew-ide-chat-7": { running: false } };
  const sessions = {
    projectPath: () => ws.home + "/proj", slot: (k) => slots[k] || null, onDidChange: () => ({ dispose() {} }), agents: [{ name: "spec" }],
    transcript: async () => [], inject: async () => {}, setSlotAgent: async () => {},
    send: async (key, text, agent) => { calls.sent.push({ key, text, agent }); },
  };
  const settle = () => new Promise((r) => setTimeout(r, 25));
  try {
    // Restored from a 0.26 workspaceState: no `kind`, no `run`, the key says it was a spec run.
    const saved = { tabs: [{ key: "kirocrew-ide-spec-20261102085551", title: "Run all tasks", settings: { mode: "spec", agent: "" } }, { key: "kirocrew-ide-chat-7", title: "chat", settings: { mode: "default", agent: "o3r" } }] };
    const chat = new ChatView({ workspaceState: { get: () => saved, update: (k, v) => calls.saved.push(v) } }, sessions, { on: () => ({ dispose() {} }) });
    chat.post = (m) => calls.posted.push(m);
    chat.settleMs = 0;
    const t = chat.tabForKey("kirocrew-ide-spec-20261102085551"), plain = chat.tabForKey("kirocrew-ide-chat-7");
    assert.equal(t.run, null);
    // Startup: judged once each, card only, never a send.
    await chat.checkRestoredRuns();
    assert.equal(calls.sent.length, 0, "nothing is sent at startup");
    const card = calls.posted.filter((m) => m.type === "interrupted").at(-1);
    assert.ok(card && card.id === t.id && card.resume && /^This run was interrupted: 2 queued, and the session is idle\. Resume run continues from tasks\.md\.$/.test(card.text), JSON.stringify(card));
    assert.deepEqual(t.run, { resumed: 0, spec: "thing", dir: ws.spec, task: null, optional: false, display: "Run all tasks", derived: true }, "the run is adopted from tasks.md");
    assert.ok(calls.saved.at(-1).tabs[0].run.derived, "and persisted");
    assert.equal(plain.run, null, "a chat tab adopts nothing");
    assert.ok(!calls.posted.some((m) => m.type === "interrupted" && m.id === plain.id));
    // The dashboard's own Continue ran the turn in between; when it ends unfinished, this tab resumes it (a derived run counts only the marks, never bare open rows).
    chat.onFrame({ type: "chat_message", data: { slot: t.key, role: "assistant", content: "Dispatching 2.", meta: { mid: "b1" } } });
    chat.onFrame({ type: "chat_done", data: { slot: t.key } });
    await settle();
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0].key, t.key);
    assert.match(calls.sent[0].text, /^Run all tasks for this spec\. Resume from prior progress: tasks \[1\. Done\]/);
    assert.equal(calls.sent[0].agent, "spec");
    // Marks gone but rows still open: a derived run has no say (the spec may simply never have been run further).
    ws.files[ws.spec + "/tasks.md"] = "- [x] 1. Done\n- [x] 2. Next\n- [ ] 3. After";
    const before = calls.sent.length;
    chat.onFrame({ type: "chat_done", data: { slot: t.key } });
    await settle();
    assert.equal(calls.sent.length, before, "no marks, no resume");
  } finally { ws.restore(); }
});

test("resumeSpec (Specs view ⟳ / spec editor 'Resume run'): the tab that ran it when idle, 'running' while it goes, a fresh dispatch otherwise; continueAction routes an interrupted tasks.md there", async () => {
  const { ChatView, continueAction, parseTaskTree, parseTasks } = ext.__test;
  const ws = specWorkspace(["- [x] 1. Done", "- [-] 2. Half way", "- [ ] 3. Next"].join("\n"));
  const calls = { sent: [], posted: [], dispatched: 0 };
  const slots = { k1: { running: false } };
  const sessions = {
    projectPath: () => ws.home + "/proj", slot: (k) => slots[k] || null, onDidChange: () => ({ dispose() {} }), agents: [{ name: "spec" }],
    create: async () => "k1", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, inject: async () => {}, setSlotAgent: async () => {},
    send: async (key, text) => { calls.sent.push({ key, text }); },
  };
  try {
    const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
    chat.post = (m) => calls.posted.push(m);
    chat.settleMs = 0;
    const specs = await (async () => { const { listSpecs } = ext.__test; return listSpecs ? listSpecs() : null; })();
    const spec = (specs && specs[0]) || { name: "thing", dir: { path: ws.spec } };
    const dispatch = async () => { calls.dispatched += 1; };
    // No tab yet: a fresh dispatch.
    assert.equal(await chat.resumeSpec(spec, dispatch), "dispatched");
    assert.equal(calls.dispatched, 1);
    // The tab that ran it, idle: resumed there, made active.
    await chat.dispatch(() => "Run all tasks for this spec.", { mode: "spec", kind: "spec", display: "Run all tasks", run: { spec: "thing", dir: ws.spec, task: null, optional: false, display: "Run all tasks" } });
    const t = chat.tabForKey("k1");
    chat.newTab(true); // another tab in front
    assert.equal(await chat.resumeSpec(spec, dispatch), "resumed");
    assert.equal(chat.active, t.id, "the run's tab is brought to the front");
    assert.equal(calls.sent.length, 2); assert.match(calls.sent[1].text, /Resume from prior progress/);
    assert.equal(calls.dispatched, 1, "no second session");
    // Still running there: say so, send nothing.
    slots.k1.running = true;
    assert.equal(await chat.resumeSpec(spec, dispatch), "running");
    assert.equal(calls.sent.length, 2);
    // The spec editor's primary action on an interrupted tasks.md is "Resume run" through the same route.
    const md = ws.files[ws.spec + "/tasks.md"];
    const action = continueAction({ file: "tasks.md", label: "Tasks" }, { present: { "tasks.md": true }, taskTree: parseTaskTree(md), tasks: parseTasks(md) });
    assert.deepEqual(action, { label: "Resume run (2 left)", command: "kirocrew.spec.resume", remaining: 2, interrupted: true });
    const plainMd = "- [x] 1. Done\n- [ ] 2. Next";
    const plain = continueAction({ file: "tasks.md", label: "Tasks" }, { present: { "tasks.md": true }, taskTree: parseTaskTree(plainMd), tasks: parseTasks(plainMd) });
    assert.equal(plain.command, "kirocrew.spec.runAll", "ticked rows alone are not an interrupted run");
    assert.equal(plain.label, "Resume tasks (1 left)");
  } finally { ws.restore(); }
});

test("auto-resume off: the card is explained and nothing is sent until Continue", async () => {
  const { ChatView } = ext.__test;
  const card = "⏱️ This turn hit the 4-hour limit and was stopped. Work already written to disk is still there — nothing was rolled back. Send a message to continue from where it stopped.";
  const ws = specWorkspace("- [ ] 1. Next");
  const savedCfg = stub.workspace.getConfiguration;
  stub.workspace.getConfiguration = () => ({ get: (k) => (k === "specAutoResume" ? false : undefined) });
  const calls = { sent: [], posted: [] };
  const sessions = {
    projectPath: () => ws.home + "/proj", slot: () => ({ running: false }), onDidChange: () => ({ dispose() {} }), agents: [{ name: "o3r" }],
    create: async () => "k3", setModel: async () => {}, setEffort: async () => {}, setTrust: async () => {}, inject: async () => {}, setSlotAgent: async () => {},
    send: async (key, text, agent) => { calls.sent.push({ text, agent }); },
  };
  try {
    const chat = new ChatView({ workspaceState: { get: () => undefined, update: () => {} } }, sessions, { on: () => ({ dispose() {} }) });
    chat.post = (m) => calls.posted.push(m);
    chat.settleMs = 0;
    await chat.dispatch(() => "paraphrase", { mode: "spec", agent: "o3r", title: "Run all tasks", kind: "spec", display: "Run all tasks", run: { spec: "thing", dir: ws.spec, task: null, optional: false, display: "Run all tasks" } });
    chat.onFrame({ type: "chat_message", data: { slot: "k3", role: "error", cls: "msg msg-err", content: card, meta: { mid: "m5" } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.sent.length, 1, "nothing automatic");
    assert.match(calls.posted.filter((m) => m.type === "status").at(-1).text, /auto-resume is off \(kirocrew\.specAutoResume\)\. Continue resumes the run by hand\./);
    await chat.onMessage({ type: "resume", id: chat.tabForKey("k3").id });
    assert.equal(calls.sent.length, 2);
    assert.match(calls.sent[1].text, /PHASE: EXECUTE REMAINING TASKS\. Run all tasks for this spec\./, "the paraphrase on the crew agent (no Spec agent on this host)");
  } finally { ws.restore(); stub.workspace.getConfiguration = savedCfg; }
});
