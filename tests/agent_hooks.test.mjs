// node --test: Agent hooks (requirement 12.4, task 14.4) — hook file validation,
// row builders, the `enabled` toggle, the Run decision, the wizard's output shape
// and `createHookWizard` over a temp dir behind a stub `vscode` with scripted
// pickers (the tests/steering_import pattern).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ------------------------------------------------------------ stub vscode (fs = node's fs, scripted UI)

const uri = (p) => ({ path: p, toString: () => "file://" + p, with: ({ path: np }) => uri(np) });
const stub = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor(value) { this.value = value; } },
  FileType: { File: 1, Directory: 2 },
  RelativePattern: class { constructor(base, pattern) { this.base = base.uri || base; this.pattern = pattern; } },
  Uri: { joinPath: (base, ...parts) => uri([base.path, ...parts].join("/")), parse: (s) => uri(s.replace(/^file:\/\//, "")), file: uri },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    workspaceFolders: [],
    fs: {
      stat: async (u) => ({ type: fs.statSync(u.path).isDirectory() ? 2 : 1 }),
      readFile: async (u) => new Uint8Array(fs.readFileSync(u.path)),
      readDirectory: async (u) => fs.readdirSync(u.path).map((n) => [n, fs.statSync(path.join(u.path, n)).isDirectory() ? 2 : 1]),
      writeFile: async (u, data) => { fs.mkdirSync(path.dirname(u.path), { recursive: true }); fs.writeFileSync(u.path, data); },
      createDirectory: async (u) => fs.mkdirSync(u.path, { recursive: true }),
    },
    openTextDocument: async (u) => { stub.calls.opened.push(u.path); return { uri: u }; },
  },
  window: {
    // A quick pick takes the next label from `stub.picks`, an input box the next value from
    // `stub.inputs` (undefined = cancel); validateInput runs on the scripted value.
    showQuickPick: async (items) => {
      const want = stub.picks.shift();
      stub.calls.quickPicks.push(items.map((i) => i.label));
      return want === undefined ? undefined : items.find((i) => i.label === want || i.label.endsWith(" " + want));
    },
    showInputBox: async (opts) => {
      const value = stub.inputs.shift();
      stub.calls.inputs.push({ value, problem: opts.validateInput && value !== undefined ? opts.validateInput(value) : null, prefilled: opts.value });
      return value;
    },
    showTextDocument: async (doc) => { stub.calls.shown.push(doc.uri.path); },
    showInformationMessage: () => {},
    showWarningMessage: (m) => { stub.calls.errors.push(m); },
    showErrorMessage: (m) => { stub.calls.errors.push(m); },
  },
  commands: {},
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1 },
};
const reset = (picks = [], inputs = []) => { stub.calls = { quickPicks: [], inputs: [], opened: [], shown: [], errors: [] }; stub.picks = [...picks]; stub.inputs = [...inputs]; };
reset();
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === "vscode" ? "vscode-stub" : originalResolve.call(this, request, ...rest); };
require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: stub };

const ext = require(path.join(here, "..", "extension", "extension.js"));
const {
  HOOK_FILE_RE, HOOK_TRIGGERS, HOOK_MATCHER_TRIGGERS, HOOK_ACTION_KINDS, hookNameFromPath, parseHookFile,
  hookRowLabel, hookRowDescription, hookRowIcon, hookContextValue, hookRowTooltip, toggleHookEnabled, hookRunDecision,
  HOOK_TRIGGER_DESCRIPTIONS, HOOK_FILE_TRIGGERS, buildHookFile, serializeHookFile, hookFileName, createHookWizard,
} = ext.__test;

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), "kide-" + name + "-"));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const j = (o) => JSON.stringify(o);
const V2 = { name: "Lint", description: " on save ", trigger: "fileEdited", matcher: "src/**/*.ts", action: { type: "askAgent", prompt: "lint it" } };
const LEGACY = { enabled: false, name: "Old", version: "1", when: { type: "fileEdited", patterns: ["a/**", "b/**"] }, then: { type: "askAgent", prompt: "review" } };

// ------------------------------------------------------------ HOOK_FILE_RE, constants, parseHookFile

