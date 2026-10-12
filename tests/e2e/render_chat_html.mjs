// Print a webview document of extension.js to stdout, loading the extension
// under the same minimal `vscode` stub the unit tests use. For the headless
// probes (tests/e2e/probe_chat_webview.py, probe_spec_editor.py) that drive the
// real document in a browser without a workbench.
//
//   node tests/e2e/render_chat_html.mjs [foxUri]                 -> chatHtml()
//   node tests/e2e/render_chat_html.mjs --spec <name> <stage>     -> specEditorHtml(name, stage, all present)
//   node tests/e2e/render_chat_html.mjs --md <file>              -> mdToHtml(contents of file)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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

const ext = require(path.join(here, "..", "..", "extension", "extension.js"));
const [mode, a, b] = process.argv.slice(2);
if (mode === "--spec") {
  const present = { "requirements.md": true, "design.md": true, "tasks.md": true };
  process.stdout.write(ext.__test.specEditorHtml(a || "my-feature", { file: b || "tasks.md", label: "Task list", n: 3 }, present));
} else if (mode === "--md") {
  process.stdout.write(ext.__test.mdToHtml(fs.readFileSync(a, "utf8")));
} else {
  process.stdout.write(ext.__test.chatHtml(mode || "fox.svg"));
}
