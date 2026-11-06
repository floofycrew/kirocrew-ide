// KiroCrew Spec Preview — a markdown-it plugin for the IDE's BUILT-IN Markdown
// preview, so Shift+Cmd+V on a Kiro spec file shows the spec, not a wall of
// `- [ ] 1.` boxes. Lives in its own extension because the preview only picks
// up plugins from extensions in the SAME extension host as the built-in
// markdown extension (the engine's workspace host); the bridge runs in the
// browser's web-worker host and cannot contribute here.
//
// What it does, and only for files under `.kiro/specs/<name>/`:
//   * tasks.md — every task row (`- [ ] 1. Title`, Kiro's four states ` ` `~`
//     `-` `x`, optional `*`) renders with a state box in place of the bracket
//     text, a class for the state (`kc-task kc-not_started` …) and an
//     "optional" tag; a strip at the top shows the spec name and the counts.
//   * requirements.md / design.md — the strip names the spec and the phase.
// Nothing else in the document is touched; mermaid, images, links and the
// preview's own scroll sync (`data-line` on every block) work as before.
//
// Why renderer rules and not a core rule: the preview tokenizes a document
// once per version WITHOUT the document in the env and caches the tokens; the
// render pass is what receives `env.currentDocument`. So the decision "is
// this a spec file" can only be made while rendering, and the tokens are never
// mutated (a mutation would persist in the cache and double up on the next
// render). The marker text is removed through a budget on the env that the
// `text` rule consumes.

"use strict";

const SPEC_PATH = /[\\/]\.kiro[\\/]specs[\\/]([^\\/]+)[\\/](requirements|design|tasks)\.md$/i;
const STATES = { " ": "not_started", "~": "queued", "-": "in_progress", "x": "completed" };
const STATE_LABEL = { not_started: "not started", queued: "queued", in_progress: "in progress", completed: "done" };
const STATE_GLYPH = { not_started: "", queued: "…", in_progress: "▶", completed: "✓" };
const PHASE_LABEL = { requirements: "Requirements", design: "Design", tasks: "Task list" };

/** `{name, phase}` of a spec document, from the render env's `currentDocument`; null for any other file. */
function specOf(env) {
  const doc = env && env.currentDocument;
  if (!doc) return null;
  const p = typeof doc === "string" ? doc : String(doc.fsPath || doc.path || "");
  const m = p.match(SPEC_PATH);
  return m ? { name: m[1], phase: m[2].toLowerCase() } : null;
}

/**
 * Reads a task row off the leading text of an inline token's children (what
 * the preview will print, escapes already resolved): `{state, optional,
 * markerLen}` or null. `markerLen` is the number of rendered characters that
 * make up `[x]* ` — the budget the text rule strips.
 */
function taskOf(inline) {
  const children = (inline && inline.children) || [];
  let joined = "";
  for (const c of children) {
    if (c.type !== "text" && c.type !== "text_special") break;
    joined += c.content;
    if (joined.length > 12) break; // the marker is at most `[x]\* ` plus spaces
  }
  const m = joined.match(/^\[([ xX\-~])\](\*?)[ \t]+(?=\S)/);
  if (!m) return null;
  return { state: STATES[m[1].toLowerCase()], optional: m[2] === "*", markerLen: m[0].length };
}

/** The inline token of a list item (`list_item_open` → `paragraph_open` → `inline`), or null. */
function inlineOfItem(tokens, idx) {
  const a = tokens[idx + 1], b = tokens[idx + 2];
  if (a && a.type === "inline") return a;
  if (a && a.type === "paragraph_open" && b && b.type === "inline") return b;
  return null;
}

/** Counts over a token stream: how many task rows per state, and how many optional. */
function summarize(tokens) {
  const counts = { total: 0, not_started: 0, queued: 0, in_progress: 0, completed: 0, optional: 0 };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "list_item_open") continue;
    const task = taskOf(inlineOfItem(tokens, i));
    if (!task) continue;
    counts.total++;
    counts[task.state]++;
    if (task.optional) counts.optional++;
  }
  return counts;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The strip above the document: spec name, phase and (tasks.md) the counts and a bar. */