test("HOOK_FILE_RE: .kiro.hook and .json (any case), not .md; the name falls back to the base name", () => {
  for (const ok of ["lint.kiro.hook", "x.json", "A.JSON"]) assert.ok(HOOK_FILE_RE.test(ok), ok);
  for (const no of ["lint.md", "hook", "kiro.hook.txt"]) assert.ok(!HOOK_FILE_RE.test(no), no);
  assert.equal(hookNameFromPath("/w/.kiro/hooks/lint-on-save.kiro.hook"), "lint-on-save");
  assert.equal(hookNameFromPath(""), "hook");
  assert.equal(parseHookFile("{}", "/w/.kiro/hooks/fallback.json").name, "fallback");
  assert.equal(parseHookFile(j({ name: "  Named  ", trigger: "sessionStart", action: { type: "runCommand", command: "ls" } }), "/x/n.json").name, "Named");
});

test("constants: nine triggers, matcher and file subsets, two action kinds, a description for every trigger", () => {
  assert.deepEqual(HOOK_TRIGGERS, ["fileEdited", "fileCreated", "fileDeleted", "userTriggered", "promptSubmit", "agentStop", "preToolUse", "postToolUse", "sessionStart"]);
  assert.equal(HOOK_MATCHER_TRIGGERS.length, 5);
  for (const t of HOOK_MATCHER_TRIGGERS) assert.ok(HOOK_TRIGGERS.includes(t), t);
  for (const t of HOOK_FILE_TRIGGERS) assert.ok(HOOK_MATCHER_TRIGGERS.includes(t), t);
  assert.deepEqual(HOOK_ACTION_KINDS, ["askAgent", "runCommand"]);
  assert.deepEqual(Object.keys(HOOK_TRIGGER_DESCRIPTIONS).sort(), [...HOOK_TRIGGERS].sort());
  for (const t of HOOK_TRIGGERS) assert.match(HOOK_TRIGGER_DESCRIPTIONS[t], /\S/, t);
});

test("parseHookFile: v2 shape — trimmed fields, matcher string/array → patterns, missing enabled → true, `command` alias", () => {
  assert.deepEqual(parseHookFile(j(V2), "/p"), { name: "Lint", description: "on save", trigger: "fileEdited", patterns: ["src/**/*.ts"], actionKind: "askAgent", actionText: "lint it", enabled: true, valid: true });
  assert.deepEqual(parseHookFile(j({ ...V2, matcher: ["a", "", 3, "b"] })).patterns, ["a", "b"]);
  assert.deepEqual(parseHookFile(j({ ...V2, matcher: undefined })).patterns, []);
  assert.equal(parseHookFile(j({ ...V2, enabled: false })).enabled, false);
  assert.equal(parseHookFile(j({ ...V2, enabled: "no" })).enabled, true, "only the boolean false disables");
  const cmd = parseHookFile(j({ trigger: "userTriggered", action: { type: "runCommand", command: "npm test" } }), "/x/t.json");
  assert.deepEqual([cmd.valid, cmd.actionKind, cmd.actionText, cmd.patterns], [true, "runCommand", "npm test", []]);
  const alias = parseHookFile(j({ trigger: "agentStop", action: { type: "command", command: "make" } }));
  assert.deepEqual([alias.valid, alias.actionKind], [true, "runCommand"]);
});

test("parseHookFile: legacy when/then shape — when.type, when.patterns, then.type/prompt, enabled honoured", () => {
  assert.deepEqual(parseHookFile(j(LEGACY), "/p"), { name: "Old", description: "", trigger: "fileEdited", patterns: ["a/**", "b/**"], actionKind: "askAgent", actionText: "review", enabled: false, valid: true });
  const { enabled, ...noEnabled } = LEGACY;
  assert.equal(parseHookFile(j(noEnabled)).enabled, true);
  assert.equal(parseHookFile(j({ ...LEGACY, trigger: "sessionStart" })).trigger, "sessionStart", "`trigger` wins over `when.type`");
});

