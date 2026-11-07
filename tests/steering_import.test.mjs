// node --test: "Import from other assistants" and "Import skill" (requirements
// 11.3, 11.4) — the scanner's source → steering-name mapping, the front-matter
// writer, the scan + import command over a temp dir behind a stub `vscode`
// whose `workspace.fs` is node's fs, the steering-document predicates, the
// GitHub URL parser (URL_TABLE is shared with tests/skills_import_test.py, which
// reads it out of this file) and the local skill-folder import.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ------------------------------------------------------------ stub vscode (fs = node's fs)

const uri = (p) => ({ path: p, toString: () => "file://" + p, with: ({ path: np }) => uri(np) });
const walk = (dir, rel = "") => fs.readdirSync(dir).flatMap((n) => (fs.statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n), rel + n + "/") : [rel + n]));
const stub = {
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  FileType: { File: 1, Directory: 2 },
  RelativePattern: class { constructor(base, pattern) { this.base = base.uri || base; this.pattern = pattern; } },
  Uri: { joinPath: (base, ...parts) => uri([base.path, ...parts].join("/")), parse: (s) => uri(s.replace(/^file:\/\//, "")), file: uri },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    workspaceFolders: [],
    fs: {
      stat: async (u) => ({ type: fs.statSync(u.path).isDirectory() ? 2 : 1 }),
      readFile: async (u) => new Uint8Array(fs.readFileSync(u.path)),
      writeFile: async (u, data) => { fs.mkdirSync(path.dirname(u.path), { recursive: true }); fs.writeFileSync(u.path, data); },
      createDirectory: async (u) => fs.mkdirSync(u.path, { recursive: true }),
      copy: async (src, dst, o) => { if (!(o && o.overwrite) && fs.existsSync(dst.path)) throw new Error("exists"); fs.cpSync(src.path, dst.path, { recursive: true }); },
    },
    // A literal path or `<dir>/**` relative to the pattern's base; node_modules and .git are never searched.
    findFiles: async (glob, exclude, max) => {
      stub.calls.findFiles.push({ pattern: glob.pattern, exclude, max });
      const dir = glob.pattern.endsWith("/**") ? glob.pattern.slice(0, -2) : null;
      if (!fs.existsSync(glob.base.path)) return [];
      return walk(glob.base.path).filter((r) => !/(^|\/)(node_modules|\.git)\//.test(r) && (dir ? r.startsWith(dir) : r === glob.pattern)).map((r) => uri(glob.base.path + "/" + r));
    },
  },
  window: {
    showQuickPick: async (items, opts) => { stub.calls.quickPicks.push({ items, opts }); return stub.nextPick(items); },
    showInformationMessage: (m) => { stub.calls.info.push(m); },
    showErrorMessage: (m) => { stub.calls.errors.push(m); },
  },
  commands: {},
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1 },
};
const resetCalls = () => { stub.calls = { findFiles: [], quickPicks: [], info: [], errors: [] }; stub.nextPick = (items) => items; };
resetCalls();
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === "vscode" ? "vscode-stub" : originalResolve.call(this, request, ...rest); };
require.cache["vscode-stub"] = { id: "vscode-stub", filename: "vscode-stub", loaded: true, exports: stub };

const ext = require(path.join(here, "..", "extension", "extension.js"));
const {
  IMPORT_SOURCES, IMPORT_FIND_EXCLUDE, IMPORT_FIND_MAX, importStem, importTargetName, withSteeringFrontMatter,
  scanImportSources, importSteeringFromAssistants, isSteeringDocument, steeringNameOf, parseSteering,
  SKILL_FILE, SKILL_NAME_RE, parseGithubSkillUrl, skillNameFromText, importSkillFolder,
} = ext.__test;

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), "kide-" + name + "-"));
const write = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

// ------------------------------------------------------------ importTargetName (11.3)

