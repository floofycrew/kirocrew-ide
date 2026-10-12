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
  assert.ok(/\.log\{[^}]*padding:4px 5px/.test(html) && /#compose\{[^}]*padding:5px 5px 4px/.test(html), "compact paddings");
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
  const realSetTimeout = globalThis.setTimeout;
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
    globalThis.setTimeout = realSetTimeout;
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