test("parseHookFile: each invalid reason names the first problem; name and enabled still read", () => {
  const cases = [
    ["{", /^not valid JSON: /], ["[]", /^not a JSON object$/], ["null", /^not a JSON object$/],
    [j({ action: { type: "askAgent", prompt: "p" } }), /^missing trigger/], [j({ when: {}, then: { type: "askAgent", prompt: "p" } }), /^missing trigger/],
    [j({ trigger: "onBoot", action: { type: "askAgent", prompt: "p" } }), /^unknown trigger "onBoot"$/],
    [j({ trigger: "fileEdited" }), /^missing action/], [j({ trigger: "fileEdited", action: [] }), /^missing action/],
    [j({ trigger: "fileEdited", action: { prompt: "p" } }), /^action has no `type`$/],
    [j({ trigger: "fileEdited", action: { type: "email", prompt: "p" } }), /^unknown action type "email"$/],
    [j({ trigger: "fileEdited", action: { type: "askAgent", prompt: "   " } }), /^askAgent action needs a `prompt`$/],
    [j({ trigger: "fileEdited", action: { type: "runCommand", prompt: "p" } }), /^runCommand action needs a `command`$/],
    [j({ trigger: "fileEdited", then: { type: "command", command: "" } }), /^runCommand action needs a `command`$/],
  ];
  for (const [text, want] of cases) {
    const h = parseHookFile(text, "/w/.kiro/hooks/bad.kiro.hook");
    assert.equal(h.valid, false, text);
    assert.match(h.error, want, text);
  }
  const named = parseHookFile(j({ name: "Keep", enabled: false, trigger: "nope" }), "/x/y.json");
  assert.deepEqual([named.valid, named.name, named.enabled], [false, "Keep", false]);
});

// ------------------------------------------------------------ row builders

test("row builders: label, description, icon, context value and tooltip for on / off / manual / invalid", () => {
  const on = parseHookFile(j(V2), "/p");
  const off = parseHookFile(j({ ...V2, enabled: false }), "/p");
  const manual = parseHookFile(j({ name: "Run me", trigger: "userTriggered", action: { type: "runCommand", command: "make" } }));
  const manualOff = parseHookFile(j({ trigger: "userTriggered", enabled: false, action: { type: "askAgent", prompt: "p" } }), "/x/m.json");
  const bad = parseHookFile("{", "/w/.kiro/hooks/broken.json");
  assert.deepEqual([hookRowLabel(on), hookRowLabel(bad)], ["Lint", "broken"]);
  assert.equal(hookRowDescription(on), "fileEdited → askAgent");
  assert.match(hookRowDescription(bad), /^invalid · not valid JSON/);
  assert.equal(hookRowDescription({ valid: false }), "invalid · unknown problem");
  assert.deepEqual([on, off, bad].map(hookRowIcon), ["circle-filled", "circle-outline", "warning"]);
  assert.deepEqual([on, off, manual, manualOff, bad].map(hookContextValue), ["hook-on", "hook-off", "hook-on-manual", "hook-off-manual", "hook-invalid"]);
  assert.equal(hookRowTooltip(on, "/p"), "/p\non save\nfileEdited (src/**/*.ts) → askAgent");
  assert.equal(hookRowTooltip(off, "/p"), "/p\non save\nfileEdited (src/**/*.ts) → askAgent · disabled");
  assert.equal(hookRowTooltip(manual, "/p"), "/p\nuserTriggered → runCommand");
  assert.match(hookRowTooltip(bad, "/p"), /^\/p\nNot a valid hook: not valid JSON/);
});

// ------------------------------------------------------------ toggleHookEnabled

test("toggleHookEnabled: flip or set, key order and 2-space indent, trailing newline kept or absent, throws on a non-object", () => {
  const src = JSON.stringify(LEGACY, null, 2) + "\n";
  const flipped = toggleHookEnabled(src);
  assert.equal(flipped, JSON.stringify({ ...LEGACY, enabled: true }, null, 2) + "\n");
  assert.deepEqual(Object.keys(JSON.parse(flipped)), Object.keys(LEGACY), "key order kept");
  assert.equal(toggleHookEnabled(flipped), src, "flipping twice is the identity");
  assert.equal(JSON.parse(toggleHookEnabled(src, false)).enabled, false, "explicit set keeps the value");
  assert.equal(JSON.parse(toggleHookEnabled(src, true)).enabled, true);
  const out = toggleHookEnabled(JSON.stringify(V2, null, 4));
  assert.ok(!out.endsWith("\n"), "no trailing newline when the source had none");
  assert.match(out, /\n  "name"/, "re-indented to 2 spaces");
  assert.deepEqual(Object.keys(JSON.parse(out)), [...Object.keys(V2), "enabled"], "a missing `enabled` is appended");
  assert.equal(JSON.parse(out).enabled, false, "missing enabled means on, so the flip disables");
  assert.throws(() => toggleHookEnabled("[1]"), /not a JSON object/);
  assert.throws(() => toggleHookEnabled("null"), /not a JSON object/);
  assert.throws(() => toggleHookEnabled("{nope"), SyntaxError);
});