function stripHtml(spec, counts) {
  const parts = ['<div class="kc-spec-strip" data-kc-phase="' + esc(spec.phase) + '">',
    '<span class="kc-name">' + esc(spec.name) + "</span>",
    '<span class="kc-phase">' + esc(PHASE_LABEL[spec.phase] || spec.phase) + "</span>"];
  if (spec.phase === "tasks" && counts && counts.total) {
    const pct = Math.round((counts.completed / counts.total) * 100);
    const live = Math.round(((counts.in_progress + counts.queued) / counts.total) * 100);
    parts.push('<span class="kc-count">' + counts.completed + "/" + counts.total + " done</span>");
    if (counts.in_progress) parts.push('<span class="kc-count kc-live">' + counts.in_progress + " in progress</span>");
    if (counts.queued) parts.push('<span class="kc-count kc-live">' + counts.queued + " queued</span>");
    if (counts.optional) parts.push('<span class="kc-count kc-opt">' + counts.optional + " optional</span>");
    parts.push('<span class="kc-bar" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100">' +
      '<span class="kc-bar-done" style="width:' + pct + '%"></span><span class="kc-bar-live" style="width:' + live + '%"></span></span>');
  }
  parts.push("</div>");
  return parts.join("");
}

function boxHtml(task) {
  const state = task.state;
  return '<span class="kc-box kc-box-' + state + '" role="img" aria-label="' + esc(STATE_LABEL[state]) + '" title="' + esc(STATE_LABEL[state]) + '">' + STATE_GLYPH[state] + "</span>" +
    (task.optional ? '<span class="kc-optional" title="optional task: skipped by Run all tasks unless made required">optional</span>' : "");
}

/** Install the renderer rules on a markdown-it instance; returns it (the markdown extension's contract). */
function extendMarkdownIt(md) {
  const rules = md.renderer.rules;
  const prevItem = rules.list_item_open;
  const prevItemClose = rules.list_item_close;
  const prevText = rules.text;
  const prevRender = md.renderer.render;

  md.renderer.render = function (tokens, options, env) {
    const spec = specOf(env);
    if (!spec) return prevRender.call(this, tokens, options, env);
    env.kcSpec = spec;
    env.kcStrip = null;
    const body = prevRender.call(this, tokens, options, env);
    env.kcSpec = null;
    return stripHtml(spec, spec.phase === "tasks" ? summarize(tokens) : null) + body;
  };

  rules.list_item_open = function (tokens, idx, options, env, self) {
    const spec = env && env.kcSpec;
    if (spec && spec.phase === "tasks") {
      const task = taskOf(inlineOfItem(tokens, idx));
      if (task) {
        const token = tokens[idx];
        if (token.attrGet("data-kc-state") !== task.state) {
          token.attrSet("data-kc-state", task.state);
          token.attrJoin("class", "kc-task kc-" + task.state + (task.optional ? " kc-optional-task" : ""));
        }
        env.kcStrip = { remaining: task.markerLen, box: boxHtml(task) };
      }
    }
    return prevItem ? prevItem(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };

  rules.list_item_close = function (tokens, idx, options, env, self) {
    if (env) env.kcStrip = null; // a budget nothing consumed must not leak into the next row
    return prevItemClose ? prevItemClose(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };

  rules.text = function (tokens, idx, options, env, self) {
    const strip = env && env.kcStrip;
    const render = (toks, i) => (prevText ? prevText(toks, i, options, env, self) : esc(toks[i].content));
    if (!strip || strip.remaining <= 0) return render(tokens, idx);
    const token = tokens[idx];
    const take = Math.min(strip.remaining, token.content.length);
    strip.remaining -= take;
    const box = strip.box;
    strip.box = "";
    const rest = token.content.slice(take);
    if (!rest) return box;
    // Render the remainder as the default rule would, without touching the cached token.
    const clone = Object.assign(Object.create(Object.getPrototypeOf(token)), token, { content: rest });
    return box + render([clone], 0);
  };

  return md;
}

function activate() {
  return { extendMarkdownIt };
}

function deactivate() {}

module.exports = { activate, deactivate, extendMarkdownIt, specOf, taskOf, summarize, stripHtml, SPEC_PATH };