test("importTargetName: every source kind maps to its documented stem; nested, space, unicode, case, ./ and \\ normalised", () => {
  const table = [
    ["AGENTS.md", "agents"], ["CLAUDE.md", "claude"], [".cursorrules", "cursorrules"], [".cursor/rules/foo.mdc", "cursor-foo"],
    [".clinerules", "clinerules"], [".clinerules/x.md", "clinerules-x"], [".continue/rules/x.md", "continue-x"], [".continue/x.md", "continue-x"],
    [".github/copilot-instructions.md", "copilot-instructions"],
    [".cursor/rules/a/b.mdc", "cursor-a-b"], [".continue/rules/My Rule.md", "continue-my-rule"], [".cursor/rules/règles d'or.mdc", "cursor-r-gles-d-or"],
    ["./AGENTS.md", "agents"], [".cursor\\rules\\foo.mdc", "cursor-foo"], ["docs/Team_Notes.MD", "docs-team_notes"], [".cursor/rules/--weird--.mdc", "cursor-weird"],
  ];
  for (const [rel, want] of table) assert.equal(importTargetName(rel), want, rel);
});

test("importTargetName: nothing usable falls back to `imported`; importStem drops the leading dot and extension", () => {
  for (const bad of ["", null, "....", "!!!.md"]) assert.equal(importTargetName(bad), "imported", JSON.stringify(bad));
  assert.equal(importStem(".cursorrules"), "cursorrules");
  assert.equal(importStem("a/b.mdc"), "a-b");
  assert.equal(importStem(".github/copilot-instructions.md"), "github-copilot-instructions");
});

// ------------------------------------------------------------ withSteeringFrontMatter (11.3)