// ------------------------------------------------------------ hookRunDecision (12.3)

test("hookRunDecision: no hook, invalid, not userTriggered, disabled → refused with a reason; valid enabled manual → ok with its kind", () => {
  assert.deepEqual(hookRunDecision(undefined), { ok: false, reason: "Pick a hook in the Agent Hooks view to run it." });
  const bad = hookRunDecision(parseHookFile("{", "/x/b.json"));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /^"b" is not a valid hook: not valid JSON.*\.$/);
  assert.deepEqual(hookRunDecision(parseHookFile(j(V2))), { ok: false, reason: "\"Lint\" fires on fileEdited; only userTriggered hooks can be run by hand." });
  const off = hookRunDecision(parseHookFile(j({ name: "M", enabled: false, trigger: "userTriggered", action: { type: "askAgent", prompt: "p" } })));
  assert.deepEqual(off, { ok: false, reason: "\"M\" is disabled. Enable it to run it." });
  assert.deepEqual(hookRunDecision(parseHookFile(j({ trigger: "userTriggered", action: { type: "askAgent", prompt: "p" } }))), { ok: true, kind: "askAgent" });
  assert.deepEqual(hookRunDecision(parseHookFile(j({ trigger: "userTriggered", then: { type: "command", command: "ls" } }))), { ok: true, kind: "runCommand" });
});

// ------------------------------------------------------------ buildHookFile / serializeHookFile / hookFileName (12.4)

test("buildHookFile: validation errors name the first problem", () => {
  const good = { name: "n", trigger: "agentStop", actionKind: "askAgent", actionText: "p" };
  assert.throws(() => buildHookFile({ ...good, name: "  " }), /a hook needs a name/);
  assert.throws(() => buildHookFile(null), /a hook needs a name/);
  assert.throws(() => buildHookFile({ ...good, trigger: "onBoot" }), /unknown trigger "onBoot"; one of fileEdited, .*sessionStart/);
  assert.throws(() => buildHookFile({ ...good, actionKind: "email" }), /unknown action kind "email"; one of askAgent, runCommand/);
  assert.throws(() => buildHookFile({ ...good, actionText: " " }), /an askAgent hook needs its prompt/);
  assert.throws(() => buildHookFile({ ...good, actionKind: "runCommand", actionText: "" }), /a runCommand hook needs its command/);
});

test("buildHookFile: output shape per trigger kind — file default matcher, tool matcher kept, non-matcher trigger drops it; key order", () => {
  const file = buildHookFile({ name: " Lint ", trigger: "fileEdited", actionKind: "askAgent", actionText: " lint it " });
  assert.deepEqual(file, { name: "Lint", trigger: "fileEdited", matcher: "**/*", action: { type: "askAgent", prompt: "lint it" }, enabled: true });
  assert.deepEqual(Object.keys(file), ["name", "trigger", "matcher", "action", "enabled"]);
  const kept = buildHookFile({ name: "L", description: " why ", trigger: "fileCreated", matcher: " src/**/*.ts ", actionKind: "runCommand", actionText: "npm run lint", enabled: false });
  assert.deepEqual(kept, { name: "L", description: "why", trigger: "fileCreated", matcher: "src/**/*.ts", action: { type: "runCommand", command: "npm run lint" }, enabled: false });
  assert.deepEqual(Object.keys(kept), ["name", "description", "trigger", "matcher", "action", "enabled"]);
  assert.equal(buildHookFile({ name: "T", trigger: "preToolUse", matcher: "write_file", actionKind: "runCommand", actionText: "echo hi" }).matcher, "write_file");
  assert.ok(!("matcher" in buildHookFile({ name: "T", trigger: "postToolUse", actionKind: "askAgent", actionText: "p" })), "a tool trigger has no default matcher");
  const manual = buildHookFile({ name: "M", trigger: "userTriggered", matcher: "**/*.py", actionKind: "askAgent", actionText: "p", description: "" });
  assert.deepEqual(manual, { name: "M", trigger: "userTriggered", action: { type: "askAgent", prompt: "p" }, enabled: true });
  assert.equal(buildHookFile({ name: "A", trigger: "sessionStart", actionKind: "command", actionText: "ls" }).action.type, "runCommand", "`command` alias");
});

test("serializeHookFile: 2-space JSON with one trailing newline; every trigger × action kind round-trips through parseHookFile as valid", () => {
  const text = serializeHookFile({ name: "x", trigger: "agentStop", action: { type: "askAgent", prompt: "p" }, enabled: true });
  assert.equal(text, "{\n  \"name\": \"x\",\n  \"trigger\": \"agentStop\",\n  \"action\": {\n    \"type\": \"askAgent\",\n    \"prompt\": \"p\"\n  },\n  \"enabled\": true\n}\n");
  assert.equal(toggleHookEnabled(text), text.replace("\"enabled\": true", "\"enabled\": false"), "what the toggle keeps");
  let count = 0;
  for (const trigger of HOOK_TRIGGERS) for (const actionKind of HOOK_ACTION_KINDS) {
    const built = buildHookFile({ name: "RT " + trigger, trigger, matcher: trigger.endsWith("ToolUse") ? "*" : undefined, actionKind, actionText: "do " + actionKind });
    const h = parseHookFile(serializeHookFile(built), "/w/.kiro/hooks/" + hookFileName(built.name));
    assert.equal(h.valid, true, trigger + "/" + actionKind + ": " + h.error);
    assert.deepEqual([h.name, h.trigger, h.actionKind, h.actionText, h.enabled], ["RT " + trigger, trigger, actionKind, "do " + actionKind, true]);
    assert.deepEqual(h.patterns, built.matcher ? [built.matcher] : [], trigger);
    assert.equal(h.patterns.length > 0, HOOK_MATCHER_TRIGGERS.includes(trigger), trigger + " has a matcher iff it takes one");
    count++;
  }
  assert.equal(count, 18);
});

test("hookFileName: lower-cased slug with dashes, edges trimmed, `hook` fallback, .kiro.hook", () => {
  const table = [["Lint on save", "lint-on-save.kiro.hook"], ["  Héllo   World!! ", "h-llo-world.kiro.hook"], ["a__b-c", "a__b-c.kiro.hook"], ["--x--", "x.kiro.hook"], ["", "hook.kiro.hook"], [null, "hook.kiro.hook"], ["Run.Tests (v2)", "run-tests-v2.kiro.hook"]];
  for (const [name, want] of table) assert.equal(hookFileName(name), want, JSON.stringify(name));
  assert.ok(HOOK_FILE_RE.test(hookFileName("anything")));
});

// ------------------------------------------------------------ createHookWizard (12.4)

const fakeTree = () => { const t = { refreshed: 0 }; t.refresh = () => { t.refreshed++; }; return t; };
const hooksIn = (root) => (fs.existsSync(path.join(root, ".kiro", "hooks")) ? fs.readdirSync(path.join(root, ".kiro", "hooks")) : []);

test("createHookWizard: one folder skips the scope step; name → trigger → matcher → kind → text writes a valid file, refreshes, opens it", async () => {
  const root = tmpDir("hooks");
  try {
    reset(["fileEdited", "askAgent"], ["Lint on save", "src/**/*.ts", "Lint the saved file."]);
    const tree = fakeTree();
    const out = await createHookWizard(tree, null, { folders: [{ uri: uri(root) }], home: null });
    assert.equal(out.uri.path, root + "/.kiro/hooks/lint-on-save.kiro.hook");
    assert.deepEqual(out.hook, { name: "Lint on save", trigger: "fileEdited", matcher: "src/**/*.ts", action: { type: "askAgent", prompt: "Lint the saved file." }, enabled: true });
    assert.deepEqual([out.scope, out.revealed, hooksIn(root)], ["workspace", false, ["lint-on-save.kiro.hook"]]);
    const text = fs.readFileSync(out.uri.path, "utf8");
    assert.equal(text, serializeHookFile(out.hook));
    const parsed = parseHookFile(text, out.uri.path);
    assert.deepEqual([parsed.valid, parsed.trigger, parsed.patterns, parsed.actionText], [true, "fileEdited", ["src/**/*.ts"], "Lint the saved file."]);
    assert.equal(tree.refreshed, 1);
    assert.deepEqual([stub.calls.opened, stub.calls.shown], [[out.uri.path], [out.uri.path]]);
    assert.deepEqual(stub.calls.quickPicks, [HOOK_TRIGGERS, ["askAgent", "runCommand"]], "no scope pick, the nine triggers, the two kinds");
    assert.deepEqual(stub.calls.inputs.map((i) => i.problem), [null, null, null], "every scripted answer passed validateInput");
    assert.equal(stub.calls.inputs[1].prefilled, "**/*", "file matcher prefilled with the default");
    assert.deepEqual(stub.calls.errors, []);
  } finally { rm(root); }
});