test("withSteeringFrontMatter: no front matter → always block, imported-from line, blank line, body; round-trips as always", () => {
  const out = withSteeringFrontMatter("# Rules\nbe nice\n", { source: "AGENTS.md" });
  assert.equal(out, "---\ninclusion: always\n---\n\n<!-- imported from AGENTS.md -->\n\n# Rules\nbe nice\n");
  assert.equal(parseSteering(out).inclusion, "always");
  assert.match(parseSteering(out).body, /# Rules\nbe nice/);
});

test("withSteeringFrontMatter: a block without inclusion gains `inclusion: always` after its fields; an existing value is kept", () => {
  const out = withSteeringFrontMatter("---\ndescription: house style\n---\n\nbody\n", { source: ".cursorrules" });
  assert.equal(out, "---\ndescription: house style\ninclusion: always\n---\n\n<!-- imported from .cursorrules -->\n\nbody\n");
  assert.deepEqual([parseSteering(out).inclusion, parseSteering(out).description], ["always", "house style"]);
  const manual = withSteeringFrontMatter("---\ninclusion: manual\n---\nbody", { source: "CLAUDE.md" });
  assert.equal(manual, "---\ninclusion: manual\n---\n\n<!-- imported from CLAUDE.md -->\n\nbody");
  assert.equal(parseSteering(manual).inclusion, "manual");
  assert.equal(parseSteering(withSteeringFrontMatter("---\nInclusion: fileMatch\nfileMatchPattern: '*.ts'\n---\nx")).inclusion, "fileMatch");
});

test("withSteeringFrontMatter: empty text, no source, BOM, and `--` in the source name kept out of the comment", () => {
  assert.equal(withSteeringFrontMatter("", { source: "x.md" }), "---\ninclusion: always\n---\n\n<!-- imported from x.md -->\n");
  assert.equal(withSteeringFrontMatter(""), "---\ninclusion: always\n---\n\n");
  assert.equal(withSteeringFrontMatter("body only"), "---\ninclusion: always\n---\n\nbody only");
  assert.equal(withSteeringFrontMatter("\uFEFF# T\n", { source: "a--b.md" }), "---\ninclusion: always\n---\n\n<!-- imported from a- -b.md -->\n\n# T\n");
  assert.equal(parseSteering(withSteeringFrontMatter("")).inclusion, "always");
});

// ------------------------------------------------------------ scanner + command (11.3)

test("IMPORT_SOURCES: the seven documented globs in order; exclude and cap as documented", () => {
  assert.deepEqual(IMPORT_SOURCES, ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules/**", ".clinerules", ".continue/**", ".github/copilot-instructions.md"]);
  assert.equal(IMPORT_FIND_EXCLUDE, "{**/node_modules/**,**/.git/**}");
  assert.equal(IMPORT_FIND_MAX, 200);
});

const seedProject = () => {
  const root = tmpDir("steering");
  write(root, "AGENTS.md", "# Agents\nrules\n");
  write(root, "CLAUDE.md", "---\ndescription: claude\n---\nclaude rules\n");
  write(root, ".cursor/rules/style.mdc", "style\n");
  write(root, ".github/copilot-instructions.md", "copilot\n");
  write(root, ".kiro/steering/agents.md", "---\ninclusion: always\n---\nalready here\n");
  write(root, "node_modules/dep/AGENTS.md", "not ours\n");
  write(root, "README.md", "unrelated\n");
  return root;
};
const LABELS = [".cursor/rules/style.mdc", ".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md"];

test("scanImportSources: the four sources sorted by path with targets; node_modules skipped; .clinerules asked as file and dir", async () => {
  resetCalls();
  const root = seedProject();
  const found = await scanImportSources({ name: "proj", uri: uri(root) });
  assert.deepEqual(found.map((f) => f.relPath), LABELS);
  assert.deepEqual(found.map((f) => f.target), ["cursor-style", "copilot-instructions", "agents", "claude"]);
  assert.ok(found.every((f) => f.uri.path.startsWith(root + "/")));
  assert.deepEqual(stub.calls.findFiles.map((c) => c.pattern), ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules/**", ".clinerules", ".clinerules/**", ".continue/**", ".github/copilot-instructions.md"]);
  assert.ok(stub.calls.findFiles.every((c) => c.exclude === IMPORT_FIND_EXCLUDE && c.max === IMPORT_FIND_MAX));
  rm(root);
});

test("scanImportSources: sources sharing a stem get -2, -3 suffixes", async () => {
  resetCalls();
  const root = tmpDir("dupes");
  for (const f of ["x.mdc", "x.md", "X.txt"]) write(root, ".cursor/rules/" + f, f);
  assert.deepEqual((await scanImportSources(uri(root))).map((f) => f.target).sort(), ["cursor-x", "cursor-x-2", "cursor-x-3"]);
  rm(root);
});

test("importSteeringFromAssistants: 3 imported, 1 skipped as existing, view refreshed, picks describe target and warn on existing", async () => {
  resetCalls();
  const root = seedProject();
  let refreshed = 0;
  const result = await importSteeringFromAssistants({ refresh: () => refreshed++ }, [{ name: "proj", uri: uri(root) }]);
  assert.deepEqual(result, { imported: 3, skipped: 1, failed: [] });
  assert.equal(refreshed, 1);
  assert.equal(stub.calls.quickPicks.length, 1, "one folder: no folder pick");
  const { items, opts } = stub.calls.quickPicks[0];
  assert.equal(opts.canPickMany, true);
  assert.deepEqual(items.map((i) => i.label), LABELS);
  assert.deepEqual(items.map((i) => i.description), ["cursor-style.md", "copilot-instructions.md", "agents.md", "claude.md"]);
  assert.deepEqual(items.map((i) => i.detail), [undefined, undefined, "already exists, will be skipped", undefined]);
  assert.ok(items.every((i) => i.picked));
  const dir = path.join(root, ".kiro", "steering");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["agents.md", "claude.md", "copilot-instructions.md", "cursor-style.md"]);
  assert.equal(fs.readFileSync(path.join(dir, "agents.md"), "utf8"), "---\ninclusion: always\n---\nalready here\n", "the existing target is untouched");
  assert.equal(fs.readFileSync(path.join(dir, "cursor-style.md"), "utf8"), "---\ninclusion: always\n---\n\n<!-- imported from .cursor/rules/style.mdc -->\n\nstyle\n");
  const claude = parseSteering(fs.readFileSync(path.join(dir, "claude.md"), "utf8"));
  assert.deepEqual([claude.inclusion, claude.description], ["always", "claude"]);
  assert.match(stub.calls.info[0], /Imported 3, skipped 1 \(existing\)\.$/);
  rm(root);
});

test("importSteeringFromAssistants: nothing found → message, null; pick dismissed → null, nothing written; no folder → error", async () => {
  resetCalls();
  const empty = tmpDir("empty");
  write(empty, "README.md", "x");
  assert.equal(await importSteeringFromAssistants({ refresh() {} }, [{ name: "empty", uri: uri(empty) }]), null);
  assert.match(stub.calls.info[0], /no instruction files from other assistants in empty/);
  assert.equal(stub.calls.quickPicks.length, 0);

  resetCalls();
  const root = seedProject();
  stub.nextPick = () => undefined;
  assert.equal(await importSteeringFromAssistants({ refresh() {} }, [{ name: "proj", uri: uri(root) }]), null);
  assert.deepEqual(fs.readdirSync(path.join(root, ".kiro", "steering")), ["agents.md"], "a cancelled pick writes nothing");
  rm(empty, root);

  resetCalls();
  assert.equal(await importSteeringFromAssistants({ refresh() {} }, []), null);
  assert.match(stub.calls.errors[0], /Open a folder first/);
});

test("importSteeringFromAssistants: several folders → a folder pick first; dismissing it returns null before any scan", async () => {
  resetCalls();
  stub.nextPick = () => undefined;
  assert.equal(await importSteeringFromAssistants(null, [{ name: "a", uri: uri("/a") }, { name: "b", uri: uri("/b") }]), null);
  assert.deepEqual(stub.calls.quickPicks[0].items.map((i) => i.label), ["$(root-folder) a", "$(root-folder) b"]);
  assert.equal(stub.calls.findFiles.length, 0);
});

// ------------------------------------------------------------ steering document predicates

test("isSteeringDocument / steeringNameOf: .kiro/steering/**/*.md in either tier, name without .md", () => {
  assert.equal(isSteeringDocument("/w/.kiro/steering/tech.md"), true);
  assert.equal(isSteeringDocument(uri("/home/me/.kiro/steering/backend/api.MD")), true);
  assert.equal(isSteeringDocument("C:\\w\\.kiro\\steering\\x.md"), true);
  for (const no of ["/w/.kiro/steering/", "/w/.kiro/skills/x/SKILL.md", "/w/steering/tech.md", null]) assert.equal(isSteeringDocument(no), false, String(no));
  assert.equal(steeringNameOf("/w/.kiro/steering/tech.md"), "tech");
  assert.equal(steeringNameOf(uri("/w/.kiro/steering/backend/api.md")), "backend/api");
  assert.equal(steeringNameOf("/elsewhere/notes.md"), "notes", "outside the tree: the basename");
});

// ------------------------------------------------------------ GitHub URL parser (11.4)

// Shared with tests/skills_import_test.py, which parses the JSON array between
// the two markers: rows are [input, accepted, ref, path]; every accepted input
// names owner "anthropics" and repo "skills". Keep it a plain JSON literal.
// URL_TABLE_BEGIN
const URL_TABLE = [
  ["https://github.com/anthropics/skills", true, null, null],
  ["https://github.com/anthropics/skills.git", true, null, null],
  ["https://github.com/anthropics/skills/", true, null, null],
  ["https://github.com/anthropics/skills?tab=readme#top", true, null, null],
  ["http://www.github.com/anthropics/skills", true, null, null],
  ["github.com/anthropics/skills", true, null, null],
  ["https://github.com/anthropics/skills/tree/main", true, "main", null],
  ["https://github.com/anthropics/skills/tree/main/skills/pdf", true, "main", "skills/pdf"],
  ["https://github.com/anthropics/skills/tree/v1.2/skills/pdf/", true, "v1.2", "skills/pdf"],
  ["https://github.com/anthropics/skills/blob/v1.2/skills/pdf/SKILL.md", true, "v1.2", "skills/pdf"],
  ["https://github.com/anthropics/skills/blob/main/SKILL.md", true, "main", null],
  ["anthropics/skills", true, null, null],
  ["  anthropics/skills/tree/dev/x  ", true, "dev", "x"],
  ["https://gitlab.com/anthropics/skills", false, null, null],
  ["https://github.com.evil.example/anthropics/skills", false, null, null],
  ["git@github.com:anthropics/skills.git", false, null, null],
  ["ssh://git@github.com/anthropics/skills", false, null, null],
  ["ftp://github.com/anthropics/skills", false, null, null],
  ["https://github.com/anthropics/skills/tree/main/../x", false, null, null],
  ["https://github.com/anthropics/../skills", false, null, null],
  ["https://github.com/anthropics", false, null, null],
  ["https://github.com/anthropics/skills/tree", false, null, null],
  ["https://github.com/anthropics/skills/blob/main/README.md", false, null, null],
  ["https://github.com/anthropics/skills/pulls/1", false, null, null],
  ["https://github.com/anthropics/sk ills", false, null, null],
  ["/anthropics/skills", false, null, null],
  ["anthropics/skills?x=1", false, null, null],
  ["", false, null, null],
  ["   ", false, null, null]
];
// URL_TABLE_END

test("parseGithubSkillUrl: the shared table (https, .git, slash, query, tree/ref/path, blob/SKILL.md, shorthand; rejects)", () => {
  for (const [input, ok, ref, p] of URL_TABLE) assert.deepEqual(parseGithubSkillUrl(input), ok ? { owner: "anthropics", repo: "skills", ref, path: p } : null, JSON.stringify(input));
  assert.equal(parseGithubSkillUrl(null), null);
  assert.equal(parseGithubSkillUrl(42), null);
});

test("skillNameFromText / SKILL_NAME_RE: the front-matter name when safe, else the fallback", () => {
  assert.equal(skillNameFromText("---\nname: pdf-tools\ndescription: x\n---\nbody", "folder"), "pdf-tools");
  assert.equal(skillNameFromText("---\nName: \"quoted.name\"\n---\n", "folder"), "quoted.name");
  for (const t of ["---\nname: ../evil\n---\n", "---\nname: has space\n---\n", "---\ndescription: no name\n---\n", "no front matter", null]) assert.equal(skillNameFromText(t, "folder"), "folder", JSON.stringify(t));
  assert.ok(SKILL_NAME_RE.test("a") && SKILL_NAME_RE.test("A1._-") && !SKILL_NAME_RE.test("-a") && !SKILL_NAME_RE.test("a".repeat(65)));
});

// ------------------------------------------------------------ local skill folder (11.4)

test("importSkillFolder: copies the folder under the scope as its front-matter name; refuses existing; refuses no SKILL.md", async () => {
  const src = tmpDir("skillsrc");
  const scopeRoot = tmpDir("skillscope");
  const skillDir = path.join(src, "my-folder");
  write(skillDir, SKILL_FILE, "---\nname: pdf-tools\n---\n# PDF\n");
  write(skillDir, "scripts/run.sh", "echo hi\n");
  const scope = { scope: "workspace", uri: uri(path.join(scopeRoot, ".kiro", "skills")) };

  const first = await importSkillFolder(uri(skillDir), scope);
  assert.deepEqual(first, { name: "pdf-tools", path: scope.uri.path + "/pdf-tools" });
  assert.equal(fs.readFileSync(path.join(first.path, SKILL_FILE), "utf8"), "---\nname: pdf-tools\n---\n# PDF\n");
  assert.equal(fs.readFileSync(path.join(first.path, "scripts", "run.sh"), "utf8"), "echo hi\n", "the whole folder is copied");
  assert.deepEqual(await importSkillFolder(uri(skillDir), scope), { error: "skill pdf-tools already exists", name: "pdf-tools", path: first.path });

  const plain = path.join(src, "plain-name");
  write(plain, SKILL_FILE, "# no front matter\n");
  assert.deepEqual(await importSkillFolder(uri(plain), scope), { name: "plain-name", path: scope.uri.path + "/plain-name" }, "basename when the front matter has no name");

  const bare = path.join(src, "bare");
  write(bare, "README.md", "not a skill\n");
  assert.deepEqual(await importSkillFolder(uri(bare), scope), { error: bare + " has no " + SKILL_FILE });
  assert.ok(!fs.existsSync(path.join(scope.uri.path, "bare")));

  const badName = path.join(src, "bad name");
  write(badName, SKILL_FILE, "x");
  assert.match((await importSkillFolder(uri(badName), scope)).error, /cannot be used on disk/);
  rm(src, scopeRoot);
});