test("createHookWizard: userTriggered runCommand asks no matcher; a duplicate name fails validateInput", async () => {
  const root = tmpDir("hooks");
  try {
    reset(["userTriggered", "runCommand"], ["Run tests", "npm test"]);
    const out = await createHookWizard(fakeTree(), null, { folders: [{ uri: uri(root) }], home: null });
    assert.deepEqual(out.hook, { name: "Run tests", trigger: "userTriggered", action: { type: "runCommand", command: "npm test" }, enabled: true });
    assert.equal(stub.calls.inputs.length, 2, "name and command only");
    assert.equal(hookContextValue(parseHookFile(fs.readFileSync(out.uri.path, "utf8"), out.uri.path)), "hook-on-manual");
    reset([undefined], ["run tests"]); // same slug again: the validator names the clash; the trigger pick is then cancelled
    assert.equal(await createHookWizard(fakeTree(), null, { folders: [{ uri: uri(root) }], home: null }), null);
    assert.match(stub.calls.inputs[0].problem, /^run-tests\.kiro\.hook already exists in /);
    assert.deepEqual(hooksIn(root), ["run-tests.kiro.hook"]);
  } finally { rm(root); }
});

test("createHookWizard: with a home the scope is asked first; Global writes under ~/.kiro/hooks; a tool matcher is kept", async () => {
  const root = tmpDir("hooks"), home = tmpDir("home");
  try {
    reset(["Global", "preToolUse", "runCommand"], ["Guard writes", "write_file", "echo guard"]);
    const out = await createHookWizard(fakeTree(), null, { folders: [{ uri: uri(root) }], home: uri(home) });
    assert.deepEqual([out.scope, out.uri.path], ["global", home + "/.kiro/hooks/guard-writes.kiro.hook"]);
    assert.deepEqual(out.hook, { name: "Guard writes", trigger: "preToolUse", matcher: "write_file", action: { type: "runCommand", command: "echo guard" }, enabled: true });
    assert.deepEqual([hooksIn(home), hooksIn(root)], [["guard-writes.kiro.hook"], []]);
    assert.equal(stub.calls.quickPicks[0].length, 2, "Workspace and Global");
    assert.equal(stub.calls.inputs[1].prefilled, "", "a tool matcher is not prefilled");
  } finally { rm(root, home); }
});

test("createHookWizard: cancelling at each step returns null and writes nothing; no folders is an error", async () => {
  const root = tmpDir("hooks");
  try {
    const opts = { folders: [{ uri: uri(root) }], home: uri(root + "/home") };
    const scripts = [ // [picks, inputs] stopping at: scope, name, trigger, matcher, action kind, action text, empty text (no matcher step)
      [[undefined], []], [["Workspace"], [undefined]], [["Workspace", undefined], ["N"]], [["Workspace", "fileDeleted"], ["N", undefined]],
      [["Workspace", "fileDeleted", undefined], ["N", "**/*"]], [["Workspace", "fileDeleted", "askAgent"], ["N", "**/*", undefined]], [["Workspace", "agentStop", "askAgent"], ["N", ""]],
    ];
    for (const [picks, inputs] of scripts) {
      reset(picks, inputs);
      const tree = fakeTree();
      assert.equal(await createHookWizard(tree, null, opts), null, JSON.stringify([picks, inputs]));
      assert.deepEqual([tree.refreshed, stub.picks, stub.inputs, stub.calls.errors], [0, [], [], []], "script consumed exactly, no refresh, no error: " + JSON.stringify([picks, inputs]));
    }
    assert.ok(!fs.existsSync(path.join(root, ".kiro")), "nothing written");
    reset();
    assert.equal(await createHookWizard(fakeTree(), null, { folders: [], home: null }), null);
    assert.match(stub.calls.errors[0], /Open a folder first/);
  } finally { rm(root); }
});
