// KiroCrew bridge — a WEB extension running in the workbench the kirocrew-ide
// mod serves on the DASHBOARD ORIGIN (same-origin proxy). That one fact is the
// whole design: `fetch(ORIGIN + "/api/...")` from the extension host worker
// carries the user's dashboard session cookie and passes the dashboard's
// Origin check, so the IDE talks to KiroCrew exactly as the dashboard's own
// frontend does — no bridge credential, nothing minted, nothing stored. The
// IDE user IS the dashboard user.
//
// What it gives the IDE:
//   * Chat (webview view): a KiroCrew session per chat, streamed live over the
//     dashboard WebSocket (chat_chunk / chat_message / chat_done frames), any
//     installed agent selectable, sessions created inside the "KiroCrew IDE"
//     dashboard folder. Close the laptop: the session keeps running in the
//     gateway; reopen anywhere and the transcript is there.
//   * Sessions view: every session in that folder, busy/waiting state live.
//   * Approvals: a session waiting on a tool approval raises a notification
//     with Approve / Reject (POST .../approve), so nothing stalls unseen.
//   * Specs view: `.kiro/specs/<name>/{requirements,design,tasks}.md` with the
//     Kiro spec flow — write requirements, then design, then tasks; run one
//     task or all remaining ones, each as its own durable KiroCrew session whose
//     agent edits the workspace directly; task checkboxes update as tasks.md
//     changes on disk.
//
// Plain CommonJS, `require("vscode")` only (the web extension host provides
// it); no other module is available in this worker.
"use strict";

const vscode = require("vscode");

const ORIGIN = (typeof self !== "undefined" && self.origin && self.origin !== "null") ? self.origin : "";
const API = ORIGIN + "/api";
const IDE_TAG = "kirocrew-ide";
//: A visible chat view that has not said `ready` this long gets its document reloaded, this many times.
const CHAT_WATCHDOG_MS = 8000;
const CHAT_WATCHDOG_RELOADS = 2;

let _output = null;
/** The "KiroCrew IDE" output channel: where the bridge writes what a user can be asked to paste. */
function output() {
  if (!_output) _output = vscode.window.createOutputChannel("KiroCrew IDE");
  return _output;
}
function log(line) {
  const text = new Date().toISOString() + " " + line;
  console.log("[kirocrew] " + line);
  try { output().appendLine(text); } catch { /* channel gone */ }
}

// ------------------------------------------------------------------ http

async function api(path, init) {
  const headers = Object.assign({ Accept: "application/json" }, (init && init.headers) || {});
  if (init && init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    init = Object.assign({}, init, { body: JSON.stringify(init.json) });
    delete init.json;
  }
  const reply = await fetch(API + path, Object.assign({ credentials: "same-origin" }, init || {}, { headers }));
  let body = null;
  const text = await reply.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!reply.ok) {
    let message = (body && (body.error || body.message)) || ("HTTP " + reply.status + " " + path);
    if (reply.status === 404 && !(body && body.error)) {
      // The workbench is being viewed on the engine's own port, not through the dashboard.
      message = "KiroCrew API is not on this origin (" + ORIGIN + "). Open the IDE through the KiroCrew dashboard: Apps → KiroCrew IDE.";
    } else if (reply.status === 401 || reply.status === 403) {
      message = "KiroCrew session expired — sign in to the dashboard again, then reload the IDE.";
    }
    const err = new Error(message);
    err.status = reply.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Same directory ignoring a trailing slash and a `/local` prefix (symlinked homes spell one dir two ways). */
function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/\/+$/, "").replace(/^\/local(\/home\/)/, "$1");
  return norm(a) === norm(b);
}

/**
 * A slot timestamp as epoch milliseconds, or 0 when there is none. The host
 * projects `last_activity_ts` / `last_ts` / `created` as ISO-8601 strings
 * (`datetime.isoformat()`); `Number()` on those is NaN, which once printed
 * "Invalid Date" on every history row and made the newest-first sort a no-op.
 * Epoch seconds and milliseconds are accepted too, for older or foreign rows.
 */
function slotTime(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : 0;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}
/** When a slot was last active: the newest of its activity, last turn and creation stamps. */
function slotActivity(s) {
  return Math.max(slotTime(s && s.last_activity_ts), slotTime(s && s.last_ts), slotTime(s && s.created));
}
/** A short age for a history row, the way the dashboard's session list reads ("3 h ago"); a date past a week. */
function ageLabel(ms, now = Date.now()) {
  if (!ms) return "";
  const diff = Math.max(0, now - ms);
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + " min ago";
  const h = Math.round(min / 60);
  if (h < 24) return h + " h ago";
  const d = Math.round(h / 24);
  if (d < 7) return d + " d ago";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function cfg(key, fallback) {
  const v = vscode.workspace.getConfiguration("kirocrew").get(key);
  return v === undefined || v === null || v === "" ? fallback : v;
}

// ------------------------------------------------------------- live feed

/** One WebSocket to the dashboard; frames fan out to listeners. Reconnects with backoff. */
class Feed {
  constructor() {
    this.listeners = new Set();
    this.ws = null;
    this.delay = 1000;
    this.closed = false;
  }
  start() {
    if (!ORIGIN || this.closed) return;
    const url = ORIGIN.replace(/^http/, "ws") + "/api/ws";
    try {
      this.ws = new WebSocket(url);
    } catch (error) {
      this.retry();
      return;
    }
    this.ws.onopen = () => { this.delay = 1000; this.emit({ type: "_open" }); };
    this.ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      this.emit(frame);
    };
    this.ws.onclose = () => { this.ws = null; this.retry(); };
    this.ws.onerror = () => { try { this.ws && this.ws.close(); } catch { /* closing */ } };
  }
  retry() {
    if (this.closed) return;
    setTimeout(() => this.start(), this.delay);
    this.delay = Math.min(this.delay * 2, 30000);
  }
  emit(frame) {
    for (const fn of this.listeners) {
      try { fn(frame); } catch (error) { console.warn("[kirocrew] listener failed", error); }
    }
  }
  on(fn) { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }
  dispose() { this.closed = true; try { this.ws && this.ws.close(); } catch { /* closing */ } }
}

// ------------------------------------------------------------- sessions

/** Sessions the IDE owns: the dashboard folder named by `kirocrew.folderName`, created on first use. */
class Sessions {
  constructor(feed) {
    this.feed = feed;
    this.slots = [];        // serialized slots (all)
    this.folderId = null;
    this.agents = [];
    this._change = new vscode.EventEmitter();
    this.onDidChange = this._change.event;
    feed.on((frame) => {
      if (frame.type === "slots" && Array.isArray(frame.data)) {
        this.slots = frame.data;
        this._change.fire();
      } else if (frame.type === "_open") {
        this.refresh().catch(() => undefined);
      }
    });
  }
  async ensureFolder() {
    const name = cfg("folderName", "KiroCrew IDE");
    const doc = await api("/chat/folders");
    const list = Array.isArray(doc) ? doc : (doc && (doc.folders || doc.items)) || [];
    let folder = list.find((f) => f && f.name === name);
    if (!folder) {
      folder = await api("/chat/folders", { method: "POST", json: { name } });
      folder = (folder && folder.folder) || folder;
    }
    this.folderId = folder && folder.id ? folder.id : null;
    return this.folderId;
  }
  async refresh() {
    // Two rosters, like the dashboard's own selector: /api/agents is the crew's
    // registered agents (config.json); /api/agents/installed is every spec found
    // in ~/.kiro/agents — which is where drop-in agents such as Kiro Spec &
    // Plan's live. Reading only the first hid those from the IDE.
    const [slots, agents, installed] = await Promise.all([
      api("/chat/slots").catch(() => []),
      api("/agents").catch(() => []),
      api("/agents/installed").catch(() => []),
    ]);
    this.slots = Array.isArray(slots) ? slots : (slots && slots.slots) || [];
    this.agents = mergeRosters(agents, installed);
    if (this.folderId === null) await this.ensureFolder().catch(() => undefined);
    this._change.fire();
  }
  /** The workspace folder this IDE has open (first root); sessions are bound to it as their project. */
  projectPath() {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.length ? folders[0].uri.path : "";
  }
  /**
   * Sessions of THIS workspace: exactly those whose project is the open folder,
   * whether created here or by picking the folder in the dashboard. The
   * dashboard folder ("KiroCrew IDE") and the key prefix are NOT filters: they
   * are shared by the IDE's sessions from every workspace, and matching on them
   * mixed all workspaces' histories together. With no folder open, only our own
   * project-less sessions qualify.
   */
  mine() {
    const project = this.projectPath();
    if (project) return this.slots.filter((s) => sameDir(s.project, project));
    return this.slots.filter((s) => !s.project && String(s.key || "").startsWith(IDE_TAG + "-"));
  }
  /** History for the tabs and the picker: this project's sessions, newest activity first (running ones ahead of idle ones at the same stamp). */
  history() {
    return this.mine()
      .map((s, i) => ({ s, i, t: slotActivity(s) }))
      .sort((a, b) => (b.t - a.t) || (Number(Boolean(b.s.running)) - Number(Boolean(a.s.running))) || (a.i - b.i))
      .map((r) => r.s);
  }
  slot(key) { return this.slots.find((s) => s.key === key); }
  async create({ agent, title, kind } = {}) {
    // Folder grouping is a nicety; a session must still be created when the folder API misbehaves.
    await this.ensureFolder().catch((error) => console.warn("[kirocrew] folder unavailable, session goes ungrouped", error));
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const name = IDE_TAG + "-" + (kind || "chat") + "-" + stamp;
    const json = { name, memory_mode: "persistent", mode: "" };
    if (this.folderId) json.folder_id = this.folderId;
    if (agent) json.agent = agent;
    const created = await api("/chat/slots", { method: "POST", json });
    const key = (created && (created.key || created.slot || (created.slot && created.slot.key))) || name;
    // Bind the session to the open workspace folder — the same "project" a
    // dashboard session gets when you pick a folder there, so the two stay in
    // step: the agent works in this folder, and the dashboard lists it here.
    const project = this.projectPath();
    if (project) {
      await api("/chat/slots/" + encodeURIComponent(key) + "/project", { method: "POST", json: { project } })
        .catch((error) => console.warn("[kirocrew] could not bind the session to " + project, error));
    }
    if (title) {
      await api("/chat/slots/" + encodeURIComponent(key) + "/title", { method: "PATCH", json: { title } }).catch(() => undefined);
    }
    await this.refresh().catch(() => undefined);
    return key;
  }
  /**
   * `meta` rides the send the way the dashboard composer's does (`files`: the
   * uploaded paths the `[attached_file N]` markers in `message` index into),
   * so the host persists the row in the same shape and its own transcript
   * renders attachment cards for a session started here.
   */
  async send(key, message, agent, meta) {
    const json = { slot: key, message };
    if (agent) json.agent = agent;
    if (meta) json.meta = meta;
    return api("/chat?ws=1", { method: "POST", json });
  }
  async stop(key) { return api("/chat/slots/" + encodeURIComponent(key) + "/stop", { method: "POST", json: {} }); }
  async approve(key, requestId, action) {
    return api("/chat/slots/" + encodeURIComponent(key) + "/approve", { method: "POST", json: { action, request_id: requestId } });
  }
  /** The persisted transcript of one session. (Not `history`: that name is the project filter above, and a
   *  second method of the same name silently replaced it — the History picker then fetched `/slots/undefined`.) */
  async transcript(key) {
    const doc = await api("/chat/slots/" + encodeURIComponent(key));
    return Array.isArray(doc) ? doc : (doc && (doc.messages || doc.history)) || [];
  }
  // -- per-session controls the composer bar drives ------------------------
  async models() {
    if (this._models) return this._models;
    const doc = await api("/models").catch(() => []);
    const list = Array.isArray(doc) ? doc : (doc && doc.models) || [];
    this._models = list.map((m) => ({ id: m.model_name || m.model_id || m.id || "", label: m.display_name || m.name || m.model_name || "" }))
      .filter((m) => m.id);
    return this._models;
  }
  async effortLevels(key) {
    const doc = await api("/effort-levels" + (key ? "?slot=" + encodeURIComponent(key) : "")).catch(() => []);
    return (Array.isArray(doc) ? doc : (doc && doc.levels) || []).filter((l) => typeof l === "string" && l);
  }
  setModel(key, model) { return api("/chat/slots/" + encodeURIComponent(key) + "/model", { method: "POST", json: { model: model || "" } }); }
  setEffort(key, effort) { return api("/chat/slots/" + encodeURIComponent(key) + "/reasoning-effort", { method: "POST", json: { reasoning_effort: effort || "" } }); }
  setSlotAgent(key, agent) { return api("/chat/slots/" + encodeURIComponent(key) + "/agent", { method: "POST", json: { agent: agent || "" } }); }
  /** Autopilot: the host's slot-scoped trust — every tool of this session is approved without asking. */
  setTrust(key, on) { return api("/chat/mode", { method: "POST", json: { mode: on ? "trust" : "normal", slot: key } }); }
  /** Silent background context, prepended by the host to the next user turn (never shown in the transcript). */
  inject(key, content, source) {
    // The host refuses a context entry over HOST_CONTEXT_MAX chars (400,
    // "content exceeds 40000 char limit"); clip here, where every caller
    // funnels through, so an oversized pick is shortened rather than lost.
    return api("/chat/slots/" + encodeURIComponent(key) + "/context", { method: "POST", json: { content: clip(content, HOST_CONTEXT_MAX - 200), source: source || "kirocrew-ide", ephemeral: true } });
  }
  /** Upload one file to the host's uploads dir; returns its server-side path (an image path in a message becomes a real image block). */
  async upload(name, bytes, mime) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime || "application/octet-stream" }), name);
    const doc = await api("/upload/file", { method: "POST", body: form });
    const paths = (doc && doc.paths) || [];
    if (!paths.length) throw new Error("upload returned no path");
    return paths[0];
  }
}

// ------------------------------------------------------------ approvals

function watchApprovals(feed, sessions, context) {
  const seen = new Set();
  context.subscriptions.push(feed.on(async (frame) => {
    if (frame.type !== "chat_message" || !frame.data || frame.data.role !== "permission") return;
    if (!cfg("notifyApprovals", true)) return;
    const d = frame.data;
    const mine = sessions.mine().some((s) => s.key === d.slot);
    if (!mine) return;
    let meta = d.meta || {};
    if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = {}; } }
    const requestId = meta.request_id || meta.approval_id || "";
    const dedupe = d.slot + ":" + (requestId || d.ts);
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const title = meta.tool_title || meta.tool_name || "tool";
    const detail = (meta.full_command || meta.tool_input || d.content || "").toString().slice(0, 300);
    const slot = sessions.slot(d.slot);
    const label = (slot && (slot.title || slot.label)) || d.slot;
    const choice = await vscode.window.showWarningMessage(
      "KiroCrew · " + label + " asks to run " + title + (detail ? ": " + detail : ""),
      { modal: false }, "Approve", "Reject", "Open session");
    if (choice === "Approve") await sessions.approve(d.slot, requestId, "approved").catch((e) => vscode.window.showErrorMessage("approve failed: " + e.message));
    else if (choice === "Reject") await sessions.approve(d.slot, requestId, "rejected").catch((e) => vscode.window.showErrorMessage("reject failed: " + e.message));
    else if (choice === "Open session") vscode.commands.executeCommand("kirocrew.openSession", d.slot);
  }));
}

// -------------------------------------------------------------- chat view

/** A script-free webview page: shown when a resolver throws, so a failure is text instead of a blank body. */
function errorHtml(where, error) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return "<!doctype html><html><body style=\"font:13px/1.6 sans-serif;padding:16px;color:#c66\">" +
    "<strong>KiroCrew " + esc(where) + " failed to load</strong><br><code style=\"white-space:pre-wrap\">" + esc(error && error.stack || error) + "</code>" +
    "<br><br>Please screenshot this and report it.</body></html>";
}

class ChatView {
  /**
   * Tabbed chat: every open tab is a KiroCrew session key (or a draft with no
   * session yet); the webview owns one transcript per tab and the extension
   * feeds frames to the right one. Open tabs are remembered per workspace so a
   * reload brings them back; the History drawer lists every session of this
   * project (dashboard-created ones too) for reopening.
   */
  constructor(context, sessions, feed) {
    this.context = context;
    this.sessions = sessions;
    this.feed = feed;
    this.view = null;
    this.tabs = [];          // [{ id, key|null, title, settings }]
    this.active = null;      // tab id
    this.agent = cfg("agent", "");
    this.nextId = 1;
    this.lastSettings = null; // a new tab inherits the previous tab's picks
    feed.on((frame) => this.onFrame(frame));
    sessions.onDidChange(() => this.pushTabs());
    this.restoreTabs();
  }
  storageKey() { return "kirocrew.tabs:" + (this.sessions.projectPath() || "-"); }
  /** Per-tab composer picks: agent, model, reasoning effort, workflow mode, Autopilot. */
  defaultSettings() {
    return Object.assign({ agent: this.agent || "", model: "", effort: "", mode: "default", autopilot: false }, this.lastSettings || {});
  }
  restoreTabs() {
    const saved = this.context.workspaceState.get(this.storageKey());
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      this.tabs = saved.tabs.filter((t) => t && t.key).map((t) => ({ id: this.nextId++, key: t.key, title: t.title || t.key, settings: Object.assign(this.defaultSettings(), t.settings || {}) }));
      this.active = this.tabs.length ? this.tabs[0].id : null;
      if (this.tabs.length) this.lastSettings = Object.assign({}, this.tabs[this.tabs.length - 1].settings);
    }
    if (!this.tabs.length) this.newTab();
  }
  saveTabs() {
    this.context.workspaceState.update(this.storageKey(), { tabs: this.tabs.filter((t) => t.key).map((t) => ({ key: t.key, title: t.title, settings: t.settings })) });
  }
  tab(id) { return this.tabs.find((t) => t.id === id) || null; }
  tabForKey(key) { return this.tabs.find((t) => t.key === key) || null; }
  get key() { const t = this.tab(this.active); return t ? t.key : null; }
  set key(value) { const t = this.tab(this.active); if (t) { t.key = value; this.saveTabs(); this.pushTabs(); } }

  resolveWebviewView(view) {
    this.view = view;
    this.resolvedAt = Date.now();
    this.reloads = 0;
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidDispose(() => { this.view = null; this.disarmWatchdog(); });
    // A view restored hidden (or in a collapsed pane) cannot have run its script
    // yet; the watchdog only counts time the view is actually on screen.
    view.onDidChangeVisibility(() => { if (view.visible && !this.ready) this.armWatchdog("shown"); });
    this.setHtml();
  }
  /**
   * (Re)load the webview document. Seen on a live host (0.11.1, 2026-09-27): the
   * chat pane came up blank on a cold workbench start — no webview host request
   * ever reached the proxy — and closing and reopening the panel cured it. The
   * webview posts `ready` once its script runs; until that arrives nothing is
   * pushed to it (a message posted to a document that never loads is lost), and
   * a watchdog reloads the document when a visible view stays silent.
   */
  setHtml() {
    const view = this.view;
    if (!view) return;
    this.ready = false;
    try {
      view.webview.options = { enableScripts: true };
      let fox = "";
      try {
        fox = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "fox.svg")).toString();
      } catch (error) {
        console.warn("[kirocrew] fox uri unavailable", error);
      }
      view.webview.html = chatHtml(fox);
    } catch (error) {
      view.webview.html = errorHtml("chat", error);
      return;
    }
    if (view.visible) this.armWatchdog(this.reloads ? "reload " + this.reloads : "resolve");
  }
  /** The document said hello: now (and only now) hand it the tabs, the composer choices and the transcripts. */
  onReady() {
    this.disarmWatchdog();
    const wasReady = this.ready;
    this.ready = true;
    log(`chat view ready${wasReady ? " (again)" : ""} after ${Date.now() - (this.resolvedAt || Date.now())}ms, reloads=${this.reloads}`);
    this.pushTabs();
    this.pushChoices().catch((error) => console.warn("[kirocrew] composer choices unavailable", error));
    for (const t of this.tabs) if (t.key) this.load(t);
  }
  armWatchdog(why) {
    this.disarmWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.ready || !this.view || !this.view.visible) return;
      if (this.reloads < CHAT_WATCHDOG_RELOADS) {
        this.reloads += 1;
        log(`chat view blank ${CHAT_WATCHDOG_MS}ms after ${why} (visible, no ready) — reloading its document (${this.reloads}/${CHAT_WATCHDOG_RELOADS})`);
        this.setHtml();
        return;
      }
      log(`chat view still blank after ${this.reloads} reload(s) — giving up; use "KiroCrew: Reload chat view"`);
      vscode.window.showWarningMessage("The KiroCrew chat view did not load.", "Reload chat view", "Show log").then((pick) => {
        if (pick === "Reload chat view") this.reload("notification");
        else if (pick === "Show log") output().show(true);
      });
    }, CHAT_WATCHDOG_MS);
  }
  disarmWatchdog() { if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; } }
  /** The "KiroCrew: Reload chat view" command (and the watchdog's last resort). */
  reload(why) {
    if (!this.view) { vscode.commands.executeCommand("kirocrew.chat.focus"); return; }
    log(`chat view reload requested (${why || "command"})`);
    this.reloads = 0;
    this.setHtml();
  }
  post(msg) { if (this.view) this.view.webview.postMessage(msg); }
  /** The pick lists behind the composer bar: agents, models, effort levels, workflows. */
  async pushChoices() {
    await this.sessions.refresh().catch(() => undefined);
    const [models, efforts] = await Promise.all([this.sessions.models(), this.sessions.effortLevels(this.key)]);
    const dropped = this.pruneRetiredModels(models);
    if (dropped.length) log("dropped retired model pick(s) " + dropped.join(", ") + "; those tabs use the agent's model");
    this.post({
      type: "choices",
      agents: agentPicks(this.sessions.agents),
      models: [{ id: "", label: "agent's model", description: "the agent's configured default" }].concat(models.map((m) => ({ id: m.id, label: m.label || m.id, description: m.id !== m.label ? m.id : "" }))),
      efforts: [{ id: "", label: "default effort", description: "the model's default" }].concat(efforts.map((e) => ({ id: e, label: e[0].toUpperCase() + e.slice(1), description: "" }))),
    });
    this.post({ type: "fontSize", px: Number(cfg("chatFontSize", 0)) || 0 });
    this.post({ type: "composerHeight", px: Number(this.context.workspaceState.get("kirocrew.composerHeight")) || 0 });
    this.pushSteering().catch((error) => console.warn("[kirocrew] steering inventory unavailable", error));
  }
  /** The composer's steering indicator: every steering file of both tiers with its inclusion mode (fileMatch hits are decided per send). */
  async pushSteering() {
    const docs = await listSteering(this.sessions.projectPath());
    this.post({ type: "steering", items: docs.map((d) => ({ name: d.name, label: d.label, scope: d.scope, inclusion: d.inclusion, mode: steeringModeLabel(d), description: d.description, path: d.path })) });
  }
  /**
   * The picker's hint row was clicked: Kiro's mode agents are not installed.
   * Says which mod brings them and hands over the install command; "Check
   * again" re-reads the roster so a just-installed mod shows up without a
   * reload.
   */
  async explainModes() {
    const command = "floofy install " + MODES_MOD;
    const choice = await vscode.window.showInformationMessage(
      "Kiro's own Spec, Quick Spec, Bug Fix and Plan come from the " + MODES_MOD + " mod, which is not installed on this host. " +
      "Until it is, those picks run a prompt-guided version on your default agent. Install it from the FloofyCrew page in the dashboard, or run: " + command,
      "Copy command", "Check again");
    if (choice === "Copy command") await vscode.env.clipboard.writeText(command);
    if (choice === "Check again") await this.pushChoices();
  }
  pushTabs() {
    const rows = this.tabs.map((t) => {
      const slot = t.key ? this.sessions.slot(t.key) : null;
      // A live slot is the truth for what the session RUNS with (the dashboard
      // may have changed them, and the host fills a slot's model with the one it
      // serves). That is shown on the tab but kept apart from the user's own
      // picks: `t.settings` holds only what was chosen here, and it alone is
      // saved and inherited by new tabs. Folding the served model into the
      // picks used to re-pin a retired model id on every new tab after the
      // host's catalog had dropped it (InvalidModelError on the first turn).
      t.live = slot ? liveSettings(slot) : {};
      const shown = Object.assign({}, t.settings, t.live);
      return { id: t.id, key: t.key, title: (slot && (slot.title || slot.label)) || t.title || "New chat", settings: shown,
        running: Boolean(slot && slot.running), waiting: Boolean(slot && (slot.pending_approval || slot.needs_input || slot.waiting_for_input)) };
    });
    this.post({ type: "tabs", tabs: rows, active: this.active });
  }
  /**
   * Drop model picks the host no longer offers (a retired id persisted from an
   * earlier catalog), on every tab and on the inherited defaults. Returns the
   * ids dropped. No-op until the catalog has been read, and when it is empty.
   */
  pruneRetiredModels(models) {
    const known = new Set((models || []).map((m) => m.id));
    if (!known.size) return [];
    const dropped = new Set();
    const prune = (s) => { if (s && s.model && !known.has(s.model)) { dropped.add(s.model); s.model = ""; } };
    for (const t of this.tabs) prune(t.settings);
    prune(this.lastSettings);
    if (dropped.size) { this.saveTabs(); this.pushTabs(); }
    return [...dropped];
  }
  newTab(select = true) {
    const t = { id: this.nextId++, key: null, title: "New chat", settings: this.defaultSettings() };
    this.tabs.push(t);
    if (select) this.active = t.id;
    this.pushTabs();
    return t;
  }
  closeTab(id) {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    if (!this.tabs.length) this.newTab(false);
    if (this.active === id) this.active = this.tabs[Math.max(0, index - 1)].id;
    this.saveTabs();
    this.post({ type: "closed", id });
    this.pushTabs();
  }
  /** Open a session in a tab (existing tab if it is already open), select it, load its transcript. */
  async open(key) {
    let t = this.tabForKey(key);
    if (!t) {
      const draft = this.tabs.find((x) => !x.key && x.id === this.active) || null;
      t = draft || this.newTab(false);
      t.key = key;
      const slot = this.sessions.slot(key);
      t.title = (slot && (slot.title || slot.label)) || key;
      if (slot && slot.agent && slot.agent !== "default") t.settings.agent = slot.agent;
      this.saveTabs();
    }
    this.active = t.id;
    this.pushTabs();
    await this.load(t);
  }
  async load(t) {
    this.post({ type: "clear", id: t.id });
    this.post({ type: "session", id: t.id, key: t.key });
    const rows = await this.sessions.transcript(t.key).catch(() => []);
    for (const row of rows) this.post({ type: "row", id: t.id, row: normalizeRow(row) });
    this.post({ type: "scroll", id: t.id });
  }
  async onMessage(msg) {
    try {
      if (msg.type === "ready") { this.onReady(); return; }
      if (msg.type === "select") { this.active = msg.id; this.pushTabs(); return; }
      if (msg.type === "close") { this.closeTab(msg.id); return; }
      if (msg.type === "new") { this.newTab(); return; }
      if (msg.type === "history") { await vscode.commands.executeCommand("kirocrew.history"); return; }
      if (msg.type === "choices") { await this.pushChoices(); return; }
      if (msg.type === "hint") { await this.explainModes(); return; }
      if (msg.type === "fontSize") {
        await vscode.workspace.getConfiguration("kirocrew").update("chatFontSize", Number(msg.px) || 0, vscode.ConfigurationTarget.Global);
        return;
      }
      if (msg.type === "composerHeight") { await this.context.workspaceState.update("kirocrew.composerHeight", Number(msg.px) || 0); return; }
      if (msg.type === "steering") { await this.pushSteering(); return; }
      if (msg.type === "steeringOpen" && msg.path) { await openPathLink(msg.path); return; }
      if (msg.type === "steeringPick" && msg.name) {
        const d = (await listSteering(this.sessions.projectPath())).find((x) => x.name === msg.name);
        if (d) this.post({ type: "context", id: msg.id != null ? msg.id : this.active, item: await steeringContext(d, "picked") });
        return;
      }
      const t = this.tab(msg.id != null ? msg.id : this.active);
      if (!t) return;
      if (msg.type === "send") {
        await this.send(t, msg);
      } else if (msg.type === "setting") {
        await this.setSetting(t, msg.key, msg.value);
      } else if (msg.type === "pickContext") {
        const item = await pickContext(msg.kind, this.sessions.projectPath());
        if (item) this.post({ type: "context", id: t.id, item });
      } else if (msg.type === "stop" && t.key) {
        await this.sessions.stop(t.key);
      } else if (msg.type === "approve" && t.key) {
        await this.sessions.approve(t.key, msg.requestId, msg.action);
      } else if (msg.type === "dashboard" && t.key) {
        vscode.env.openExternal(vscode.Uri.parse(ORIGIN + "/chat/" + encodeURIComponent(t.key)));
      } else if (msg.type === "answer" && t.key) {
        await this.answer(t.key, msg.card, msg.answers || {}, Boolean(msg.dismissed));
      } else if (msg.type === "open") {
        await openPathLink(msg.path, msg.line, msg.column);
      } else if (msg.type === "link" && msg.url) {
        await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
      } else if (msg.type === "copy") {
        await vscode.env.clipboard.writeText(String(msg.text || ""));
      }
    } catch (error) {
      this.post({ type: "error", id: msg.id != null ? msg.id : this.active, text: error.message || String(error) });
    }
  }
  /**
   * Send from a tab: create the session on first use and apply the tab's
   * picks to it; upload attachments (their server paths go into the message —
   * an image path becomes a real image block on the host); inject `#`
   * contexts and the workflow frame as silent background context; then send.
   */
  async send(t, msg) {
    const s = t.settings;
    let text = String(msg.text || "");
    const files = Array.isArray(msg.files) ? msg.files : [];
    const contexts = Array.isArray(msg.contexts) ? msg.contexts : [];
    if (!text.trim() && !files.length && !contexts.length) return;
    // A Kiro Spec & Plan agent for this mode runs Kiro's real workflow; it
    // replaces both the agent pick and the frame — unless this host refuses the
    // mode ids (KiroCrew 0.8.0.9+ reserves KAS's bundled ids before the wire, see
    // RESERVED_MODE_AGENTS); then the prompt-guided workflow runs on the pick.
    const kasAgent = this.modeAgentsRefused ? null : kasAgentFor(s.mode, this.sessions.agents);
    const agent = kasAgent || s.agent;
    const fresh = !t.key;
    if (!t.key) {
      t.key = await this.sessions.create({ agent, kind: t.kind || "chat", title: t.pendingTitle });
      t.title = t.pendingTitle || (text || (files[0] && files[0].name) || "New chat").slice(0, 40);
      delete t.pendingTitle;
      this.saveTabs();
      this.pushTabs();
      this.post({ type: "session", id: t.id, key: t.key });
      // Apply the picks made while the tab was still a draft. A model the host
      // no longer offers is dropped rather than pinned (the turn would die with
      // InvalidModelError); the agent's own model runs instead.
      if (s.model) {
        const known = await this.sessions.models().catch(() => []);
        if (known.length && !known.some((m) => m.id === s.model)) {
          this.post({ type: "error", id: t.id, text: "model: " + s.model + " is no longer offered by this host; using the agent's model." });
          this.pruneRetiredModels(known);
        } else {
          await this.sessions.setModel(t.key, s.model).catch((e) => this.post({ type: "error", id: t.id, text: "model: " + e.message }));
        }
      }
      if (s.effort) await this.sessions.setEffort(t.key, s.effort).catch((e) => this.post({ type: "error", id: t.id, text: "effort: " + e.message }));
      if (s.autopilot) await this.sessions.setTrust(t.key, true).catch((e) => this.post({ type: "error", id: t.id, text: "autopilot: " + e.message }));
    }
    const attached = [];
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.data || ""), (c) => c.charCodeAt(0));
      const path = await this.sessions.upload(f.name || "attachment", bytes, f.mime);
      attached.push({ name: f.name, path, image: /^image\//.test(f.mime || "") });
    }
    // Steering, Kiro's way: `fileMatch` documents whose pattern matches a file in
    // this turn's context (a `#` file/open-files pick, the editors on screen)
    // and `manual`/`auto` documents the message names with `#name` ride along
    // as silent context; `always` documents load with the agent itself.
    const steered = await this.steeringForTurn(text, contexts, fresh, agent).catch((e) => { log("steering: " + e.message); return null; });
    if (steered) for (const c of steered.contexts) if (!contexts.some((x) => x.steering && x.steering.name === c.steering.name)) contexts.push(c);
    // Attachments travel exactly as the dashboard composer sends them: one
    // `[attached_file N] <path>` marker per file (the host inlines an image
    // path as a real image block and leaves other paths for the agent's
    // tools) plus `meta.files`, the list those markers index into.
    const typed = text.trim();
    if (attached.length) {
      text = [typed, ...attached.map((a, i) => "[attached_file " + (i + 1) + "] " + a.path)].filter(Boolean).join("\n");
    }
    for (const c of contexts) {
      if (c && c.content) await this.sessions.inject(t.key, "[" + c.label + "]\n" + c.content, "kirocrew-ide #" + (c.kind || "context")).catch((e) => this.post({ type: "error", id: t.id, text: "context: " + e.message }));
    }
    const frame = kasAgent ? "" : workflowContext(s.mode, this.sessions.projectPath());
    if (frame) await this.sessions.inject(t.key, frame, "kirocrew-ide workflow").catch((e) => this.post({ type: "error", id: t.id, text: "workflow: " + e.message }));
    if (!text.trim()) text = attached.length ? "See the attached file(s)." : "See the context provided.";
    // A session's first turn says what steers it (Kiro's IDE shows the included steering as context).
    if (steered && steered.note) this.post({ type: "status", id: t.id, text: steered.note });
    // The transcript shows what was typed (the chips name the files); the markers are for the host.
    this.post({ type: "user", id: t.id, text: msg.display || typed || text, contexts: contexts.map((c) => c.label), files: attached.map((a) => a.name) });
    const meta = attached.length ? { files: attached.map((a) => a.path) } : undefined;
    // The host accepts the turn (`/chat?ws=1` answers 200 at once) and runs it
    // asynchronously, so a refusal of Kiro's mode agent usually arrives later
    // as a streamed error row (onFrame), not as a rejected send. Remember what
    // this turn was so either path can re-send it on the fallback agent.
    t.pendingTurn = kasAgent ? { text, meta, kasAgent } : null;
    try {
      await this.sessions.send(t.key, text, agent, meta);
    } catch (error) {
      if (kasAgent && isReservedModeRefusal(error.message)) { await this.fallBackFromModeAgent(t); return; }
      throw error;
    }
  }
  /**
   * The host will not run a session on Kiro's bundled mode id (KiroCrew
   * 0.8.0.9+ reserves them). Remember that for this window, retarget the tab's
   * slot to the user's pick with the prompt-guided frame, and send the
   * remembered turn once more. Idempotent per turn: the second trigger (a
   * rejected send AND its error row, or two error rows) finds nothing pending.
   */
  async fallBackFromModeAgent(t) {
    const pending = t.pendingTurn;
    if (!pending) return false;
    t.pendingTurn = null;
    const s = t.settings;
    this.modeAgentsRefused = true;
    log("host refuses the Kiro mode agent " + pending.kasAgent + "; falling back to the prompt-guided workflow");
    this.post({ type: "error", id: t.id, text: "This KiroCrew refuses Kiro's mode agent \"" + pending.kasAgent + "\" (it reserves the bundled mode ids). Running the " + s.mode + " workflow as a prompt-guided frame on " + (s.agent || "the crew default") + " instead; update kiro-spec-plan when a fixed version exists." });
    await this.sessions.setSlotAgent(t.key, s.agent || "").catch(() => undefined);
    const frame = workflowContext(s.mode, this.sessions.projectPath());
    if (frame) await this.sessions.inject(t.key, frame, "kirocrew-ide workflow").catch(() => undefined);
    // The receipt already posted named the refused mode agent; say what steers the agent that runs.
    try {
      const docs = await listSteering(this.sessions.projectPath());
      const note = docs.length ? await this.steeringNote(docs, s.agent) : null;
      if (note) this.post({ type: "status", id: t.id, text: note });
    } catch (e) { log("steering (fallback): " + e.message); }
    await this.sessions.send(t.key, pending.text, s.agent, pending.meta);
    return true;
  }
  /**
   * The steering of one turn: { contexts, note }. `contexts` are the fileMatch
   * hits and `#name` mentions to inject (not the always-included files: the
   * agent loads those); `note` is the one-line "steered by" receipt for a
   * session's first turn (null afterwards), naming the always files per tier
   * and warning when the chosen agent's own `resources` leave steering out.
   */
  async steeringForTurn(text, contexts, firstTurn, agentName) {
    const root = this.sessions.projectPath();
    const docs = await listSteering(root);
    if (!docs.length) return null;
    const inContext = new Set();
    for (const c of contexts) for (const p of (c && c.paths) || []) inContext.add(p);
    for (const ed of vscode.window.visibleTextEditors || []) if (ed.document && ed.document.uri.scheme !== "output" && !ed.document.isUntitled) inContext.add(ed.document.uri.path);
    const paths = [...inContext];
    const out = [];
    for (const d of docs) if (d.inclusion === "fileMatch" && steeringMatches(d, paths, root)) out.push(await steeringContext(d, "fileMatch"));
    for (const d of steeringMentions(text, docs)) if (d.inclusion !== "always" && !out.some((c) => c.steering.name === d.name)) out.push(await steeringContext(d, "mention"));
    let note = null;
    if (firstTurn) note = await this.steeringNote(docs, agentName);
    return { contexts: out, note };
  }
  /**
   * The one-line "steered by" receipt for `agentName`: the always-included
   * files per tier (they load with the agent — on KAS for every agent, on the
   * legacy engine only through the agent's `resources`), then the rest with
   * their modes. Names the agent, since a Spec tab can change agent on the host's
   * mode-id refusal (fallBackFromModeAgent re-posts it for the fallback agent).
   */
  async steeringNote(docs, agentName) {
    const backend = await readAcpBackend();
    const loads = agentLoadsSteering(await readAgentDoc(agentName), backend);
    const who = agentName || "the crew default agent";
    const always = docs.filter((d) => d.inclusion === "always");
    const tier = (scope) => always.filter((d) => d.scope === scope).map((d) => d.label).join(", ");
    const parts = [];
    if (tier("workspace")) parts.push("workspace " + tier("workspace"));
    if (tier("global")) parts.push("global " + tier("global"));
    let note = null;
    if (loads === false) note = "Steering: agent " + who + " does not load .kiro/steering (its resources leave it out" + (backend === "legacy" ? ", legacy engine" : "") + ")" + (always.length ? " — " + always.length + " always-included file(s) are NOT in this session" : "");
    else if (parts.length) note = "Steered by " + parts.join("; ") + " (always, loaded with agent " + who + (backend === "kas" ? " on KAS" : "") + ")";
    const rest = docs.filter((d) => d.inclusion !== "always");
    if (rest.length) note = (note ? note + ". " : "Steering: ") + rest.map((d) => d.label + " is " + steeringModeLabel(d)).join(", ");
    return note;
  }
  /**
   * Start a workflow from outside the composer (the spec editor's Continue, the
   * Specs view): a fresh tab with the given mode (and agent when forced),
   * everything else inherited from the current picks, then the same send path
   * a typed message takes — so the workflow frame is injected and the tab's
   * bar shows the mode. `text` may be a function of the Kiro agent that will
   * run the turn (null on the crew agent), so a task run can send Kiro's own
   * engine request to Kiro's Spec agent and a paraphrase otherwise. `display`
   * is what the transcript shows for the turn (Kiro shows "Execute Task: …"
   * while sending the engine its longer request); `autopilot` approves every
   * tool of the session, as Kiro's IDE does for task runs. Neither is
   * inherited by the next tab. Returns the session key.
   */
  async dispatch(text, { mode, agent, title, kind, display, autopilot } = {}) {
    const t = this.newTab(true);
    if (mode) t.settings.mode = mode;
    if (agent) t.settings.agent = agent;
    if (autopilot) t.settings.autopilot = true;
    t.kind = kind || "spec";
    t.pendingTitle = title;
    this.pushTabs();
    const body = typeof text === "function" ? text(kasAgentFor(t.settings.mode, this.sessions.agents)) : text;
    await this.send(t, { text: body, display });
    return t.key;
  }
  /** A composer pick changed: remember it on the tab (and as the default for new tabs), apply it live when the session exists. */
  async setSetting(t, key, value) {
    if (!["agent", "model", "effort", "mode", "autopilot", "pick"].includes(key)) return;
    if (key === "pick") {
      // One picker, Kiro-style: a Kiro-mode agent IS the mode; a prompt workflow is a mode on the crew default; else a plain agent.
      const pick = String(value || "");
      const [kind, ...rest] = pick.split(":");
      const name = rest.join(":");
      if (kind === "workflow") { t.settings.mode = name || "default"; t.settings.agent = t.settings.baseAgent || ""; }
      else { t.settings.agent = kind === "agent" ? name : ""; t.settings.baseAgent = t.settings.agent; t.settings.mode = modeOfAgent(t.settings.agent) || "default"; }
      this.lastSettings = Object.assign({}, t.settings);
      this.saveTabs();
      if (t.key) await this.sessions.setSlotAgent(t.key, t.settings.agent).catch(() => undefined);
      this.pushTabs();
      return;
    }
    t.settings[key] = key === "autopilot" ? Boolean(value) : String(value || (key === "mode" ? "default" : ""));
    this.lastSettings = Object.assign({}, t.settings);
    this.saveTabs();
    if (t.key) {
      if (key === "model") await this.sessions.setModel(t.key, t.settings.model);
      else if (key === "effort") await this.sessions.setEffort(t.key, t.settings.effort);
      else if (key === "autopilot") await this.sessions.setTrust(t.key, t.settings.autopilot);
      else if (key === "agent") await this.sessions.setSlotAgent(t.key, t.settings.agent).catch(() => undefined);
      else if (key === "mode") {
        // On a live session a Kiro mode is an agent switch (the host re-activates the slot's agent).
        const kasAgent = kasAgentFor(t.settings.mode, this.sessions.agents);
        if (kasAgent) await this.sessions.setSlotAgent(t.key, kasAgent).catch(() => undefined);
      }
    }
    this.pushTabs();
  }
  setAgent(agent) {
    this.agent = agent || "";
    const t = this.tab(this.active);
    if (t) this.setSetting(t, "agent", this.agent).catch(() => undefined);
  }
  /** Answer a question card: blocking cards (ask_id) through the ask-question route, follow-up cards (card_id) as a plain message. */
  async answer(key, card, answers, dismissed) {
    if (card.ask_id) {
      if (dismissed) return api("/ask-question/dismiss", { method: "POST", json: { slot: key, ask_id: card.ask_id } }).catch(() => undefined);
      return api("/ask-question/" + encodeURIComponent(card.ask_id) + "/answer", { method: "POST", json: { answers } });
    }
    if (dismissed) return api("/ask-question/dismiss", { method: "POST", json: { slot: key, card_id: card.card_id, dismissed: true } }).catch(() => undefined);
    const text = Object.values(answers).filter(Boolean).join("\n");
    if (!text) return undefined;
    const t = this.tabForKey(key);
    if (t) this.post({ type: "user", id: t.id, text });
    return this.sessions.send(key, text, (t && t.settings.agent) || this.agent);
  }
  onFrame(frame) {
    if (!frame.data || !frame.data.slot) return;
    const t = this.tabForKey(frame.data.slot);
    if (!t) return;
    const id = t.id;
    switch (frame.type) {
      case "question_card": this.post({ type: "question", id, card: frame.data }); break;
      case "question_card_resolved": this.post({ type: "questionResolved", id, qid: frame.data.ask_id || frame.data.card_id }); break;
      case "chat_chunk": this.post({ type: "chunk", id, text: frame.data.content || "", seq: frame.data.seq }); break;
      case "chat_segment": this.post({ type: "segment", id }); break;
      case "chat_thinking": this.post({ type: "thinking", id, text: frame.data.content || frame.data.text || "" }); break;
      case "chat_status": this.post({ type: "status", id, text: frame.data.status || frame.data.text || "" }); break;
      case "chat_message": {
        const row = normalizeRow(frame.data);
        // The refusal of a Kiro mode agent lands here as the turn's error row
        // (the send itself was accepted); the fallback re-sends on the pick.
        if (t.pendingTurn && isErrorRow(row) && isReservedModeRefusal(row.content)) {
          this.fallBackFromModeAgent(t).catch((e) => this.post({ type: "error", id, text: "fallback: " + e.message }));
          break;
        }
        this.post({ type: "row", id, row });
        break;
      }
      case "chat_done": this.post({ type: "done", id }); break;
      // The tool row itself arrives as a chat_message; its result and any
      // refined title/arguments come as separate frames keyed by tool_call_id.
      case "tool_result": this.post({ type: "toolResult", id, tcid: frame.data.tool_call_id || "", output: frame.data.output }); break;
      case "tool_call":
        if (frame.data.is_update && frame.data.tool_call_id) this.post({ type: "toolUpdate", id, tcid: frame.data.tool_call_id, title: frame.data.tool || "", purpose: frame.data.purpose, input: frame.data.input_preview });
        break;
      default: break;
    }
  }
}

/**
 * Extensions view → "Install from Marketplace link": the engine's store is Open
 * VSX, so an extension that exists only on the Microsoft Marketplace is fetched
 * by the mod's hook (its VSIX, from the item's publisher.name) and installed with
 * the engine's CLI; the window then needs one reload to activate it. The hook
 * accepts an item link or `publisher.name`, one install at a time, and reports
 * progress on GET extensions/install.
 */
async function installFromMarketplace(prefill) {
  const route = "/apps/floofycrew/mods/" + IDE_TAG + "/api/extensions/install";
  const ref = await vscode.window.showInputBox({
    title: "Install an extension from the Microsoft Marketplace",
    prompt: "Paste the Marketplace item link (…/items?itemName=publisher.name) or type publisher.name. The store built into this IDE is Open VSX; this fetches the VSIX from the Marketplace instead.",
    placeHolder: "https://marketplace.visualstudio.com/items?itemName=publisher.name",
    value: typeof prefill === "string" ? prefill : "",
    ignoreFocusOut: true,
    validateInput: (v) => (/marketplace\.visualstudio\.com\/items\?.*itemName=[\w-]+\.[\w-]+/i.test(v) || /^[\w-]+\.[\w-]+$/.test(v.trim()) ? null : "an item link with itemName=publisher.name, or publisher.name"),
  });
  if (!ref) return;
  let started;
  try { started = await api(route, { method: "POST", json: { ref: ref.trim() } }); }
  catch (e) { return vscode.window.showErrorMessage("Marketplace install: " + e.message); }
  const record = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Installing " + ((started.install && started.install.id) || ref.trim()), cancellable: false }, async (progress) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const poll = await api(route).catch(() => null);
      const rec = poll && poll.install;
      if (!rec) return { state: "error", error: "the install status is unavailable" };
      if (rec.state === "resolving") progress.report({ message: "looking it up on the Marketplace…" });
      else if (rec.state === "downloading") progress.report({ message: "downloading " + (rec.display || rec.id) + " " + (rec.version || "") });
      else if (rec.state === "installing") progress.report({ message: "installing " + (rec.display || rec.id) + " " + (rec.version || "") });
      else return rec;
    }
  });
  if (record.state === "done") {
    const pick = await vscode.window.showInformationMessage("Installed " + (record.display || record.id) + " " + (record.version || "") + ". Reload the window to activate it.", "Reload Window", "Later");
    if (pick === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } else {
    vscode.window.showErrorMessage("Marketplace install failed: " + (record.error || "unknown error"));
  }
}

/**
 * Resolve a path mentioned in chat to a workspace file and open it at line:col.
 * Accepts absolute paths, workspace-relative paths (`src/a.py`, `./a.py`) and
 * `path:line[:col]`. Relative paths are tried against every workspace folder.
 */
async function openPathLink(rawPath, line, column) {
  const folders = vscode.workspace.workspaceFolders || [];
  const candidates = [];
  const clean = String(rawPath || "").replace(/^\.\//, "");
  if (!clean) return;
  if (clean.startsWith("/")) {
    // absolute: map into a workspace folder's URI (remote fs) when inside one, else file scheme
    for (const folder of folders) {
      if (clean.startsWith(folder.uri.path + "/") || clean === folder.uri.path) {
        candidates.push(vscode.Uri.joinPath(folder.uri, clean.slice(folder.uri.path.length)));
      }
    }
    if (!candidates.length && folders.length) candidates.push(folders[0].uri.with({ path: clean }));
    if (!candidates.length) candidates.push(vscode.Uri.file(clean));
  } else {
    for (const folder of folders) candidates.push(vscode.Uri.joinPath(folder.uri, clean));
  }
  for (const uri of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        await vscode.commands.executeCommand("revealInExplorer", uri);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (typeof line === "number" && line > 0) {
        const pos = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), Math.max(0, (column || 1) - 1));
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return;
    } catch {
      /* try the next candidate */
    }
  }
  vscode.window.setStatusBarMessage("KiroCrew: " + clean + " is not in this workspace", 4000);
}

/**
 * Turn path-looking tokens in a text into [start, end, path, line, col] spans.
 * Conservative on purpose: needs a slash or a known extension, and a
 * line-number suffix is honoured. Exposed for tests.
 */
const PATH_RE = /(?<![\w@:/.-])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w-]+(?:\.[\w-]+)*|[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|toml|yaml|yml|sh|css|html|go|rs|java|kt|c|h|cpp|hpp|txt|ini|cfg|lock))(?::(\d+))?(?::(\d+))?(?![\w/])/g;
function findPathLinks(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(PATH_RE)) {
    const path = m[1];
    if (/^https?:|^\d+(\.\d+)+$/.test(path) || path.endsWith("/") || path.endsWith(".")) continue;
    if (/^[\d.]+$/.test(path.replace(/\//g, ""))) continue; // version-ish
    out.push({ start: m.index, end: m.index + m[0].length, path, line: m[2] ? Number(m[2]) : undefined, column: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

// ---------------------------------------------------------- # context

const CONTEXT_KINDS = [
  { kind: "open-files", label: "Currently Open Files", icon: "$(files)" },
  { kind: "diagnostics", label: "Diagnostics", icon: "$(warning)" },
  { kind: "git-diff", label: "Git Diff", icon: "$(git-compare)" },
  { kind: "file", label: "File", icon: "$(file)" },
  { kind: "folder", label: "Folder", icon: "$(folder)" },
  { kind: "spec", label: "Spec", icon: "$(book)" },
  { kind: "steering", label: "Steering", icon: "$(compass)" },
];
const HOST_CONTEXT_MAX = 40000; // the host's cap on one context entry (_MAX_CONTEXT_CONTENT)
const CONTEXT_BUDGET = 36000;   // chars per item, leaving room for the label line
const FILE_BUDGET = 12000;

// ------------------------------------------------- steering (Kiro's inclusion rules)
//
// Who loads steering for a chat started here: the agent runtime behind every
// KiroCrew session is kiro-cli, spawned with the session's project as its
// working directory (the IDE's open folder) and with the agent's `resources`,
// which by default include `file://.kiro/steering/**/*.md` and
// `file://~/.kiro/steering/**/*.md`. kiro-cli applies Kiro's inclusion rules
// itself: a file with no front matter or `inclusion: always` is in every turn;
// `inclusion: fileMatch` and `inclusion: manual` files are NOT loaded (checked
// on kiro-cli 2.33: a manual and a fileMatch file stayed out of the model's
// context even after the agent read a matching file with a tool). Kiro's IDE
// adds the other two modes on its side — fileMatch when a matching file is in
// the chat's context, manual when the message names the file with `#name` —
// so this bridge does the same, as silent context on the send, and shows which
// documents steer the turn. Reference: kiro.dev/docs/steering
const STEERING_INCLUSIONS = ["always", "fileMatch", "manual", "auto"];

/** Front matter + body of a steering file: { inclusion, patterns, description, body }. No front matter = always. */
function parseSteering(text) {
  const s = String(text || "").replace(/^\uFEFF/, "");
  const out = { inclusion: "always", patterns: [], description: "", body: s };
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  if (!m) return out;
  out.body = s.slice(m[0].length);
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
  }
  const inc = (fields.inclusion || "").replace(/^["']|["']$/g, "");
  out.inclusion = STEERING_INCLUSIONS.find((x) => x.toLowerCase() === inc.toLowerCase()) || (inc ? "manual" : "always");
  // fileMatchPattern: "a" | 'a' | a, b | ["a", "b"]
  const raw = fields.filematchpattern || "";
  let pats = [];
  if (/^\[/.test(raw)) { try { pats = JSON.parse(raw.replace(/'/g, '"')); } catch { pats = raw.slice(1, -1).split(","); } }
  else pats = raw.split(",");
  out.patterns = pats.map((p) => String(p).trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  if (out.inclusion === "fileMatch" && !out.patterns.length) out.inclusion = "manual"; // no pattern: never matches, only `#name` includes it
  out.description = (fields.description || "").replace(/^["']|["']$/g, "");
  return out;
}

/** A Kiro file-match glob as a RegExp over a slash path (`**`, `*`, `?`, `{a,b}`); matched against the relative path and the basename. */
function globToRegExp(glob) {
  let re = "";
  const g = String(glob).replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { i++; if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = g.indexOf("}", i); if (end < 0) { re += "\\{"; } else { re += "(?:" + g.slice(i + 1, end).split(",").map((a) => a.trim().replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")"; i = end; } }
    else if (/[.+^$()|[\]\\]/.test(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}

/** Whether a fileMatch steering document applies to any of `paths` (absolute or workspace-relative), under `root`. */
function steeringMatches(doc, paths, root) {
  if (doc.inclusion !== "fileMatch" || !doc.patterns.length) return false;
  const rel = (p) => { let s = String(p).replace(/\\/g, "/"); if (root && s.startsWith(root.replace(/\/+$/, "") + "/")) s = s.slice(root.replace(/\/+$/, "").length + 1); return s.replace(/^\.\//, ""); };
  const res = doc.patterns.map(globToRegExp);
  return paths.some((p) => { const r = rel(p); const base = r.split("/").pop(); return res.some((re) => re.test(r) || re.test(base)); });
}

/**
 * `#name` tokens in a typed message that name a steering file: the file name
 * without .md, or for a nested file its path under the steering dir
 * (`#amazon-builder/git`); a bare name also finds a nested file when exactly
 * one file of that name exists across both tiers.
 */
function steeringMentions(text, docs) {
  const names = new Map(docs.map((d) => [d.name.toLowerCase(), d]));
  const bases = new Map();
  for (const d of docs) { const b = d.name.toLowerCase().split("/").pop(); bases.set(b, bases.has(b) ? null : d); }
  const out = [];
  for (const m of String(text || "").matchAll(/(^|\s)#([\w./-]+)/g)) {
    const key = m[2].toLowerCase().replace(/\.md$/, "").replace(/^\.?\//, "");
    const d = names.get(key) || bases.get(key) || null;
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * Does this agent load the steering trees itself? Depends on the engine the
 * host runs sessions on (checked on kiro-cli 2.34 with a nested workspace tree):
 *  - KAS (`acp_backend: kas`, kiro-cli --v3): both tiers load for EVERY agent,
 *    inclusion rules applied — a workspace agent with no `resources` key and
 *    one whose `resources` omit steering both saw them; Kiro's built-in Spec
 *    mode (`--agent spec`) too. So the answer is yes regardless of the doc.
 *  - legacy engine: steering comes only through the agent's `resources`; an
 *    agent with no `resources` key loads none (a probe agent saw nothing).
 * null = unknown (treated as yes, no warning).
 */
function agentLoadsSteering(agentDoc, backend) {
  if (backend === "kas") return true;
  if (!agentDoc || typeof agentDoc !== "object") return null;
  if (!Array.isArray(agentDoc.resources)) return backend === "legacy" ? false : null;
  return agentDoc.resources.some((r) => /steering/.test(String(r)));
}

/** The host's agent engine from ~/.kiro/crew/config.json: "kas", "legacy", or null when unknown. */
async function readAcpBackend() {
  const home = homeUri();
  if (!home) return null;
  try {
    const cfg = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(home, ".kiro", "crew", "config.json"))));
    const b = String(cfg.acp_backend || "").trim().toLowerCase();
    return b ? (b === "kas" ? "kas" : "legacy") : null;
  } catch { return null; }
}

/** How deep listSteering follows subdirectories of a steering tree (kiro-cli's `**` is unbounded; this only guards against a pathological tree). */
const STEERING_MAX_DEPTH = 8;

/**
 * Every steering file of both tiers, parsed: { name, label, scope, uri, path,
 * inclusion, patterns, description }. Subdirectories are walked the way the
 * agent's `file://…/.kiro/steering/**\/*.md` resource does (checked on
 * kiro-cli 2.34: `steering/a/b/c.md` loads like `steering/c.md`), so a file in
 * `steering/amazon-builder/git.md` is named `amazon-builder/git` and labelled by
 * that relative path; `#name` accepts the path or, when unique, the bare name.
 */
async function listSteering(root) {
  const out = [];
  const scan = async (base, scope, rel, depth) => {
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(base); } catch { return; }
    for (const [name, kind] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      if (name.startsWith(".")) continue;
      const uri = vscode.Uri.joinPath(base, name);
      if (kind === vscode.FileType.Directory) { if (depth < STEERING_MAX_DEPTH) await scan(uri, scope, rel + name + "/", depth + 1); continue; }
      if (kind !== vscode.FileType.File || !/\.md$/i.test(name)) continue;
      let text = "";
      try { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { continue; }
      const doc = parseSteering(text);
      out.push({ name: rel + name.replace(/\.md$/i, ""), label: rel + name, scope, uri, path: uri.path, inclusion: doc.inclusion, patterns: doc.patterns, description: doc.description, size: doc.body.length });
    }
  };
  for (const folder of vscode.workspace.workspaceFolders || []) await scan(vscode.Uri.joinPath(folder.uri, ".kiro", "steering"), "workspace", "", 0);
  const home = homeUri();
  if (home) await scan(vscode.Uri.joinPath(home, ".kiro", "steering"), "global", "", 0);
  void root;
  return out;
}

// "always", "fileMatch (<pattern>)", "manual (#name)", "auto".
function steeringModeLabel(d) {
  if (d.inclusion === "fileMatch") return "fileMatch (" + d.patterns.join(", ") + ")";
  if (d.inclusion === "manual") return "manual (#" + d.name + ")";
  return d.inclusion;
}

/** A steering document as a composer context item (what `#` → Steering, a `#name` mention and a fileMatch hit all produce). */
async function steeringContext(d, why) {
  const content = "--- " + d.scope + " steering " + d.label + " (" + steeringModeLabel(d) + ") ---\n" + (await readText(d.uri, CONTEXT_BUDGET));
  return { kind: "steering", label: "steering: " + d.name, content, steering: { name: d.name, scope: d.scope, inclusion: d.inclusion, why: why || "picked" } };
}

/** The agent's definition from ~/.kiro/agents/<name>.json, or null when unknown. */
async function readAgentDoc(name) {
  const home = homeUri();
  if (!home || !name) return null;
  try { return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(home, ".kiro", "agents", name + ".json")))); } catch { return null; }
}

/** Clip text to a budget with an explicit marker (never silently). */
function clip(text, budget) {
  const s = String(text || "");
  return s.length > budget ? s.slice(0, budget) + "\n… (truncated, " + (s.length - budget) + " more chars)" : s;
}

async function readText(uri, budget) {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return clip(new TextDecoder().decode(bytes), budget || FILE_BUDGET);
}

/**
 * One `#` context item, chosen with the workbench's own pickers: returns
 * { kind, label, content } for the composer chip, or null when cancelled. The
 * content travels as silent background context on the next send.
 */
async function pickContext(kind, root) {
  const folders = vscode.workspace.workspaceFolders || [];
  const rel = (p) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  if (kind === "open-files") {
    const seen = new Set();
    const parts = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tab.input && tab.input.uri;
        if (!uri || seen.has(uri.toString())) continue;
        seen.add(uri.toString());
        try { parts.push("--- " + rel(uri.path) + " ---\n" + (await readText(uri, Math.floor(CONTEXT_BUDGET / Math.max(1, group.tabs.length))))); } catch { /* not a text file */ }
      }
    }
    if (!parts.length) { vscode.window.setStatusBarMessage("KiroCrew: no open files", 3000); return null; }
    return { kind, label: "Open files (" + parts.length + ")", content: clip(parts.join("\n\n"), CONTEXT_BUDGET), paths: [...seen].map((u) => vscode.Uri.parse(u).path) };
  }
  if (kind === "diagnostics") {
    const sev = ["error", "warning", "info", "hint"];
    const lines = [];
    for (const [uri, list] of vscode.languages.getDiagnostics()) {
      for (const d of list) lines.push(rel(uri.path) + ":" + (d.range.start.line + 1) + ":" + (d.range.start.character + 1) + " " + sev[d.severity] + ": " + d.message.replace(/\s+/g, " "));
    }
    if (!lines.length) { vscode.window.setStatusBarMessage("KiroCrew: no diagnostics", 3000); return null; }
    return { kind, label: "Diagnostics (" + lines.length + ")", content: clip(lines.join("\n"), CONTEXT_BUDGET) };
  }
  if (kind === "git-diff") {
    if (!root) throw new Error("open a folder first");
    const doc = await api("/apps/floofycrew/mods/" + IDE_TAG + "/api/gitdiff?path=" + encodeURIComponent(root));
    return { kind, label: "Git diff" + (doc.truncated ? " (truncated)" : ""), content: doc.text || "(clean working tree)" };
  }
  if (kind === "file") {
    const files = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/build/**,**/dist/**,**/__pycache__/**}", 4000);
    const picked = await vscode.window.showQuickPick(files.map((u) => ({ label: rel(u.path), uri: u })).sort((a, b) => a.label.localeCompare(b.label)), { placeHolder: "File to add as context", matchOnDescription: true });
    if (!picked) return null;
    return { kind, label: rel(picked.uri.path), content: "--- " + rel(picked.uri.path) + " ---\n" + (await readText(picked.uri, CONTEXT_BUDGET)), paths: [picked.uri.path] };
  }
  if (kind === "folder") {
    const files = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/build/**,**/dist/**,**/__pycache__/**}", 6000);
    const dirs = new Set([""]);
    for (const u of files) { const parts = rel(u.path).split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
    const picked = await vscode.window.showQuickPick([...dirs].sort().map((d) => ({ label: d || "(workspace root)", dir: d })), { placeHolder: "Folder to add as context (its file list)" });
    if (!picked) return null;
    const inside = files.map((u) => rel(u.path)).filter((p) => !picked.dir || p.startsWith(picked.dir + "/")).sort();
    return { kind, label: (picked.dir || "workspace") + "/ (" + inside.length + " files)", content: "Files under " + (picked.dir || "the workspace root") + ":\n" + clip(inside.join("\n"), CONTEXT_BUDGET) };
  }
  if (kind === "spec") {
    const specs = await listSpecs();
    if (!specs.length) { vscode.window.setStatusBarMessage("KiroCrew: no specs in this workspace", 3000); return null; }
    const picked = specs.length === 1 ? { spec: specs[0] } : await vscode.window.showQuickPick(specs.map((s) => ({ label: s.name, spec: s })), { placeHolder: "Spec to add as context" });
    if (!picked) return null;
    const parts = [];
    for (const stage of ["requirements", "design", "tasks"]) {
      const uri = vscode.Uri.joinPath(picked.spec.dir, stage + ".md");
      try { parts.push("--- .kiro/specs/" + picked.spec.name + "/" + stage + ".md ---\n" + (await readText(uri, Math.floor(CONTEXT_BUDGET / 3)))); } catch { /* stage not written yet */ }
    }
    return { kind, label: "spec: " + picked.spec.name, content: parts.join("\n\n") || "(empty spec)" };
  }
  if (kind === "steering") {
    const docs = await listSteering(root);
    if (!docs.length) { vscode.window.setStatusBarMessage("KiroCrew: no steering files", 3000); return null; }
    const items = docs.map((d) => ({ label: "$(" + (d.inclusion === "always" ? "check" : d.inclusion === "fileMatch" ? "filter" : "hand") + ") " + d.label, description: d.scope + " · " + steeringModeLabel(d), detail: d.description || undefined, doc: d }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Steering file to include in the next message (always-included files already load with the agent)", matchOnDescription: true });
    if (!picked) return null;
    return steeringContext(picked.doc);
  }
  throw new Error("unknown context kind " + kind);
}

/** Pure: the crew roster first (its order is most-used), then installed agents it does not already name. */
function mergeRosters(crew, installed) {
  const list = (doc) => (Array.isArray(doc) ? doc : (doc && (doc.agents || doc.items)) || []).map((a) => (typeof a === "string" ? { name: a } : a)).filter((a) => a && a.name);
  const out = list(crew).map((a) => Object.assign({ source: "crew" }, a));
  const seen = new Set(out.map((a) => a.name));
  for (const a of list(installed)) {
    if (seen.has(a.name) || /^kirocrew(-lite|-skill-view-)/.test(a.name)) continue;
    seen.add(a.name);
    out.push(Object.assign({ source: "installed" }, a));
  }
  return out;
}

function normalizeRow(row) {
  let meta = row.meta || {};
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  return { role: row.role, content: typeof row.content === "string" ? row.content : JSON.stringify(row.content), ts: row.ts || "", cls: row.cls || "", meta };
}

function chatHtml(foxUri) {
  // Webview: a tab strip, one transcript pane per tab, a shared composer for
  // the active tab with the pick bar under the text box (context, attach,
  // agent, model, effort, workflow mode, Autopilot). Paths in assistant/tool
  // text become links (same regex as findPathLinks); question cards and
  // `[OPTIONS: …]` lines render as buttons. No browser pop-ups anywhere: the
  // menus are in-page popovers (window.confirm & co. do nothing in the desktop app).
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
 :root{color-scheme:light dark;--kide-msg-size:inherit}
 body{margin:0;padding:0;font:13px/1.45 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;flex-direction:column;height:100vh}
 #tabs{display:flex;align-items:stretch;overflow-x:auto;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editorGroupHeader-tabsBackground,transparent);min-height:30px;scrollbar-width:none}
 .tab{display:flex;align-items:center;gap:5px;padding:0 6px 0 8px;font-size:12px;white-space:nowrap;cursor:pointer;border-right:1px solid var(--vscode-tab-border,transparent);color:var(--vscode-tab-inactiveForeground);background:var(--vscode-tab-inactiveBackground,transparent);max-width:180px}
 .tab.on{color:var(--vscode-tab-activeForeground);background:var(--vscode-tab-activeBackground,var(--vscode-sideBar-background));box-shadow:inset 0 -1px 0 var(--vscode-tab-activeBorder,var(--vscode-focusBorder))}
 .tab .t{overflow:hidden;text-overflow:ellipsis}
 .tab .x{opacity:.5;border:0;background:transparent;color:inherit;cursor:pointer;padding:0 2px;font-size:13px;line-height:1}.tab .x:hover{opacity:1}
 .tab .dot{width:7px;height:7px;border-radius:50%;flex:none}.dot.run{background:var(--vscode-progressBar-background)}.dot.wait{background:var(--vscode-editorWarning-foreground)}
 #tabs .add{padding:0 10px;border:0;background:transparent;color:inherit;cursor:pointer;font-size:15px;opacity:.7}#tabs .add:hover{opacity:1}
 #panes{flex:1;position:relative;min-height:0}
 .log{position:absolute;inset:0;overflow:auto;display:none;font-size:var(--kide-msg-size)}
 .empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;opacity:.45;pointer-events:none}
 .empty img{width:72px;height:72px;filter:grayscale(1);opacity:.6}
 .empty div{padding:0 24px;text-align:center;max-width:320px}
 /* Message rows follow KiroCrew's own transcript: the user's turn is a bubble
    on the right (its card colour, small radius), the assistant's is bare text
    on the surface, tool/status lines are a quiet mono row with a hairline. */
 .log.on{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:8px 8px 4px}
 .log>*{flex:none}
 .row{margin:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;line-height:1.55;min-width:0}
 .user{align-self:flex-end;width:fit-content;max-width:92%;background:var(--vscode-input-background);color:var(--vscode-input-foreground,inherit);border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent));padding:6px 10px;border-radius:6px}
 .user .ctx{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px}
 /* The pinned prompt (KiroCrew's pinned-prompt): while the transcript is
    scrolled past a user turn, that turn stays at the top right as a one-line
    card in the bubble's own colours (three lines on hover, the whole prompt on
    ⌄); clicking it scrolls back to where the turn starts. The wrapper lets the
    transcript take every click around the card. */
 .pin{position:absolute;top:0;left:8px;right:8px;z-index:3;display:flex;justify-content:flex-end;padding:4px 0 0;pointer-events:none;font-size:var(--kide-msg-size)}
 .pin[hidden]{display:none}
 .pin-card{pointer-events:auto;display:flex;align-items:flex-start;gap:4px;max-width:92%;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground,inherit);border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent));border-radius:6px;padding:4px 6px 4px 10px;box-shadow:0 2px 8px rgba(0,0,0,.22);will-change:transform;transition:transform .08s linear}
 .pin-text{flex:1;min-width:0;margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;line-height:1.55;text-align:left;cursor:pointer;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;white-space:normal;word-break:break-word;overflow-wrap:anywhere}
 .pin-card:hover .pin-text,.pin-card:focus-within .pin-text{-webkit-line-clamp:3}
 .pin.open .pin-text{display:block;-webkit-line-clamp:unset;max-height:40vh;overflow:auto;white-space:pre-wrap}
 .pin-more{display:none;flex:none;margin:0;padding:0 3px;border:0;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:14px;line-height:1.55;transition:transform .2s}
 .pin.more .pin-more{display:inline-block}.pin-more:hover{opacity:1}.pin.open .pin-more{transform:rotate(180deg)}
 .pin-text:focus-visible,.pin-more:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
 @media (prefers-reduced-motion:reduce){.pin-card{transition:none}}
 .assistant,.streaming{padding:0 2px}
 .tool,.status,.thinking{color:var(--vscode-descriptionForeground);font-size:12px;font-family:var(--vscode-editor-font-family);padding:3px 8px;border-radius:4px;background:var(--vscode-editorWidget-background,transparent);box-shadow:inset 0 0 0 1px var(--vscode-widget-border,var(--vscode-panel-border))}
 .status{background:transparent;box-shadow:none;padding:0 2px}
 /* A tool call row: the header toggles a body with the call's Input and Output
    (the dashboard's tool card). \`.tool .tool-head\` outranks \`.row button\`. */
 .tool.call{padding:0;white-space:normal}
 .tool .tool-head{display:flex;align-items:center;gap:6px;width:100%;min-width:0;margin:0;padding:3px 8px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
 .tool .tool-head:hover{color:var(--vscode-foreground)}
 .tool-ico{flex:none}
 .tool-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .tool.call[data-open="true"] .tool-title{white-space:pre-wrap;word-break:break-word}
 .tool-live{display:none;width:6px;height:6px;border-radius:50%;background:var(--vscode-progressBar-background,var(--vscode-focusBorder,#7c5cff));flex:none}
 .tool.live .tool-live{display:inline-block;animation:kide-pulse 1.2s ease-in-out infinite}
 .tool-chev{flex:none;opacity:.6;font-size:13px;line-height:1;transition:transform .2s}
 .tool.call[data-open="true"] .tool-chev{transform:rotate(90deg)}
 .tool-body{display:flex;flex-direction:column;gap:6px;padding:0 8px 7px 24px}
 .tool-body[hidden]{display:none}
 .tool-k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;opacity:.7;margin-bottom:2px}
 .tool-pre{margin:0;padding:6px 8px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family);font-size:11px;line-height:1.45;color:var(--vscode-foreground);background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px}
 .tool-pre.muted{opacity:.6;font-style:italic}
 .think{white-space:normal}
 .think .think-head{display:flex;align-items:center;gap:6px;width:100%;min-width:0;margin:0;padding:1px 0;border:0;border-radius:0;background:transparent;color:var(--vscode-descriptionForeground);font:inherit;font-size:12px;cursor:pointer;text-align:left}
 .think .think-head:hover{color:var(--vscode-foreground)}
 .think-dot{width:7px;height:7px;border-radius:50%;background:var(--vscode-focusBorder,#7c5cff);flex:none}
 .think.live .think-dot{animation:kide-pulse 1.2s ease-in-out infinite}
 @keyframes kide-pulse{0%,100%{opacity:1}50%{opacity:.3}}
 .think-label{flex:none}
 .think-chev{display:inline-block;flex:none;opacity:.7;font-size:13px;line-height:1;transition:transform .2s}.think[data-open="true"] .think-chev{transform:rotate(90deg)}
 .think-live{display:none;flex:1;min-width:0;overflow:hidden;white-space:nowrap;opacity:.7;font-family:var(--vscode-editor-font-family)}
 .think.live[data-open="false"] .think-live{display:block}
 .think-live[data-clipped="true"]{-webkit-mask-image:linear-gradient(to right,transparent 0,#000 36px);mask-image:linear-gradient(to right,transparent 0,#000 36px)}
 .think-body{margin:2px 0 4px;padding:2px 0 2px 8px;border-left:2px solid var(--vscode-focusBorder,#7c5cff);max-height:360px;overflow:auto;font-size:12px;opacity:.75;white-space:pre-wrap;word-break:break-word;font-family:var(--vscode-editor-font-family)}
 /* Working: four foxes hopping in turn while the agent runs and no answer text
    is streaming yet (KiroCrew shows its ghosts here). Reduced motion: a soft pulse. */
 .work{display:none;align-items:center;gap:6px;padding:2px 4px;color:var(--vscode-descriptionForeground);font-size:12px}
 .work.on{display:flex}
 .work img{width:16px;height:16px;animation:kide-hop 1.1s ease-in-out infinite}
 .work img:nth-child(2){animation-delay:.14s}.work img:nth-child(3){animation-delay:.28s}.work img:nth-child(4){animation-delay:.42s}
 .work .fallback{display:none;width:7px;height:7px;border-radius:50%;background:currentColor;animation:kide-hop 1.1s ease-in-out infinite}
 .work.nofox img{display:none}.work.nofox .fallback{display:inline-block}
 .work .fallback:nth-child(2){animation-delay:.14s}.work .fallback:nth-child(3){animation-delay:.28s}.work .fallback:nth-child(4){animation-delay:.42s}
 @keyframes kide-hop{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
 @media (prefers-reduced-motion:reduce){.work img,.work .fallback{animation:kide-pulse 1.4s ease-in-out infinite}}
 .permission,.question{background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);padding:6px 10px;border-radius:6px}
 .question{background:var(--vscode-editorWidget-background);border-color:var(--vscode-focusBorder)}
 .question .q{font-weight:600;margin:4px 0}
 .question .d{opacity:.7;font-size:12px;margin-bottom:4px}
 .question input{width:100%;box-sizing:border-box;margin:4px 0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:4px 6px;font:inherit}
 .row button{margin:4px 6px 0 0;border:0;border-radius:3px;padding:2px 9px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
 .row button.reject,.row button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 .row button.opt{display:block;text-align:left;margin:4px 0 0;width:100%;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 .row button.opt.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
 .row button.opt small{display:block;opacity:.7;font-weight:400}
 .options{display:flex;flex-wrap:wrap;gap:5px;margin:-4px 0 0}
 .options button{margin:0;border:1px solid var(--vscode-button-border,var(--vscode-widget-border,var(--vscode-panel-border)));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;max-width:100%;white-space:normal;text-align:left}
 .options button:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-secondaryBackground))}
 /* Errors: a red/pink box, like the dashboard's danger cards — ours (.error) and the
    host's failure rows (cls "msg-err", or a ❌/⏱-prefixed assistant row). */
 .error,.row.err{color:var(--vscode-errorForeground,#e5484d);background:color-mix(in srgb,var(--vscode-errorForeground,#e5484d) 10%,transparent);border:1px solid color-mix(in srgb,var(--vscode-errorForeground,#e5484d) 40%,transparent);border-radius:6px;padding:6px 10px;white-space:pre-wrap}
 .row.err .md a,.error a{color:inherit}
 a.path,a.link{color:var(--vscode-textLink-foreground);text-decoration:none;cursor:pointer}a.path:hover,a.link:hover{text-decoration:underline}
 .assistant{white-space:normal}
 .md p{margin:0 0 6px}.md p:last-child{margin-bottom:0}
 .md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:8px 0 4px;line-height:1.3;font-weight:600}.md h1{font-size:1.3em}.md h2{font-size:1.18em}.md h3{font-size:1.08em}.md h4,.md h5,.md h6{font-size:1em}
 .md ul,.md ol{margin:2px 0 6px;padding-left:20px}.md li{margin:1px 0}.md li>ul,.md li>ol{margin:1px 0}
 .md code{background:var(--vscode-textCodeBlock-background);border-radius:4px;padding:.15em .4em;font-family:var(--vscode-editor-font-family);font-size:.9em;overflow-wrap:break-word;word-break:break-all}
 .md .codeblock{margin:8px 0;border-radius:6px;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));overflow:hidden}
 .md .codebar{display:flex;align-items:center;justify-content:space-between;padding:2px 10px;font-size:11px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))}
 .md .codebar .copy{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 4px;margin:0}.md .codebar .copy:hover{text-decoration:underline;color:var(--vscode-foreground)}
 .md pre{margin:0;padding:10px 12px;overflow:auto;white-space:pre;line-height:1.5}.md pre code{background:transparent;padding:0;font-size:12px;word-break:normal}
 .md blockquote{border-left:3px solid var(--vscode-focusBorder);margin:4px 0;padding:0 8px;opacity:.85}
 .md table{border-collapse:collapse;margin:4px 0 6px;font-size:.95em;max-width:100%;display:block;overflow:auto}
 .md th,.md td{border:1px solid var(--vscode-panel-border);padding:2px 6px;vertical-align:top}.md th{background:var(--vscode-editorWidget-background);font-weight:600}
 .md hr{border:0;border-top:1px solid var(--vscode-panel-border);margin:6px 0}
 .md del{opacity:.7}.md .box{opacity:.8}.md .box.on{color:var(--vscode-charts-green,inherit)}
 #compose{display:flex;flex-direction:column;gap:4px;padding:5px 5px 4px;border-top:1px solid var(--vscode-panel-border)}
 #chips{display:none;flex-wrap:wrap;gap:4px}#chips.has{display:flex}
 .chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);max-width:100%}
 .chip b{font-weight:600;opacity:.8}.chip .rm{cursor:pointer;opacity:.7;border:0;background:transparent;color:inherit;padding:0;font-size:12px;line-height:1}
 /* The input box grows with its text (up to ~45% of the pane) and has a drag grip
    on its top edge for a height of your own; the chosen height is remembered.
    Double-click the grip to go back to automatic. */
 #grip{height:6px;margin:-3px 0 -2px;cursor:ns-resize;border-radius:3px;position:relative}
 #grip::after{content:"";position:absolute;left:50%;top:2px;width:36px;height:2px;margin-left:-18px;border-radius:1px;background:var(--vscode-widget-border,var(--vscode-panel-border));opacity:.6}
 #grip:hover::after,#grip.drag::after{background:var(--vscode-focusBorder);opacity:1}
 textarea{resize:none;min-height:48px;max-height:45vh;overflow-y:auto;width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:4px 6px;font:inherit;line-height:1.4}
 textarea.manual{max-height:none}
 #p-steer .n{font-weight:600}#p-steer.off{opacity:.55}
 #menu .it .mode{display:inline-block;margin-left:6px;font-size:10px;padding:0 5px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);vertical-align:1px}
 #menu .it .mode.always{background:var(--vscode-charts-green,#2ea043);color:#fff}
 #menu .it .open{float:right;opacity:.6;font-size:11px;margin-left:8px}#menu .it:hover .open{opacity:1}
 #picks{display:flex;align-items:center;justify-content:space-between;gap:1px 6px;flex-wrap:wrap;min-height:20px}
 #picks .g{display:flex;align-items:center;gap:2px;flex-wrap:wrap}#picks .g.r{margin-left:auto}
 .pick{border:0;background:transparent;color:var(--vscode-foreground);opacity:.85;border-radius:3px;padding:1px 5px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;gap:3px}
 .pick:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.15));opacity:1}
 .pick .car{opacity:.6;font-size:9px}
 .pick.icon{font-size:14px;padding:1px 6px}
 #auto{display:inline-flex;align-items:center;gap:5px}
 #auto .sw{width:22px;height:12px;border-radius:6px;background:var(--vscode-button-secondaryBackground);position:relative;transition:background .15s}
 #auto .sw::after{content:"";position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:var(--vscode-foreground);opacity:.6;transition:left .15s}
 #auto.on .sw{background:var(--vscode-button-background)}#auto.on .sw::after{left:12px;opacity:1;background:var(--vscode-button-foreground)}
 #send{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
 #send.stop{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 #menu{position:fixed;z-index:9;min-width:180px;max-width:min(360px,90vw);max-height:60vh;overflow:auto;background:var(--vscode-menu-background,var(--vscode-editorWidget-background));color:var(--vscode-menu-foreground,var(--vscode-foreground));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,var(--vscode-panel-border)));border-radius:4px;box-shadow:0 4px 14px rgba(0,0,0,.35);padding:4px;display:none}
 #menu.on{display:block}
 #menu .h{font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.6;padding:6px 8px 2px}
 #menu .it{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:5px 8px;border-radius:3px;cursor:pointer;font:inherit}
 #menu .it:hover,#menu .it.on{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,inherit)}
 #menu .it small{display:block;opacity:.7;font-size:11px;white-space:normal}
 #hint{font-size:11px;opacity:.55;padding:0 6px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .cursor::after{content:"▍";opacity:.6;animation:b 1s steps(2) infinite}@keyframes b{to{opacity:0}}
</style></head><body>
<div id="noscript-hint" style="padding:10px 12px;font-size:12px;opacity:.7">KiroCrew chat is loading&hellip; If this line never disappears, scripts inside webviews are blocked in this browser &mdash; screenshot this and report it.</div>
<div id="tabs"></div>
<div id="panes">
 <div id="pin" class="pin" hidden data-testid="pinned-prompt"><div class="pin-card"><button type="button" class="pin-text" title="Jump to this turn"></button><button type="button" class="pin-more" title="Show the whole prompt" aria-expanded="false">⌄</button></div></div>
</div>
<div id="compose">
 <div id="grip" title="Drag to resize the input box; double-click for automatic height" role="separator" aria-orientation="horizontal" aria-label="Resize input box"></div>
 <div id="chips"></div>
 <textarea id="text" rows="2" placeholder="Ask a question or describe a task…" title="Enter to send, Shift+Enter for a newline, # for context, #steering-name to include a manual steering file"></textarea>
 <div id="picks">
  <div class="g">
   <button class="pick icon" id="ctx" title="Add context (#)">#</button>
   <button class="pick icon" id="att" title="Attach files (or paste an image)"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10.5 5.5 5.7 10.3a1.6 1.6 0 0 0 2.3 2.3l5.2-5.2a3.2 3.2 0 0 0-4.5-4.5L3.3 8.3a4.6 4.6 0 0 0 6.5 6.5l4-4"/></svg></button>
   <button class="pick" id="p-agent" data-key="agent" title="Agent"></button>
   <button class="pick" id="p-model" data-key="model" title="Model"></button>
   <button class="pick" id="p-effort" data-key="effort" title="Reasoning effort"></button>
   <button class="pick" id="p-font" title="Message font size (transcript only)"><span style="font-size:11px">A</span><span>a</span><span class="car">▾</span></button>
   <button class="pick" id="p-steer" title="Steering files of this workspace and ~/.kiro (Kiro's inclusion modes)"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="m10.6 5.4-1.5 3.7-3.7 1.5 1.5-3.7z"/></svg><span class="n"></span><span class="car">▾</span></button>
  </div>
  <div class="g r">
   <button class="pick" id="auto" title="Autopilot: approve every tool of this session without asking"><span>Autopilot</span><span class="sw"></span></button>
   <button id="send" title="Send (Enter)">&#8593;</button>
  </div>
 </div>
 <input type="file" id="file" multiple style="display:none">
</div>
<div id="hint">Sessions run in the KiroCrew gateway and keep going if this window disconnects.</div>
<div id="menu"></div>
<script>
document.getElementById('noscript-hint').remove();
const vscode = acquireVsCodeApi();
const FOX = ${JSON.stringify(foxUri || "")};
const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs'), panes = $('panes'), text = $('text'), menu = $('menu'), chipsEl = $('chips');
const PATH_RE = new RegExp(${JSON.stringify(PATH_RE.source)}, 'g');
const state = new Map(); // tab id -> {log, streaming, buf, seen, cards, key, contexts, files, running, settings}
let active = null;
let choices = { agents: [], models: [], efforts: [] };
function pane(id){
  let st = state.get(id);
  if(!st){
    const log=document.createElement('div'); log.className='log'; log.dataset.id=id; panes.appendChild(log); log.addEventListener('scroll', pinSchedule, { passive:true });
    const empty=document.createElement('div'); empty.className='empty';
    if(FOX){const im=document.createElement('img'); im.src=FOX; im.alt=''; empty.appendChild(im);}
    const tx=document.createElement('div'); tx.textContent='New chat — pick an agent and a workflow below, then say something.'; empty.appendChild(tx); log.appendChild(empty);
    // The working indicator: four foxes (dots without the asset). \`order\` keeps it
    // the last flex item however rows are appended around it.
    const work=document.createElement('div'); work.className='work'+(FOX?'':' nofox'); work.style.order='1'; work.dataset.testid='working'; work.setAttribute('role','status'); work.setAttribute('aria-label','Agent working');
    for(let i=0;i<4;i++){ if(FOX){const im=document.createElement('img'); im.src=FOX; im.alt=''; work.appendChild(im);} else {const sp=document.createElement('span'); sp.className='fallback'; work.appendChild(sp);} }
    log.appendChild(work);
    st={log, empty, work, streaming:null, buf:'', seen:new Set(), cards:new Map(), key:null, contexts:[], files:[], running:false, settings:{}, think:null}; state.set(id, st);
  }
  return st;
}
// Foxes hop while the turn runs and no answer text is on its way (reasoning,
// tool calls, the wait before the first token); streaming text replaces them.
function setWork(st){ if(!st||!st.work) return; const on=Boolean(st.running && !st.streaming && !st.empty); st.work.classList.toggle('on', on); if(on) scrollLog(st); }
function show(id){ active=id; for(const [tid,st] of state) st.log.classList.toggle('on', tid===id); renderCompose(); pinSchedule(); }
function el(st, cls, content){ if(st.empty){st.empty.remove(); st.empty=null;} const d=document.createElement('div');d.className='row '+cls;if(content!==undefined)d.textContent=content;st.log.appendChild(d);return d;}
// Named scrollLog, NOT scroll: a global \`scroll\` shadows window.scroll(),
// which the webview host calls during setInitialScrollPosition — the resulting
// TypeError aborted the host's onLoad chain and left the whole pane blank.
function scrollLog(st){ if(!st || !st.log) return; st.log.scrollTop = st.log.scrollHeight; }
// ---- the pinned prompt (KiroCrew's pinned-prompt, in the webview's own terms)
// The pinned turn is the last user row whose top has scrolled above the fold
// (the card's top edge, 4px under the pane's top); it shows once the bubble
// itself has left the card's footprint, so the two are never both on screen,
// and it slides up as the next user row comes within the card's height (gone
// when under 6px would remain). One overlay serves the active tab.
const pin=$('pin'), pinCard=pin.querySelector('.pin-card'), pinLabel=pin.querySelector('.pin-text'), pinMore=pin.querySelector('.pin-more');
const PIN_GAP=4;
let pinRow=null, pinRaf=0, pinOpen=false;
// Preview text the way the dashboard makes it: fences folded to " … ", images
// dropped, attachment markers reduced to the file name, whitespace collapsed.
function pinText(s){ return String(s||'').replace(/\`\`\`[\\s\\S]*?\`\`\`/g,' … ').replace(/!\\[[^\\]]*\\]\\([^)]*\\)/g,' ').replace(/\\[attached_file \\d+\\]\\s*(\\S+)/g,(m,p)=>p.split('/').pop()||'').replace(/\\s+/g,' ').trim(); }
function pinFull(s){ return String(s||'').replace(/\\[attached_file \\d+\\]\\s*(\\S+)/g,(m,p)=>'📎 '+(p.split('/').pop()||'')).trim(); }
function pinRender(){ const raw = pinRow ? (pinRow.dataset.prompt!==undefined ? pinRow.dataset.prompt : pinRow.textContent) : ''; pinLabel.textContent = pinOpen ? pinFull(raw) : pinText(raw); pinLabel.title = pinOpen ? 'Jump to this turn' : 'Jump to this turn\\n\\n'+pinText(raw).slice(0,600); }
function pinSet(row){
  if(row===pinRow) return;
  pinRow=row; pinOpen=false; pin.classList.remove('open'); pinMore.setAttribute('aria-expanded','false'); pinMore.title='Show the whole prompt';
  pinRender();
}
function pinToggle(open){ pinOpen = open===undefined ? !pinOpen : Boolean(open); pin.classList.toggle('open', pinOpen); pinMore.setAttribute('aria-expanded', String(pinOpen)); pinMore.title = pinOpen ? 'Show one line' : 'Show the whole prompt'; pinRender(); pinSchedule(); }
function pinSchedule(){ if(pinRaf) return; pinRaf=requestAnimationFrame(()=>{ pinRaf=0; pinUpdate(); }); }
function pinUpdate(){
  const st = active!=null ? state.get(active) : null; const log = st && st.log;
  if(!log || !log.classList.contains('on') || st.empty){ pinSet(null); pin.hidden=true; pinCard.style.transform=''; return; }
  const fold = log.getBoundingClientRect().top + PIN_GAP;
  let cur=null, next=null;
  for(const u of log.querySelectorAll('.row.user')){ if(u.getBoundingClientRect().top < fold){ cur=u; } else { if(cur) next=u; break; } }
  if(!cur){ pinSet(null); pin.hidden=true; pinCard.style.transform=''; return; }
  pinSet(cur); pin.hidden=false;
  const cardH = pinCard.getBoundingClientRect().height, r = cardH + PIN_GAP;
  // The bubble still shows under the card's footprint: it speaks for itself.
  if(!pinOpen && cur.getBoundingClientRect().bottom > fold + cardH + PIN_GAP){ pin.hidden=true; return; }
  let push=0;
  if(next){ const nt = next.getBoundingClientRect().top - fold; if(nt < r) push = Math.max(0, r - nt); }
  if(push && r - push < 6){ pin.hidden=true; return; }
  pinCard.style.transform = push ? 'translateY(-'+push.toFixed(1)+'px)' : '';
  // The ⌄ shows when the one-line preview hides something (kept as is while hovered, when three lines show).
  const raw = pinRow.dataset.prompt!==undefined ? pinRow.dataset.prompt : pinRow.textContent;
  const hovered = pinCard.matches(':hover');
  const more = pinOpen || /\\n|\`\`\`|\\[attached_file /.test(raw) || (!hovered && pinLabel.scrollHeight > pinLabel.clientHeight + 1) || (hovered && pin.classList.contains('more'));
  pin.classList.toggle('more', more);
}
function pinJump(){
  const st = active!=null ? state.get(active) : null;
  if(!st || !pinRow || !pinRow.isConnected) return;
  if(pinOpen) pinToggle(false);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // offsetTop is relative to the log (its position:absolute makes it the offsetParent); land the row 8px under the pane's top, where the log's own padding puts a first row.
  const top = Math.max(0, pinRow.offsetTop - 8);
  if(typeof st.log.scrollTo==='function') st.log.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' }); else st.log.scrollTop = top;
}
pinLabel.onclick=pinJump;
pinMore.onclick=(e)=>{ e.stopPropagation(); pinToggle(); };
if(typeof ResizeObserver!=='undefined') new ResizeObserver(()=>pinSchedule()).observe(panes);
if(typeof MutationObserver!=='undefined') new MutationObserver(()=>pinSchedule()).observe(panes, { childList:true, subtree:true });
function linkify(node, s){
  node.textContent=''; let last=0;
  for(const m of s.matchAll(PATH_RE)){
    const p=m[1]; if(/^https?:/.test(p)||p.endsWith('/')||p.endsWith('.')||/^[\\d.]+$/.test(p.replace(/\\//g,''))) continue;
    node.appendChild(document.createTextNode(s.slice(last,m.index)));
    const a=document.createElement('a'); a.className='path'; a.textContent=m[0]; a.title='Open '+p;
    a.onclick=(e)=>{e.preventDefault(); vscode.postMessage({type:'open', id:active, path:p, line:m[2]?Number(m[2]):undefined, column:m[3]?Number(m[3]):undefined});};
    node.appendChild(a); last=m.index+m[0].length;
  }
  node.appendChild(document.createTextNode(s.slice(last)));
}
// \`[OPTIONS: a | b | c]\` on the last line of an assistant message: strip it and render the labels as
// buttons; clicking one sends that label as the next message (the dashboard's own convention).
const OPT_RE = /\\n?\\s*\\[OPTIONS:\\s*([^\\]]*)\\]\\s*$/;
// ---- tool calls: a 🔧 row opens on click to show the call's input and output
// (the dashboard's tool card). The host's tool row carries meta.input (the
// call's arguments, usually JSON), meta.output once the tool returned, meta.done
// and tool_call_id; a live run completes the row through a tool_result frame.
const TOOL_PRE_MAX = 20000;
function clipText(s, n){ s=String(s||''); return s.length>n ? s.slice(0,n)+'\\n… (truncated, '+(s.length-n)+' more chars)' : s; }
function isToolCall(r){ const m=r.meta||{}; return Boolean(m.tool_call_id) || m.input!==undefined || m.output!==undefined; }
// The arguments as a reader wants them: a shell call shows its command, a
// one-field call its value, anything else pretty JSON; a non-JSON string as is.
function toolInputText(input){
  if(input===undefined||input===null||input==='') return '';
  let v=input;
  if(typeof v==='string'){ try{ v=JSON.parse(v); }catch{ return v; } }
  if(v && typeof v==='object' && !Array.isArray(v)){
    const keys=Object.keys(v);
    if(typeof v.command==='string'){ const rest=keys.filter(k=>!['command','description','purpose','summary','__tool_use_purpose'].includes(k)); return v.command + (rest.length ? '\\n'+rest.map(k=>k+': '+(typeof v[k]==='string'?v[k]:JSON.stringify(v[k]))).join('\\n') : ''); }
    if(keys.length===1 && typeof v[keys[0]]==='string') return v[keys[0]];
  }
  try{ return JSON.stringify(v,null,2); }catch{ return String(v); }
}
function toolRow(st, d, r){
  const meta=r.meta||{}; const content=String(r.content||''); const lines=content.split('\\n'); const first=lines[0];
  const em=/^(\\p{Extended_Pictographic}\\uFE0F?)\\s*/u.exec(first);
  const title=(typeof meta.purpose==='string' && meta.purpose) || (em ? first.slice(em[0].length) : first) || meta.tool_name || 'tool';
  d.classList.add('call'); d.dataset.tcid=meta.tool_call_id||''; d.dataset.open='false';
  d._tool={ input: meta.input, output: meta.output, done: Boolean(meta.done), extra: lines.length>1 ? lines.slice(1).join('\\n') : '', body:null };
  const head=document.createElement('button'); head.type='button'; head.className='tool-head'; head.setAttribute('aria-expanded','false'); head.title="Show this call's input and output";
  const ic=document.createElement('span'); ic.className='tool-ico'; ic.textContent=em ? em[1] : '🔧';
  const tt=document.createElement('span'); tt.className='tool-title'; tt.textContent=title;
  const live=document.createElement('span'); live.className='tool-live'; live.title='running';
  const chev=document.createElement('span'); chev.className='tool-chev'; chev.textContent='›';
  head.appendChild(ic); head.appendChild(tt); head.appendChild(live); head.appendChild(chev); d.appendChild(head);
  head.onclick=()=>toolToggle(d);
  toolLive(st, d);
}
function toolLive(st, d){ const t=d._tool; if(!t) return; d.classList.toggle('live', Boolean(st.running) && !t.done); }
function toolBody(d){
  const t=d._tool; if(t.body) return t.body;
  const body=document.createElement('div'); body.className='tool-body'; body.hidden=true;
  const sec=(label)=>{ const s=document.createElement('div'); s.className='tool-sec'; const k=document.createElement('div'); k.className='tool-k'; k.textContent=label; const pre=document.createElement('pre'); pre.className='tool-pre'; s.appendChild(k); s.appendChild(pre); body.appendChild(s); return pre; };
  t.inPre=sec('Input'); t.outPre=sec('Output'); d.appendChild(body); t.body=body; toolFill(d); return body;
}
function toolFill(d){
  const t=d._tool; if(!t || !t.body) return;
  const inText = toolInputText(t.input) || t.extra || '';
  t.inPre.parentElement.hidden = !inText; if(inText) linkify(t.inPre, clipText(inText, TOOL_PRE_MAX));
  const out = t.output===undefined||t.output===null ? '' : String(t.output);
  if(out){ linkify(t.outPre, clipText(out, TOOL_PRE_MAX)); } else { t.outPre.textContent = t.done ? '(no output)' : 'running…'; }
  t.outPre.classList.toggle('muted', !out);
}
function toolToggle(d, open){ const body=toolBody(d); const o = open===undefined ? body.hidden : Boolean(open); body.hidden=!o; d.dataset.open=String(o); d.querySelector('.tool-head').setAttribute('aria-expanded', String(o)); pinSchedule(); }
function toolRows(st, tcid){ return tcid ? [...st.log.querySelectorAll('.row.tool.call')].filter(x=>x.dataset.tcid===tcid) : []; }
// tool_result: the call returned; its output lands on the row (an empty output
// still marks it done — the host sends that for tools that print nothing).
function toolResult(st, tcid, output){ for(const d of toolRows(st, tcid)){ const t=d._tool; if(output!==undefined && output!==null && (String(output) || !t.output)) t.output=String(output); t.done=true; toolLive(st, d); toolFill(d); } }
// tool_call (is_update): the refined title/arguments of a call already shown.
function toolUpdate(st, m){ for(const d of toolRows(st, m.tcid)){ const t=d._tool; const title=(typeof m.purpose==='string' && m.purpose) || m.title; if(title){ const tt=d.querySelector('.tool-title'); if(tt) tt.textContent=String(title).replace(/^\\p{Extended_Pictographic}\\uFE0F?\\s*/u,''); } if(m.input && (t.input===undefined||t.input===null||t.input==='')) t.input=m.input; toolFill(d); } }
// The turn ended: nothing is running any more, whatever rows never got a result.
function toolsSettle(st){ for(const d of st.log.querySelectorAll('.row.tool.call')){ if(d._tool){ d._tool.done=true; toolLive(st, d); toolFill(d); } } }
function assistant(st, node, s){
  const m = OPT_RE.exec(s||'');
  const body = m ? s.slice(0, m.index).replace(/\\s+$/,'') : s;
  renderMd(node, body);
  if(!m) return;
  const opts = m[1].split('|').map(x=>x.trim()).filter(Boolean); if(!opts.length) return;
  const box=document.createElement('div'); box.className='options';
  opts.forEach((o)=>{ const b=document.createElement('button'); b.textContent=o; b.onclick=()=>{ box.remove(); sendText(o); }; box.appendChild(b); });
  node.after(box);
}
${mdToHtml.toString()}
// Assistant text: markdown -> DOM (the renderer escapes everything and emits only
// data-* anchors; the click delegation below turns them into editor/external opens).
function renderMd(node, s){ node.classList.add('md'); node.innerHTML = mdToHtml(s); }
document.addEventListener('click', (e)=>{
  const a = e.target.closest && e.target.closest('a.path, a.link, button.copy');
  if(!a) return;
  e.preventDefault();
  if(a.classList.contains('copy')){ const pre = a.closest('.codeblock').querySelector('pre'); const txt = pre ? pre.textContent : '';
    const done = ()=>{ a.textContent='Copied'; setTimeout(()=>{ a.textContent='Copy'; }, 1200); };
    if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, ()=>vscode.postMessage({type:'copy', text:txt})); else vscode.postMessage({type:'copy', text:txt}); done(); return; }
  if(a.dataset.url) { vscode.postMessage({type:'link', url:a.dataset.url}); return; }
  vscode.postMessage({type:'open', id:active, path:a.dataset.path, line:a.dataset.line?Number(a.dataset.line):undefined, column:a.dataset.col?Number(a.dataset.col):undefined});
});
function finishStream(st){ if(st.streaming){ const t=st.buf; st.streaming.classList.remove('cursor','streaming');st.streaming.classList.add('assistant'); assistant(st, st.streaming, t); st.streaming=null;st.buf=''; scrollLog(st);} setWork(st); }
// Thinking, the way KiroCrew's own transcript does it (its ThinkingBlock): the
// gateway streams \`chat_thinking\` as deltas, ephemeral and never persisted, so
// they accumulate into ONE block per thinking phase — a collapsed disclosure
// whose header reads "Thinking" with a pulsing dot while deltas arrive and the
// last 240 chars as a one-line live preview (left-faded when clipped), then
// "Thought process" once no delta came for 1.2 s; expanded, the full text sits
// behind a left accent rule, pre-wrapped, auto-scrolled while live. The block
// goes ABOVE the answer streaming under it (the host inserts the thinking row
// before the streaming row), and a tool or answer row closes it, so reasoning
// after a tool call opens a new block. (Before: one '…' row per delta.)
const THINK_QUIET_MS = 1200, THINK_LIVE_CHARS = 240;
function thinkBlock(st){
  if(st.think) return st.think;
  if(st.empty){st.empty.remove(); st.empty=null;}
  const box=document.createElement('div'); box.className='row think'; box.dataset.open='false'; box.dataset.testid='think-block';
  const head=document.createElement('button'); head.type='button'; head.className='think-head'; head.setAttribute('aria-expanded','false'); head.title='Show reasoning';
  const dot=document.createElement('span'); dot.className='think-dot'; head.appendChild(dot);
  const label=document.createElement('span'); label.className='think-label'; label.textContent='Thinking'; head.appendChild(label);
  const chev=document.createElement('span'); chev.className='think-chev'; chev.textContent='›'; head.appendChild(chev);
  const live=document.createElement('span'); live.className='think-live'; live.dataset.testid='think-live'; head.appendChild(live);
  const body=document.createElement('div'); body.className='think-body'; body.dataset.testid='think-body'; body.hidden=true;
  box.appendChild(head); box.appendChild(body);
  head.onclick=()=>{ const open=body.hidden; body.hidden=!open; box.dataset.open=String(open); head.setAttribute('aria-expanded',String(open)); head.title=open?'Hide reasoning':'Show reasoning'; if(open) body.scrollTop=body.scrollHeight; pinSchedule(); };
  if(st.streaming) st.log.insertBefore(box, st.streaming); else st.log.appendChild(box);
  st.think={box, label, live, body, text:'', timer:null}; return st.think;
}
function thinkDelta(st, text){
  const t=thinkBlock(st); t.text+=text; t.body.textContent=t.text;
  t.live.textContent=t.text.slice(-THINK_LIVE_CHARS).replace(/\\s+/g,' ').trimStart();
  t.live.scrollLeft=t.live.scrollWidth; t.live.dataset.clipped=String(t.live.scrollWidth>t.live.clientWidth);
  t.box.classList.add('live'); t.label.textContent='Thinking';
  if(!t.body.hidden) t.body.scrollTop=t.body.scrollHeight;
  clearTimeout(t.timer); t.timer=setTimeout(()=>thinkQuiet(t), THINK_QUIET_MS);
}
function thinkQuiet(t){ t.timer=null; t.box.classList.remove('live'); t.label.textContent='Thought process'; }
function thinkClose(st){ if(!st||!st.think) return; const t=st.think; clearTimeout(t.timer); thinkQuiet(t); st.think=null; }
function row(id, r){
  const st=pane(id);
  if(r.meta && r.meta.mid){ if(st.seen.has(r.meta.mid)) return; st.seen.add(r.meta.mid); }
  if(r.role==='assistant' && st.streaming){ st.buf=r.content; finishStream(st); return; }
  if(r.role==='chunk'||r.role==='done'||r.role==='streaming'||r.role==='queued') return;
  if(r.role==='permission'){
    const box = el(st,'permission');
    const m = r.meta||{}; const title = m.tool_title||m.tool_name||'tool';
    box.textContent = 'Approval needed: '+title+(m.full_command?'\\n$ '+m.full_command:(m.tool_input?'\\n'+String(m.tool_input).slice(0,400):''));
    const a=document.createElement('button');a.textContent='Approve';a.onclick=()=>{vscode.postMessage({type:'approve',id,requestId:m.request_id||m.approval_id||'',action:'approved'});box.remove();};
    const j=document.createElement('button');j.className='reject';j.textContent='Reject';j.onclick=()=>{vscode.postMessage({type:'approve',id,requestId:m.request_id||m.approval_id||'',action:'rejected'});box.remove();};
    box.appendChild(document.createElement('br'));box.appendChild(a);box.appendChild(j);scrollLog(st);return;
  }
  if(r.role==='thinking'){ if(r.content){ thinkDelta(st, r.content); thinkClose(st); scrollLog(st); } return; }
  const cls = ['user','assistant','tool','status'].includes(r.role)?r.role:'tool';
  const isErr = cls==='assistant' && (/\\bmsg-err\\b/.test(r.cls||'') || /^\\s*[❌⏱]/.test(r.content||''));
  const d = el(st,cls+(isErr?' err':'')); if(cls==='user'){d.textContent=r.content; d.dataset.prompt=String(r.content||'');} else if(cls==='assistant'){assistant(st, d, r.content);} else if(cls==='tool' && r.role==='tool' && isToolCall(r)){toolRow(st, d, r);} else {linkify(d, r.content);} scrollLog(st);
}
function question(id, card){
  const st=pane(id); const qid = card.ask_id||card.card_id; if(!qid||st.cards.has(qid)) return;
  const box = el(st,'question'); st.cards.set(qid, box);
  const answers = {}; const qs = Array.isArray(card.questions)?card.questions:[];
  function submit(){ vscode.postMessage({type:'answer', id, card:{ask_id:card.ask_id, card_id:card.card_id}, answers}); box.remove(); st.cards.delete(qid); }
  qs.forEach((q, i)=>{
    const key = q.key||q.header||q.question||('q'+i);
    if(q.header){const h=document.createElement('div');h.className='d';h.textContent=q.header;box.appendChild(h);}
    const qq=document.createElement('div');qq.className='q';qq.textContent=q.question||q.label||'';box.appendChild(qq);
    if(q.description){const dd=document.createElement('div');dd.className='d';dd.textContent=q.description;box.appendChild(dd);}
    const opts = Array.isArray(q.options)?q.options:[];
    if(opts.length){
      const multi = Boolean(q.allowMultiple||q.allow_multiple||q.multiple); const chosen = new Set();
      opts.forEach((o)=>{
        const label = typeof o==='string'?o:(o.label||o.value||''); const value = typeof o==='string'?o:(o.value||o.label||'');
        const b=document.createElement('button'); b.className='opt'; b.textContent=label;
        if(typeof o==='object'&&o.description){const sm=document.createElement('small');sm.textContent=o.description;b.appendChild(sm);}
        b.onclick=()=>{ if(multi){ if(chosen.has(value)){chosen.delete(value);b.classList.remove('on');} else {chosen.add(value);b.classList.add('on');} answers[key]=[...chosen].join(', '); }
          else { answers[key]=value; if(qs.length===1){ submit(); } else { box.querySelectorAll('button.opt').forEach(x=>{ if(x.parentNode===b.parentNode) x.classList.remove('on'); }); b.classList.add('on'); } } };
        box.appendChild(b);
      });
    } else {
      const inp=document.createElement('input'); inp.placeholder=q.placeholder||'type your answer'; inp.oninput=()=>{answers[key]=inp.value;};
      inp.onkeydown=(e)=>{ if(e.key==='Enter'){ e.preventDefault(); submit(); } }; box.appendChild(inp);
    }
  });
  const ok=document.createElement('button'); ok.textContent='Submit'; ok.onclick=submit;
  const skip=document.createElement('button'); skip.className='secondary'; skip.textContent='Dismiss'; skip.onclick=()=>{ vscode.postMessage({type:'answer', id, card:{ask_id:card.ask_id, card_id:card.card_id}, answers:{}, dismissed:true}); box.remove(); st.cards.delete(qid); };
  box.appendChild(document.createElement('br')); box.appendChild(ok); box.appendChild(skip); scrollLog(st);
}
function renderTabs(tabs, act){
  tabsEl.innerHTML='';
  for(const t of tabs){
    const st=pane(t.id); st.running=Boolean(t.running); st.settings=t.settings||st.settings; st.key=t.key; setWork(st); for(const d of st.log.querySelectorAll('.row.tool.call')) toolLive(st, d);
    const d=document.createElement('div'); d.className='tab'+(t.id===act?' on':''); d.title=t.key||'new chat';
    if(t.running||t.waiting){const dot=document.createElement('span'); dot.className='dot '+(t.waiting?'wait':'run'); d.appendChild(dot);}
    const tt=document.createElement('span'); tt.className='t'; tt.textContent=t.title; d.appendChild(tt);
    const x=document.createElement('button'); x.className='x'; x.textContent='×'; x.title='Close tab'; x.onclick=(e)=>{e.stopPropagation(); vscode.postMessage({type:'close', id:t.id});}; d.appendChild(x);
    d.onclick=()=>vscode.postMessage({type:'select', id:t.id});
    tabsEl.appendChild(d);
  }
  const add=document.createElement('button'); add.className='add'; add.textContent='＋'; add.title='New chat'; add.onclick=()=>vscode.postMessage({type:'new'}); tabsEl.appendChild(add);
  show(act);
  const on = tabsEl.querySelector('.tab.on'); if(on && on.scrollIntoView) on.scrollIntoView({block:'nearest', inline:'nearest'});
}
// Plain wheel scrolls the strip sideways too (Shift+wheel already does natively).
tabsEl.addEventListener('wheel', (e)=>{ if(e.deltaY && !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)){ tabsEl.scrollLeft += e.deltaY; e.preventDefault(); } }, {passive:false});

// ---- composer: picks, chips, attachments -------------------------------
function labelOf(list, id, fallback){ const f=(list||[]).find(x=>x.id===(id||'')); return f ? f.label : (id || fallback); }
function renderCompose(){
  const st = state.get(active); const s = (st && st.settings) || {};
  const pick = (id, txt) => { const b=$(id); b.textContent=''; const sp=document.createElement('span'); sp.textContent=txt; b.appendChild(sp); const c=document.createElement('span'); c.className='car'; c.textContent='▾'; b.appendChild(c); };
  pick('p-agent', pickLabel(s));
  pick('p-model', labelOf(choices.models, s.model, "agent's model"));
  pick('p-effort', labelOf(choices.efforts, s.effort, 'default effort'));
  $('auto').classList.toggle('on', Boolean(s.autopilot));
  const send=$('send'); send.classList.toggle('stop', Boolean(st && st.running)); send.textContent = st && st.running ? '■' : '↑'; send.title = st && st.running ? 'Stop the running turn' : 'Send (Enter)';
  chipsEl.innerHTML=''; const items = st ? st.contexts.map((c,i)=>({kind:'ctx', label:c.label, i})).concat(st.files.map((f,i)=>({kind:'file', label:f.name, i}))) : [];
  chipsEl.classList.toggle('has', items.length>0);
  for(const it of items){ const ch=document.createElement('span'); ch.className='chip'; const b=document.createElement('b'); b.textContent = it.kind==='ctx' ? '#' : '📎'; ch.appendChild(b); ch.appendChild(document.createTextNode(it.label));
    const rm=document.createElement('button'); rm.className='rm'; rm.textContent='×'; rm.title='Remove'; rm.onclick=()=>{ if(it.kind==='ctx') st.contexts.splice(it.i,1); else st.files.splice(it.i,1); renderCompose(); }; ch.appendChild(rm); chipsEl.appendChild(ch); }
  renderHint();
}
function renderHint(){ const st=state.get(active); $('hint').textContent = st&&st.key ? 'session '+st.key+' — runs in the gateway; find it again under History.' : 'Sessions run in the KiroCrew gateway and keep going if this window disconnects.'; }
// In-page popover menu (never window.prompt/confirm: those are no-ops in the desktop app).
function openMenu(anchor, header, items, current, onPick){
  menu.innerHTML=''; if(header){ const h=document.createElement('div'); h.className='h'; h.textContent=header; menu.appendChild(h); }
  let section=null;
  for(const it of items){ if(it.section && it.section!==section){ section=it.section; const h=document.createElement('div'); h.className='h'; h.textContent=section; menu.appendChild(h); }
    const b=document.createElement('button'); b.className='it'+(it.id===current?' on':''); b.textContent=it.label; if(it.description){ const sm=document.createElement('small'); sm.textContent=it.description; b.appendChild(sm);} b.onclick=()=>{ closeMenu(); onPick(it); }; menu.appendChild(b); }
  menu.classList.add('on');
  const r=anchor.getBoundingClientRect(); menu.style.left='0px'; menu.style.top='0px';
  const mw=menu.offsetWidth, mh=menu.offsetHeight;
  menu.style.left=Math.max(4, Math.min(r.left, window.innerWidth-mw-4))+'px';
  menu.style.top=Math.max(4, r.top-mh-4)+'px';
}
function closeMenu(){ menu.classList.remove('on'); }
document.addEventListener('mousedown', (e)=>{ if(menu.classList.contains('on') && !menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeMenu(); });
function setting(key, value){ const st=state.get(active); if(!st) return; st.settings[key]=value; renderCompose(); vscode.postMessage({type:'setting', id:active, key, value}); }
// The effective pick of a tab, in the picker's own id space (see agentPicks on the extension side).
function pickId(s){ if(s.mode && s.mode!=='default'){ const kiro=(choices.agents||[]).find(x=>x.kiro && x.id==='agent:'+s.agent); return kiro ? kiro.id : 'workflow:'+s.mode; } return s.agent ? 'agent:'+s.agent : ''; }
function pickLabel(s){ const id=pickId(s); const it=(choices.agents||[]).find(x=>x.id===id); if(it) return it.label; return s.agent || 'Default'; }
for(const [id,key,header] of [['p-model','model','Model'],['p-effort','effort','Reasoning effort']]){
  $(id).onclick=(e)=>{ const list = key==='model'?choices.models:choices.efforts; const st=state.get(active);
    if(!list.length){ vscode.postMessage({type:'choices'}); return; }
    openMenu(e.currentTarget, header, list, (st&&st.settings[key])||'', (it)=>setting(key, it.id)); };
}
$('p-agent').onclick=(e)=>{ const st=state.get(active); if(!choices.agents.length){ vscode.postMessage({type:'choices'}); return; }
  openMenu(e.currentTarget, null, choices.agents, st?pickId(st.settings):'', (it)=>{ if(!st) return;
    // Mirror the extension's derivation so the bar updates before the round trip.
    const [kind, ...rest]=it.id.split(':'); const name=rest.join(':');
    if(kind==='hint'){ vscode.postMessage({type:'hint', value:name}); return; }
    if(kind==='workflow'){ st.settings.mode=name; st.settings.agent=st.settings.baseAgent||''; } else { st.settings.agent = kind==='agent'?name:''; st.settings.baseAgent=st.settings.agent; st.settings.mode = it.kiro ? it.label.toLowerCase().replace(' ','-') : 'default'; }
    renderCompose(); vscode.postMessage({type:'setting', id:active, key:'pick', value:it.id}); }); };
$('auto').onclick=()=>{ const st=state.get(active); setting('autopilot', !(st&&st.settings.autopilot)); };
// Message font size: the transcript only (a CSS variable on .log); the tabs, bar and composer keep the workbench size.
let fontSize = 0;
function applyFont(px){ fontSize = Number(px)||0; document.documentElement.style.setProperty('--kide-msg-size', fontSize ? fontSize+'px' : 'inherit'); }
const FONT_SIZES = [{id:0,label:'Default',description:'the workbench font size'}].concat([11,12,13,14,15,16,17,18,20,22,24].map(n=>({id:n,label:n+' px',description:''})));
$('p-font').onclick=(e)=>openMenu(e.currentTarget, 'Message font size', FONT_SIZES, fontSize, (it)=>{ applyFont(it.id); vscode.postMessage({type:'fontSize', px: it.id}); });
// Steering indicator: the count of always-included files (they load with the agent) and a menu of
// every steering file with Kiro's inclusion mode. Picking a fileMatch/manual/auto file includes it in
// the next message; an always file opens in the editor (it is already in every turn).
let steering = [];
function renderSteering(){ const b=$('p-steer'); const always=steering.filter(s=>s.inclusion==='always').length; b.querySelector('.n').textContent = steering.length ? String(always) : '0'; b.classList.toggle('off', !steering.length);
  b.title = !steering.length ? 'No steering files in this workspace or ~/.kiro/steering' : always+' always-included steering file(s) load with the agent'+(steering.length>always?'; '+(steering.length-always)+' more by file match or #name':'') ; }
$('p-steer').onclick=(e)=>{
  if(!steering.length){ openMenu(e.currentTarget, 'Steering', [{id:'none', label:'No steering files', description:'Add .kiro/steering/<name>.md to the workspace (always, fileMatch or manual) — see kiro.dev/docs/steering'}], null, ()=>{}); return; }
  const items = steering.map(s=>({ id:s.name, label:s.label, section: s.scope==='workspace'?'Workspace .kiro/steering':'Global ~/.kiro/steering', steer:s,
    description: s.inclusion==='always' ? 'in every turn, loaded with the agent' : s.inclusion==='fileMatch' ? 'included when a file in context matches '+s.mode.replace(/^fileMatch /,'') : s.inclusion==='manual' ? 'included when the message says #'+s.name+' — click to include it now' : 'auto: the agent decides from its description — click to include it now' }));
  openMenu(e.currentTarget, null, items, null, (it)=>{ if(it.steer.inclusion==='always') vscode.postMessage({type:'steeringOpen', path: it.steer.path}); else vscode.postMessage({type:'steeringPick', id:active, name: it.steer.name}); });
  // Mode badges on the rows (openMenu renders plain labels).
  [...menu.querySelectorAll('.it')].forEach((row, i)=>{ const s = items[i] && items[i].steer; if(!s) return; const badge=document.createElement('span'); badge.className='mode '+s.inclusion; badge.textContent=s.inclusion; row.insertBefore(badge, row.querySelector('small')); const open=document.createElement('span'); open.className='open'; open.textContent= s.inclusion==='always' ? 'open' : 'include'; row.insertBefore(open, row.querySelector('small')); });
};
// Input box height: automatic (grows with the text up to the CSS max) unless the grip set one.
let manualHeight = 0;
function autoGrow(){ if(manualHeight){ text.style.height=manualHeight+'px'; return; } text.style.height='auto'; text.style.height=Math.max(48, text.scrollHeight+2)+'px'; }
function setManualHeight(px){ manualHeight = Math.max(0, Math.round(px)||0); text.classList.toggle('manual', manualHeight>0); autoGrow(); }
text.addEventListener('input', autoGrow);
(function(){ const grip=$('grip'); let startY=0, startH=0, moved=false;
  grip.addEventListener('mousedown', (e)=>{ e.preventDefault(); startY=e.clientY; startH=text.getBoundingClientRect().height; moved=false; grip.classList.add('drag');
    const move=(ev)=>{ const h=Math.max(48, Math.min(window.innerHeight*0.8, startH+(startY-ev.clientY))); moved=true; setManualHeight(h); };
    const up=()=>{ window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); grip.classList.remove('drag'); if(moved) vscode.postMessage({type:'composerHeight', px: manualHeight}); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); });
  grip.addEventListener('dblclick', ()=>{ setManualHeight(0); vscode.postMessage({type:'composerHeight', px: 0}); });
})();
renderSteering(); autoGrow();
const CONTEXT_KINDS = ${JSON.stringify(CONTEXT_KINDS.map((k) => ({ id: k.kind, label: k.label })))};
$('ctx').onclick=(e)=>openMenu(e.currentTarget, 'Select context type', CONTEXT_KINDS, null, (it)=>vscode.postMessage({type:'pickContext', id:active, kind:it.id}));
$('att').onclick=()=>$('file').click();
$('file').onchange=async ()=>{ const st=state.get(active); if(!st) return; for(const f of $('file').files){ const buf=await f.arrayBuffer(); let bin=''; const bytes=new Uint8Array(buf); for(let i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000)); st.files.push({name:f.name, mime:f.type||'', data:btoa(bin)}); } $('file').value=''; renderCompose(); };
text.addEventListener('paste', (e)=>{ const st=state.get(active); if(!st||!e.clipboardData) return; let took=false; for(const item of e.clipboardData.items){ if(item.kind==='file' && /^image\\//.test(item.type)){ const f=item.getAsFile(); if(!f) continue; took=true; f.arrayBuffer().then((buf)=>{ let bin=''; const bytes=new Uint8Array(buf); for(let i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000)); st.files.push({name:'pasted-image-'+Date.now()+'.'+(item.type.split('/')[1]||'png'), mime:item.type, data:btoa(bin)}); renderCompose(); }); } } if(took) e.preventDefault(); });
text.addEventListener('keydown',(e)=>{ if(e.key==='Enter' && !e.shiftKey){e.preventDefault();send();} if(e.key==='#' && !text.value.trim()){ e.preventDefault(); $('ctx').click(); } });
function sendText(t){ const st=state.get(active); if(active==null) return; vscode.postMessage({type:'send', id:active, text:t, contexts: st?st.contexts.splice(0):[], files: st?st.files.splice(0):[]}); renderCompose(); }
function send(){ const st=state.get(active); if(st && st.running){ vscode.postMessage({type:'stop', id:active}); return; } const t=text.value.trim(); if((!t && !(st&&(st.contexts.length||st.files.length)))||active==null) return; text.value=''; autoGrow(); sendText(t); }
$('send').onclick=send;

window.addEventListener('message', (e)=>{
  const m=e.data; const st = m.id!=null ? pane(m.id) : null;
  switch(m.type){
    case 'tabs': renderTabs(m.tabs, m.active); break;
    case 'choices': choices = { agents:m.agents||[], models:m.models||[], efforts:m.efforts||[] }; renderCompose(); break;
    case 'fontSize': applyFont(m.px); break;
    case 'composerHeight': setManualHeight(m.px); break;
    case 'steering': steering = Array.isArray(m.items) ? m.items : []; renderSteering(); break;
    case 'closed': { const s=state.get(m.id); if(s){ s.log.remove(); state.delete(m.id);} break; }
    case 'clear': st.log.innerHTML=''; st.log.appendChild(st.work); st.streaming=null; st.buf=''; st.seen=new Set(); st.cards.clear(); st.empty=null; thinkClose(st); st.think=null; setWork(st); pinSchedule(); break;
    case 'session': st.key=m.key; if(m.id===active) renderHint(); break;
    case 'context': st.contexts.push(m.item); if(m.id===active) renderCompose(); break;
    case 'user': { thinkClose(st); const d=el(st,'user'); d.dataset.prompt=String(m.text||''); if((m.contexts&&m.contexts.length)||(m.files&&m.files.length)){ const c=document.createElement('div'); c.className='ctx'; [...(m.contexts||[]).map(x=>'#'+x), ...(m.files||[]).map(x=>'📎'+x)].forEach((x)=>{ const ch=document.createElement('span'); ch.className='chip'; ch.textContent=x; c.appendChild(ch); }); d.appendChild(c); } d.appendChild(document.createTextNode(m.text)); st.running=true; setWork(st); scrollLog(st); break; }
    case 'chunk': if(!st.streaming){st.streaming=el(st,'streaming cursor','');} st.buf+=m.text; st.streaming.textContent=st.buf; setWork(st); scrollLog(st); break;
    case 'segment': finishStream(st); thinkClose(st); break;
    case 'row': thinkClose(st); row(m.id, m.row); break;
    case 'question': question(m.id, m.card); break;
    case 'questionResolved': { const b=st.cards.get(m.qid); if(b){b.remove();st.cards.delete(m.qid);} break; }
    case 'thinking': if(m.text){thinkDelta(st, m.text);scrollLog(st);} break;
    case 'status': if(m.text){el(st,'status', m.text);scrollLog(st);} break;
    case 'done': finishStream(st); thinkClose(st); st.running=false; setWork(st); toolsSettle(st); break;
    case 'toolResult': toolResult(st, m.tcid, m.output); break;
    case 'toolUpdate': toolUpdate(st, m); break;
    case 'error': el(st,'error', m.text); scrollLog(st); break;
    case 'scroll': scrollLog(st); break;
  }
});
// Hello to the extension: it pushes tabs, choices and transcripts only once this ran
// (and its watchdog reloads this document when a visible view never says so).
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

// ------------------------------------------------- .kiro asset trees

/**
 * Steering, Skills and Agent Hooks views: the same two tiers Kiro reads —
 * the workspace's `.kiro/<dir>/` and the user's `~/.kiro/<dir>/` — listed as
 * files (steering, hooks) or SKILL.md folders (skills), opened in the editor
 * on click. The user home is reached through the remote fs as `~`'s absolute
 * path, resolved once from the `HOME`-shaped hint the workspace folders give.
 */
const ASSET_KINDS = {
  steering: { dir: "steering", icon: "compass", leaf: (name, kind) => kind === vscode.FileType.File && /\.md$/i.test(name) || kind === vscode.FileType.Directory, desc: "steering files (.md) Kiro loads into every session" },
  skills: { dir: "skills", icon: "tools", leaf: (name, kind) => kind === vscode.FileType.Directory, desc: "skills (folders with SKILL.md)" },
  hooks: { dir: "hooks", icon: "zap", leaf: (name, kind) => kind === vscode.FileType.File && /\.(kiro\.hook|json|md)$/i.test(name), desc: "agent hooks (.kiro.hook)" },
};

function homeUri() {
  // The workbench runs on the gateway host; its remote fs sees the same disk.
  // Derive $HOME from the workspace folder's path when it lives under /home or /local/home.
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const m = folder.uri.path.match(/^((?:\/local)?\/home\/[^/]+)(?:\/|$)/);
    if (m) return folder.uri.with({ path: m[1] });
  }
  return null; // a workspace outside any home: no global tier to show
}

class AssetTree {
  constructor(context, kind) {
    this.kind = kind;
    this.spec = ASSET_KINDS[kind];
    this._change = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._change.event;
    const watcher = vscode.workspace.createFileSystemWatcher("**/.kiro/" + this.spec.dir + "/**");
    context.subscriptions.push(watcher, watcher.onDidChange(() => this.refresh()), watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()));
  }
  refresh() { this._change.fire(); }
  roots() {
    const out = [];
    for (const folder of vscode.workspace.workspaceFolders || []) out.push({ label: "Workspace", uri: vscode.Uri.joinPath(folder.uri, ".kiro", this.spec.dir), scope: "workspace" });
    const home = homeUri();
    if (home) out.push({ label: "Global (~/.kiro)", uri: vscode.Uri.joinPath(home, ".kiro", this.spec.dir), scope: "global" });
    return out;
  }
  async listDir(uri, depth) {
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(uri); } catch { return []; }
    const items = [];
    for (const [name, kind] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      if (name.startsWith(".")) continue;
      const child = vscode.Uri.joinPath(uri, name);
      if (this.kind === "skills") {
        if (kind !== vscode.FileType.Directory) continue;
        const skill = vscode.Uri.joinPath(child, "SKILL.md");
        let ok = true;
        try { await vscode.workspace.fs.stat(skill); } catch { ok = false; }
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(ok ? "tools" : "warning");
        item.description = ok ? "" : "no SKILL.md";
        item.contextValue = "asset";
        item.command = { command: "kirocrew.openFile", title: "Open", arguments: [ok ? skill : child] };
        items.push(item);
        continue;
      }
      if (kind === vscode.FileType.Directory && depth < STEERING_MAX_DEPTH) {
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = "asset-dir";
        item.dirUri = child;
        item.depth = depth + 1;
        items.push(item);
      } else if (this.spec.leaf(name, kind) && kind === vscode.FileType.File) {
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(this.spec.icon);
        item.contextValue = "asset";
        item.command = { command: "kirocrew.openFile", title: "Open", arguments: [child] };
        items.push(item);
      }
    }
    return items;
  }
  async getChildren(node) {
    if (!node) {
      const roots = this.roots();
      if (!roots.length) return [new vscode.TreeItem("Open a folder to see its .kiro/" + this.spec.dir)];
      const out = [];
      for (const root of roots) {
        const item = new vscode.TreeItem(root.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = root.uri.path.replace(/^\/local(\/home)/, "$1");
        item.iconPath = new vscode.ThemeIcon(root.scope === "workspace" ? "root-folder" : "home");
        item.contextValue = "asset-root-" + root.scope;
        item.dirUri = root.uri;
        item.depth = 0;
        out.push(item);
      }
      return out;
    }
    if (node.dirUri) {
      const items = await this.listDir(node.dirUri, node.depth || 0);
      if (!items.length && node.depth === 0) {
        const empty = new vscode.TreeItem("none yet — " + this.spec.desc);
        empty.iconPath = new vscode.ThemeIcon("info");
        return [empty];
      }
      return items;
    }
    return [];
  }
  getTreeItem(item) { return item; }
}

const HOOK_TEMPLATE = (name) => JSON.stringify({
  enabled: true,
  name,
  description: "Describe when this hook fires and what the agent should do.",
  version: "1",
  when: { type: "fileEdited", patterns: ["src/**/*.py"] },
  then: { type: "askAgent", prompt: "A source file was saved. Review the change and update the matching tests if needed." },
}, null, 2) + "\n";

const STEERING_TEMPLATE = (title) => "---\ninclusion: always\n---\n# " + title + "\n\nGuidance the agent follows in every session of this workspace. Keep it short and specific:\n\n- Convention one\n- Convention two\n";
const SKILL_TEMPLATE = (name) => "---\nname: " + name + "\ndescription: One line on when this skill applies (the agent picks skills by this description).\nversion: 1.0.0\n---\n\n# " + name + "\n\nStep-by-step instructions the agent follows when this skill is active.\n";

async function newAsset(kind, scopeFolders) {
  const spec = ASSET_KINDS[kind];
  const roots = [];
  for (const folder of scopeFolders) roots.push({ label: "$(root-folder) Workspace  " + folder.uri.path, uri: vscode.Uri.joinPath(folder.uri, ".kiro", spec.dir) });
  const home = homeUri();
  if (home) roots.push({ label: "$(home) Global  ~/.kiro/" + spec.dir, uri: vscode.Uri.joinPath(home, ".kiro", spec.dir) });
  if (!roots.length) return vscode.window.showErrorMessage("Open a folder first.");
  const where = roots.length === 1 ? roots[0] : await vscode.window.showQuickPick(roots, { placeHolder: "Where should it live?" });
  if (!where) return;
  const name = await vscode.window.showInputBox({ prompt: kind === "skills" ? "Skill name (kebab-case folder)" : kind === "hooks" ? "Hook name (kebab-case)" : "Steering file name (kebab-case)", validateInput: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "lowercase letters, digits and dashes" });
  if (!name) return;
  await vscode.workspace.fs.createDirectory(where.uri);
  let file;
  let body;
  if (kind === "skills") {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(where.uri, name));
    file = vscode.Uri.joinPath(where.uri, name, "SKILL.md");
    body = SKILL_TEMPLATE(name);
  } else if (kind === "hooks") {
    file = vscode.Uri.joinPath(where.uri, name + ".kiro.hook");
    body = HOOK_TEMPLATE(name);
  } else {
    file = vscode.Uri.joinPath(where.uri, name + ".md");
    body = STEERING_TEMPLATE(name.replace(/-/g, " "));
  }
  try { await vscode.workspace.fs.stat(file); return vscode.window.showWarningMessage(file.path + " already exists."); } catch { /* new */ }
  await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(body));
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ------------------------------------------------------------ spec model

const SPEC_FILES = ["requirements.md", "design.md", "tasks.md"];

/** The whole file as text, or null when it cannot be read. Not `readText`: that
 *  one (above) clips to a context budget, and a second function of the same
 *  name hoisted over it, so every `#File` / `#Spec` / steering pick went to
 *  the host unclipped — a 51 KB requirements.md came back as
 *  "content exceeds 40000 char limit". */
async function readWholeText(uri) {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return null; }
}

// ------------------------------------------------------------ tasks.md grammar
//
// A port of the grammar Kiro's engine (@kiro/agent) reads and writes, so the
// IDE sees exactly the tasks Kiro's Task Orchestrator will run and the
// statuses it writes back: `- [ ]` not started, `- [~]` queued, `- [-]` in
// progress, `- [x]` completed; a `*` right after the box marks an optional
// task (skipped by "run all" unless made required); `1.` / `1.2` numbering
// builds the hierarchy (a sub-task belongs to the task whose number is its
// prefix), unnumbered tasks nest by indent; the lines under a task until the
// next task are its details (`_Requirements: …_` and the like). A task's id is
// its full text after the box — the `taskId` Kiro's tools expect.

const TASK_STATUS_MARKS = { " ": "not_started", "~": "queued", "-": "in_progress", "x": "completed" };

/** One line of tasks.md: Kiro's `- [x]* 1.2 Title` shape, or `{isTask: false}`. */
function parseTaskLine(line) {
  const m = String(line).match(/^(\s*)([-*+])\s+\[([ xX\-~])\](\\?\*?)\s+(.+)$/);
  if (!m) return { isTask: false };
  const text = m[5];
  return { isTask: true, indent: m[1].length, status: TASK_STATUS_MARKS[m[3].toLowerCase()] || "not_started", text, number: taskNumberOf(text), optional: m[4] === "*" || m[4] === "\\*" };
}

/** `1.2 Title` / `1. Title` → "1.2" / "1"; null when the task is unnumbered. */
function taskNumberOf(text) {
  const m = text.match(/^(\d+(?:\.\d+)*)\s/) || text.match(/^(\d+(?:\.\d+)*)\./);
  return m ? m[1] : null;
}

function parseTaskAt(lines, start, level) {
  const info = parseTaskLine(lines[start]);
  const task = { id: info.text, text: info.text, number: info.number, status: info.status, optional: info.optional, indent: info.indent, startLine: start, endLine: start + 1, content: "", subTasks: [], level };
  let i = start + 1;
  const body = [];
  let lastText = -1;
  while (i < lines.length) {
    const line = lines[i];
    const sub = parseTaskLine(line);
    const indent = (line.match(/^(\s*)/) || ["", ""])[1].length;
    if (info.number) {
      if (sub.isTask) break; // numbered tasks: the hierarchy is in the numbers, so any task line ends this one
    } else {
      if (line.trim() !== "" && indent <= info.indent) break;
      if (sub.isTask) {
        const child = parseTaskAt(lines, i, level + 1);
        task.subTasks.push(child.task);
        i = child.nextIndex;
        continue;
      }
    }
    if (line.trim() !== "") {
      body.push(line.substring(Math.min(indent, info.indent + 2)));
      lastText = body.length - 1;
    } else if (lastText !== -1) {
      body.push("");
    }
    i += 1;
  }
  while (body.length && body[body.length - 1] === "") body.pop();
  if (body.length) task.content = body.join("\n");
  task.endLine = i;
  return { task, nextIndex: i };
}

/** Numbered tasks: hang every `N.M` under `N`; the roots are the level-1 numbers plus orphans and unnumbered tasks. */
function buildNumberedTree(entries) {
  const roots = [];
  const byNumber = new Map();
  const orphans = new Set();
  const depth = (n) => n.split(".").length;
  const numbered = entries.filter((e) => e.task.number !== null)
    .sort((a, b) => depth(a.task.number) - depth(b.task.number) || a.task.number.localeCompare(b.task.number, undefined, { numeric: true }));
  for (const { task } of numbered) {
    task.level = depth(task.number);
    task.subTasks = [];
    byNumber.set(task.number, task);
    if (task.level > 1) {
      const parent = byNumber.get(task.number.slice(0, task.number.lastIndexOf(".")));
      if (parent) parent.subTasks.push(task); else orphans.add(task.number);
    }
  }
  for (const { task } of entries) {
    if (task.number === null) roots.push(task);
    else if (depth(task.number) === 1 || orphans.has(task.number)) roots.push(task);
  }
  return roots;
}

/** tasks.md → Kiro's task tree (root tasks with `subTasks`), in document order. */
function parseTaskTree(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    if (parseTaskLine(lines[i]).isTask) {
      const { task, nextIndex } = parseTaskAt(lines, i, 1);
      entries.push({ task, lineIndex: i });
      i = nextIndex;
    } else i += 1;
  }
  return entries.some((e) => e.task.number !== null) ? buildNumberedTree(entries) : entries.map((e) => e.task);
}

/** Depth-first walk of a task tree. */
function walkTasks(tasks, fn) {
  for (const task of tasks || []) { fn(task); walkTasks(task.subTasks, fn); }
}

/** The task whose id (full text) or line matches, anywhere in the tree. */
function findTask(tasks, idOrLine) {
  let hit = null;
  walkTasks(tasks, (t) => { if (!hit && (t.id === idOrLine || t.startLine === idOrLine)) hit = t; });
  return hit;
}

/**
 * The flat, document-ordered view the Specs tree and the editor rows use:
 * `{ id, number, title, line, indent, status, done, partial, queued, optional, leaf }`.
 * `title` is the text without its number; `partial` is Kiro's in-progress mark.
 */
function flattenTasks(tree) {
  const out = [];
  walkTasks(tree, (t) => {
    const title = t.number ? t.text.replace(/^\d+(?:\.\d+)*\.?\s*/, "") : t.text;
    out.push({ id: t.id, number: t.number || "", title: title.trim(), line: t.startLine, indent: t.indent, status: t.status, done: t.status === "completed", partial: t.status === "in_progress", queued: t.status === "queued", optional: t.optional, leaf: t.subTasks.length === 0 });
  });
  return out.sort((a, b) => a.line - b.line);
}

/** Parse tasks.md into the flat view (see `flattenTasks`). */
function parseTasks(text) {
  return flattenTasks(parseTaskTree(text));
}

/** Kiro's `<task>` block for one task: status, details, required sub-tasks — what its engine hands the executor. */
function serializeTask(task) {
  const parts = ['<task title="' + task.text + '">'];
  parts.push("Status: " + (task.status === "completed" ? "done" : task.status === "in_progress" ? "in progress" : "not started"));
  if (task.content) parts.push("Task details:\n" + task.content);
  const subs = (task.subTasks || []).filter((s) => !s.optional).map(serializeTask);
  if (subs.length) parts.push("Subtasks:\n\n" + subs.join("\n\n"));
  parts.push("</task>");
  return parts.join("\n\n");
}

/** Kiro's "make all required": drop every optional `*` mark so "run all" picks those tasks up too. */
function makeAllTasksRequired(text) {
  return String(text).replace(/\[([ xX\-~])\](\\?\*)/g, "[$1]");
}

async function listSpecs() {
  const folders = vscode.workspace.workspaceFolders || [];
  const specs = [];
  for (const folder of folders) {
    const root = vscode.Uri.joinPath(folder.uri, ".kiro", "specs");
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(root); } catch { continue; }
    for (const [name, kind] of entries) {
      if (kind !== vscode.FileType.Directory) continue;
      const dir = vscode.Uri.joinPath(root, name);
      const present = {};
      for (const file of SPEC_FILES) present[file] = (await readWholeText(vscode.Uri.joinPath(dir, file))) !== null;
      const tasksText = await readWholeText(vscode.Uri.joinPath(dir, "tasks.md"));
      const taskTree = parseTaskTree(tasksText);
      specs.push({ name, dir, present, tasks: flattenTasks(taskTree), taskTree, tasksText: tasksText || "", workspace: folder });
    }
  }
  return specs;
}

class SpecsTree {
  constructor(context) {
    this._change = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._change.event;
    const watcher = vscode.workspace.createFileSystemWatcher("**/.kiro/specs/**");
    context.subscriptions.push(watcher, watcher.onDidChange(() => this._change.fire()), watcher.onDidCreate(() => this._change.fire()), watcher.onDidDelete(() => this._change.fire()));
  }
  refresh() { this._change.fire(); }
  async getChildren(node) {
    if (!node) {
      const specs = await listSpecs();
      if (!specs.length) {
        const item = new vscode.TreeItem("No specs — create one with ＋ (writes .kiro/specs/<name>/)");
        item.contextValue = "empty";
        return [item];
      }
      return specs.map((spec) => {
        const done = spec.tasks.filter((t) => t.done).length;
        const item = new vscode.TreeItem(spec.name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = "spec";
        item.spec = spec;
        const phase = !spec.present["requirements.md"] ? "needs requirements" : !spec.present["design.md"] ? "needs design" : !spec.present["tasks.md"] ? "needs tasks" : done + "/" + spec.tasks.length + " tasks";
        item.description = phase;
        item.iconPath = new vscode.ThemeIcon("notebook");
        return item;
      });
    }
    if (node.contextValue === "spec") {
      const spec = node.spec;
      const files = SPEC_FILES.map((file) => {
        const item = new vscode.TreeItem(file.replace(".md", ""), vscode.TreeItemCollapsibleState.None);
        item.contextValue = spec.present[file] ? "specfile" : "specfile-missing";
        item.iconPath = new vscode.ThemeIcon(spec.present[file] ? "file" : "circle-outline");
        item.description = spec.present[file] ? "" : "not written";
        item.command = spec.present[file]
          ? { command: "kirocrew.spec.open", title: "Open", arguments: [vscode.Uri.joinPath(spec.dir, file)] }
          : { command: "kirocrew.spec." + file.replace(".md", ""), title: "Write", arguments: [node] };
        return item;
      });
      const tasks = spec.tasks.map((task) => {
        const label = (task.number ? task.number + " " : "") + task.title;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        // Kiro's four states: the orchestrator writes `[~]` when it queues a task and `[-]` while it runs.
        item.contextValue = task.done ? "task-done" : task.partial ? "task-running" : "task-open";
        item.iconPath = new vscode.ThemeIcon(task.done ? "pass-filled" : task.partial ? "loading~spin" : task.queued ? "clock" : "circle-large-outline");
        item.spec = spec;
        item.task = task;
        item.description = task.partial ? "in progress" : task.queued ? "queued" : task.optional ? "optional" : undefined;
        item.command = { command: "kirocrew.spec.open", title: "Open", arguments: [vscode.Uri.joinPath(spec.dir, "tasks.md"), task.line] };
        return item;
      });
      return files.concat(tasks);
    }
    return [];
  }
  getTreeItem(item) { return item; }
}

// ----------------------------------------------------------- spec prompts

function relPath(uri, workspace) {
  return uri.path.startsWith(workspace.uri.path) ? uri.path.slice(workspace.uri.path.length + 1) : uri.path;
}

const SPEC_RULES =
  "You are executing the Kiro spec-driven workflow for the spec at {dir} (paths relative to the workspace root {root}). " +
  "The three artifacts are requirements.md (user stories with acceptance criteria in EARS form: WHEN/IF … THEN the system SHALL …), " +
  "design.md (architecture, components, data models, error handling, testing strategy, each requirement traced), and tasks.md " +
  "(an implementation plan as a numbered markdown checkbox list `- [ ] N. title` with sub-tasks `- [ ] N.M …` and a `_Requirements: …_` line each). " +
  "Work directly in the workspace files; keep edits minimal and scoped; do not restart earlier phases.";

function phasePrompt(phase, spec, extra) {
  const dir = ".kiro/specs/" + spec.name;
  const rules = SPEC_RULES.replace("{dir}", dir).replace("{root}", spec.workspace.uri.path);
  if (phase === "requirements") {
    return rules + "\n\nPHASE: REQUIREMENTS. Write or refine " + dir + "/requirements.md for this feature: " + (extra || "(see the existing draft)") +
      ". Cover every user-facing behaviour and edge case as numbered requirements with EARS acceptance criteria. Do not write design or tasks yet. When the file is written, summarise the requirements list.";
  }
  if (phase === "design") {
    return rules + "\n\nPHASE: DESIGN. Read " + dir + "/requirements.md and write " + dir + "/design.md: overview, architecture, components and interfaces, data models, error handling, testing strategy, and a requirement-to-design traceability list. Investigate the codebase first so the design fits what exists. Do not write tasks yet.";
  }
  if (phase === "tasks") {
    return rules + "\n\nPHASE: TASKS. Read " + dir + "/requirements.md and " + dir + "/design.md and write " + dir + "/tasks.md: a numbered checkbox implementation plan of small, verifiable coding tasks in dependency order, each with a `_Requirements:` trace line, ending in wiring/integration tasks so nothing is left dangling. Every task must be something an agent can do by editing code and running tests.";
  }
  throw new Error("unknown phase " + phase);
}

/** Absolute path of a spec's tasks.md, as Kiro's engine names it in its requests. */
function tasksPathOf(spec) {
  const dir = (spec.dir && spec.dir.path) || (spec.workspace.uri.path + "/.kiro/specs/" + spec.name);
  return dir + "/tasks.md";
}

/**
 * Task requests, in two flavours.
 *
 * With a Kiro Spec & Plan agent (the KAS backend runs Kiro's own Spec agent),
 * the message is the one Kiro's IDE itself sends its engine — read from
 * @kiro/agent's `handleSpecExecuteTask` / `handleSpecRunAllTasks` — so the
 * engine's spec sub-intent router ("execute the following task", "run all
 * tasks" are in its local pattern list) hands the turn to its Task
 * Orchestrator, which queues every not-started required task, runs them
 * through its task-execution sub-agent one after another without stopping,
 * and writes `[~]` / `[-]` / `[x]` back into tasks.md as it goes.
 *
 * Without one, a paraphrase on the crew agent carries the same `<task>` block
 * and asks for the same non-stop loop.
 */
function kiroTaskRequest(spec, task) {
  const path = tasksPathOf(spec);
  return "Execute the following task from the spec at " + path + ":\n\n" + serializeTask(task) + "\n\nTask ID: " + task.id + "\nSpec path: " + path;
}

function kiroRunAllRequest(spec) {
  const done = [];
  walkTasks(spec.taskTree || [], (t) => { if (t.status === "completed") done.push(t.id); });
  let text = "Run all tasks for this spec.";
  if (done.length) text += " Resume from prior progress: tasks [" + done.join(", ") + "] are already completed (per tasks.md). Skip them and continue from the next ready task.";
  return text;
}

function taskPrompt(spec, task) {
  const dir = ".kiro/specs/" + spec.name;
  const rules = SPEC_RULES.replace("{dir}", dir).replace("{root}", spec.workspace.uri.path);
  const full = (spec.taskTree && findTask(spec.taskTree, task.id || task.line)) || { text: (task.number ? task.number + " " : "") + task.title, id: task.id || task.title, status: task.status || "not_started", content: "", subTasks: [], optional: Boolean(task.optional) };
  return rules + "\n\nPHASE: EXECUTE ONE TASK. Read " + dir + "/requirements.md, " + dir + "/design.md and " + dir + "/tasks.md, then implement exactly this task and nothing else:\n\n" + serializeTask(full) +
    "\n\nMark it `- [-]` in " + dir + "/tasks.md when you start and `- [x]` when it is done and verified by the project's build/tests; if the change is complete, commit it with a conventional-commit message. Stop after this task; do not start the next one.";
}

function runAllPrompt(spec) {
  const dir = ".kiro/specs/" + spec.name;
  const rules = SPEC_RULES.replace("{dir}", dir).replace("{root}", spec.workspace.uri.path);
  return rules + "\n\nPHASE: EXECUTE REMAINING TASKS. " + kiroRunAllRequest(spec) + " Read " + dir + "/requirements.md, " + dir + "/design.md and " + dir + "/tasks.md. Work through every unchecked required task in order (skip tasks marked optional with `*`), one at a time and without stopping to ask between them: mark it `- [-]` in tasks.md when you start, implement, verify with the build/tests, mark it `- [x]`, commit, then continue to the next. If a task is blocked, record why under it in tasks.md and move on. Stop when every task is ticked or blocked, then summarise.";
}

// ------------------------------------------------------------- workflows

/**
 * Chat workflows, the "mode" picker under the composer — the same five Kiro
 * IDE offers. KiroCrew has no spec agent and no per-session system prompt, so
 * a workflow is a background-context frame the host prepends to every turn
 * sent while the mode is on (see Sessions.inject): the agent gets the
 * procedure, the transcript shows only what the user typed. `Default` injects
 * nothing.
 */
const WORKFLOWS = [
  { id: "default", label: "Default", description: "General coding assistance" },
  { id: "spec", label: "Spec", description: "Structured feature development" },
  { id: "quick-spec", label: "Quick Spec", description: "Fast spec workflow: clarify, then auto-generate requirements, design, and tasks" },
  { id: "bug-fix", label: "Bug Fix", description: "Structured bug-fix workflow: investigate, diagnose, and resolve bugs" },
  { id: "plan", label: "Plan", description: "Plan-only mode that helps break ideas down into an implementation plan without making any changes" },
];

const SPEC_SHAPE =
  "Specs live at <workspace>/.kiro/specs/<kebab-name>/ with three files: requirements.md (introduction, then numbered requirements, " +
  "each a user story `As a …, I want …, so that …` followed by acceptance criteria in EARS form: `WHEN/IF … THEN the system SHALL …`), " +
  "design.md (overview, architecture, components and interfaces, data models, error handling, testing strategy; every requirement traced), " +
  "and tasks.md (a numbered markdown checkbox plan `- [ ] N. title` with sub-tasks `- [ ] N.M …` and a `_Requirements: …_` line each; " +
  "coding tasks only, small and verifiable, in dependency order).";

function workflowContext(mode, root) {
  const where = root ? " The workspace root is " + root + "." : "";
  switch (mode) {
    case "spec":
      return "WORKFLOW: SPEC (Kiro spec-driven development)." + where + " " + SPEC_SHAPE +
        " Proceed one phase at a time and STOP for the user's explicit approval between phases: (1) if no spec exists for the idea, choose a kebab-case name and write requirements.md, then ask " +
        "\"Do the requirements look good? If so, we can move on to the design.\"; (2) after approval write design.md (research as needed, no code), then ask for approval; (3) after approval write tasks.md, " +
        "then ask for approval. Never write design or tasks before the previous file is approved; never implement code during these phases. Revise a file when the user asks for changes, then ask again. " +
        "If a spec already exists, continue from its first missing or last unapproved phase. Once all three exist and are approved, offer to execute tasks one at a time from tasks.md, ticking `- [x]` when a task is verified.";
    case "quick-spec":
      return "WORKFLOW: QUICK SPEC." + where + " " + SPEC_SHAPE +
        " Ask at most one short round of clarifying questions only if the idea is genuinely ambiguous; otherwise proceed. Then, without further pauses, write all three files " +
        "(requirements.md, design.md, tasks.md) for the idea under a kebab-case spec name, and finish with a brief summary of the spec and the first task. Do not implement code.";
    case "bug-fix":
      return "WORKFLOW: BUG FIX." + where +
        " Work in four explicit stages and label each in your reply: (1) REPRODUCE — restate the bug, find the code path, and reproduce it with a failing test or a concrete command; " +
        "(2) DIAGNOSE — locate the root cause with evidence (read code, run it), and explain why it happens; do not patch symptoms; " +
        "(3) FIX — make the minimal change that removes the root cause, keeping the failing test as the regression test; " +
        "(4) VERIFY — run the project's build and tests and report the exact output. Stop and ask before any change with a wide blast radius.";
    case "plan":
      return "WORKFLOW: PLAN (read-only)." + where +
        " Do NOT create, edit, delete or move any file and do NOT run commands that change state; reading files and running read-only inspection commands is fine. " +
        "Investigate as needed, then produce an implementation plan: goal, assumptions, the files to touch, ordered steps, risks and how to verify. Ask clarifying questions when the idea is ambiguous. " +
        "End by offering to switch to Spec or Default mode to carry the plan out.";
    default:
      return "";
  }
}

/**
 * The Kiro Spec & Plan mod (kiro-spec-plan) ships agents named after Kiro's
 * bundled mode ids; on the KAS backend picking one runs Kiro's OWN workflow.
 * When such an agent exists for the chosen mode, the tab uses it and the
 * prompt frame above is not injected — the real thing beats the paraphrase.
 * Pure: returns the agent name, or null to fall back to the frame.
 */
const MODE_AGENTS = { spec: "spec", "quick-spec": "quick-spec", "bug-fix": "bug-fix", plan: "plan" };
/**
 * KiroCrew 0.8.0.9 reserves KAS's bundled mode ids (`agent_files.KAS_RESERVED_AGENT_IDS`)
 * and refuses, before the wire, any session whose agent carries one — the
 * protection against a crewmate being silently replaced by a built-in is
 * exactly the substitution kiro-spec-plan's handles rely on. The refusal text
 * is the host's; matched loosely so a reworded message still counts.
 */
function isReservedModeRefusal(message) {
  const m = String(message || "");
  return /reserved for a built-in agent/i.test(m) || /reserved by the KAS agent engine/i.test(m) || /template_name_reserved_by_engine/.test(m);
}

/** A host failure row: the `error` role the session log writes, or the
 *  dashboard's `msg-err` class / ❌ ⏱ prefix on an assistant row. */
function isErrorRow(row) {
  if (!row) return false;
  if (row.role === "error") return true;
  return row.role === "assistant" && (/\bmsg-err\b/.test(row.cls || "") || /^\s*[❌⏱]/.test(row.content || ""));
}
function kasAgentFor(mode, agents) {
  const name = MODE_AGENTS[mode];
  if (!name) return null;
  return (agents || []).some((a) => a && a.name === name) ? name : null;
}

/**
 * What a live slot reports it runs with, in the composer's own keys. Only the
 * fields the slot carries are present, so the result can be laid over the
 * user's picks for display without inventing values.
 */
function liveSettings(slot) {
  const live = {};
  if (slot.model !== undefined && slot.model !== null) live.model = slot.model || "";
  if (slot.reasoning_effort !== undefined && slot.reasoning_effort !== null) live.effort = slot.reasoning_effort || "";
  if (slot.trust !== undefined && slot.trust !== null) live.autopilot = Boolean(slot.trust);
  if (slot.agent && slot.agent !== "default") live.agent = slot.agent;
  return live;
}

/** The mode a Kiro Spec & Plan agent name stands for, or null for an ordinary agent. */
function modeOfAgent(name) {
  return Object.keys(MODE_AGENTS).find((m) => MODE_AGENTS[m] === name) || null;
}

/** The mod that ships Kiro's mode agents; named in the picker when they are missing. */
const MODES_MOD = "kiro-spec-plan";
const MODES_HINT = {
  id: "hint:" + MODES_MOD,
  label: "Kiro's own modes: install " + MODES_MOD,
  description: "Spec, Quick Spec, Bug Fix and Plan below are prompt-guided stand-ins on your default agent. The " + MODES_MOD +
    " mod adds Kiro's real mode agents; install it from the FloofyCrew page (or `floofy install " + MODES_MOD + "`) and reopen this menu.",
  section: "Workflows (prompt-guided)",
  hint: true,
};

/**
 * The single Agent picker, sectioned like Kiro's: Kiro's own modes when the
 * Kiro Spec & Plan agents are installed, else the prompt-guided workflows
 * headed by a row that says where the real ones come from; then the crew
 * default and every other agent. Each entry's id encodes the kind so the
 * webview stays dumb: `agent:<name>`, `workflow:<mode>`, `hint:<mod>`, or "".
 */
function agentPicks(agents) {
  const kiro = WORKFLOWS.filter((w) => w.id !== "default" && kasAgentFor(w.id, agents));
  const out = [];
  if (kiro.length) {
    for (const w of kiro) out.push({ id: "agent:" + MODE_AGENTS[w.id], label: w.label, description: w.description, section: "Kiro modes", kiro: true });
  } else {
    out.push(MODES_HINT);
    for (const w of WORKFLOWS) if (w.id !== "default") out.push({ id: "workflow:" + w.id, label: w.label, description: w.description, section: MODES_HINT.section });
  }
  out.push({ id: "", label: "Default", description: "the crew default agent — general coding assistance", section: "Your agents" });
  for (const a of agents || []) {
    if (modeOfAgent(a.name) || /^kirocrew(-lite|-skill-view-)/.test(a.name)) continue;
    out.push({ id: "agent:" + a.name, label: a.name, description: a.description || a.model || "", section: "Your agents" });
  }
  return out;
}

/** `[OPTIONS: a | b | c]` on its own line at the end of an assistant message → labels; the line is stripped for display. */
function splitOptions(text) {
  const m = /\n?\s*\[OPTIONS:\s*([^\]]*)\]\s*$/.exec(text || "");
  if (!m) return { text: text || "", options: [] };
  const options = m[1].split("|").map((s) => s.trim()).filter(Boolean);
  return { text: (text || "").slice(0, m.index).replace(/\s+$/, ""), options };
}

// ------------------------------------------------------------ spec editor

const STAGES = [
  { file: "requirements.md", label: "Requirements", n: 1 },
  { file: "design.md", label: "Design", n: 2 },
  { file: "tasks.md", label: "Task list", n: 3 },
];

function stageOf(uriPath) {
  const name = uriPath.split("/").pop();
  const index = STAGES.findIndex((s) => s.file === name);
  return index < 0 ? null : { ...STAGES[index], index };
}

function specNameOf(uriPath) {
  const m = uriPath.match(/\.kiro\/specs\/([^/]+)\//);
  return m ? m[1] : "spec";
}

/** Minimal markdown → HTML for the spec docs: headings, fences, lists (with checkboxes), bold/italic/inline code, quotes, rules. */
/**
 * Markdown -> HTML for assistant replies and spec documents. GFM-shaped, the
 * subset current models actually emit: ATX headings, paragraphs (soft wraps
 * joined, two trailing spaces or a backslash break), fenced code with a
 * language label and a copy button, blockquotes, nested ordered and bulleted
 * lists with task boxes, pipe tables with alignment, rules, bold, italic,
 * strikethrough, inline code, links, autolinked URLs, and local file paths
 * (`src/a.py:42`, also inside inline code) as anchors the host opens in the
 * editor. Everything is HTML-escaped; no raw HTML passes through.
 *
 * SELF-CONTAINED ON PURPOSE: it references nothing outside itself, so
 * `mdToHtml.toString()` is embedded in the chat webview and the spec editor
 * renders with the very same function extension-side. Anchors carry
 * `data-url` (open externally) or `data-path`/`data-line`/`data-col` (open in
 * the editor); the host page delegates the clicks.
 */
function mdToHtml(md) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const PATH = /(?<![\w@:/.-])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w-]+(?:\.[\w-]+)*|[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|toml|yaml|yml|sh|css|html|go|rs|java|kt|c|h|cpp|hpp|txt|ini|cfg|lock))(?::(\d+))?(?::(\d+))?(?![\w/])/g;
  const isPath = (p) => !/^https?:/.test(p) && !p.endsWith("/") && !p.endsWith(".") && !/^[\d.]+$/.test(p.replace(/\//g, ""));
  const pathAnchor = (raw, p, line, col) => '<a class="path" data-path="' + esc(p) + '"' + (line ? ' data-line="' + line + '"' : "") + (col ? ' data-col="' + col + '"' : "") + ' title="Open ' + esc(p) + '">' + esc(raw) + "</a>";
  // Plain text: escape, then turn file paths into anchors.
  const text = (t) => {
    let out = "", last = 0;
    for (const m of t.matchAll(PATH)) {
      if (!isPath(m[1])) continue;
      out += esc(t.slice(last, m.index)) + pathAnchor(m[0], m[1], m[2], m[3]);
      last = m.index + m[0].length;
    }
    return out + esc(t.slice(last));
  };
  const codeSpan = (t) => {
    const m = t.match(/^\s*((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.\w+|(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w-]+(?:\.[\w-]+)*)(?::(\d+))?(?::(\d+))?\s*$/);
    return "<code>" + (m && isPath(m[1]) ? pathAnchor(t, m[1], m[2], m[3]) : esc(t)) + "</code>";
  };
  // Inline: pull code spans and links out first so their contents are never re-marked.
  const inline = (t) => {
    const slots = [];
    const hold = (html) => { slots.push(html); return "\u0000" + (slots.length - 1) + "\u0000"; };
    let s = t.replace(/`([^`\n]+)`/g, (_, c) => hold(codeSpan(c)));
    s = s.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
      if (/^https?:\/\//.test(url) || /^mailto:/.test(url)) return hold('<a class="link" data-url="' + esc(url) + '" title="' + esc(url) + '">' + esc(label || url) + "</a>");
      const pm = url.match(/^([^:#]+)(?::(\d+))?(?::(\d+))?$/);
      return hold(pm ? pathAnchor(label || url, pm[1], pm[2], pm[3]) : esc(label || url));
    });
    s = s.replace(/(?<![\w"=/])(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])/g, (u) => hold('<a class="link" data-url="' + esc(u) + '">' + esc(u) + "</a>"));
    // Escape the prose and hold each file-path anchor too, so `__init__.py` is never read as emphasis.
    s = s.split(/(\u0000\d+\u0000)/).map((part) => /^\u0000\d+\u0000$/.test(part) ? part : text(part).replace(/<a class="path"[^>]*>[^<]*<\/a>/g, (a) => hold(a))).join("");
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<em>$1</em>")
      .replace(/(?<![\w_])__([^_\n]+)__(?![\w_])/g, "<strong>$1</strong>")
      .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<em>$1</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/ {2,}$|\\$/gm, "<br>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  };

  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const flushPara = (buf) => { if (buf.length) out.push("<p>" + inline(buf.join("\n")) + "</p>"); buf.length = 0; };
  const para = [];
  // Lists: a stack of {indent, ordered}; an item's continuation lines are indented past its marker.
  const listStack = [];
  const closeLists = (toIndent) => {
    while (listStack.length && (toIndent === undefined || listStack[listStack.length - 1].indent >= toIndent)) {
      out.push(listStack.pop().ordered ? "</li></ol>" : "</li></ul>");
    }
  };
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("-");
  const splitRow = (l) => { let s = l.trim(); if (s.startsWith("|")) s = s.slice(1); if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1); return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")); };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushPara(para); closeLists();
      const close = fence[1][0].repeat(fence[1].length);
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(close)) { body.push(lines[i]); i += 1; }
      i += 1; // the closing fence (or EOF)
      const lang = fence[2] ? esc(fence[2]) : "";
      out.push('<div class="codeblock"><div class="codebar"><span class="lang">' + (lang || "text") + '</span><button class="copy" type="button" title="Copy">Copy</button></div><pre><code' + (lang ? ' class="lang-' + lang + '"' : "") + ">" + esc(body.join("\n")) + "</code></pre></div>");
      continue;
    }
    if (!line.trim()) { flushPara(para); closeLists(); i += 1; continue; }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flushPara(para); closeLists(); out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i += 1; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(para); closeLists(); out.push("<hr>"); i += 1; continue; }
    if (/^\s*>/.test(line)) {
      flushPara(para); closeLists();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
      out.push("<blockquote>" + mdToHtml(q.join("\n")) + "</blockquote>");
      continue;
    }
    if (i + 1 < lines.length && line.includes("|") && isTableSep(lines[i + 1])) {
      flushPara(para); closeLists();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":")) ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
      const cell = (tag, c, k) => "<" + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline(c) + "</" + tag + ">";
      let html = "<table><thead><tr>" + head.map((c, k) => cell("th", c, k)).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { html += "<tr>" + splitRow(lines[i]).map((c, k) => cell("td", c, k)).join("") + "</tr>"; i += 1; }
      out.push(html + "</tbody></table>");
      continue;
    }
    const li = line.match(/^(\s*)(?:([-*+])|(\d{1,3})[.)])\s+(?:\[( |x|X|-|~)\](\\?\*)?\s+)?(.*)$/);
    if (li) {
      flushPara(para);
      const indent = li[1].length;
      const ordered = li[3] !== undefined;
      closeLists(indent + 1); // close deeper (and equal-indent siblings close their <li> below)
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        listStack.push({ indent, ordered });
        out.push(ordered ? "<ol" + (Number(li[3]) !== 1 ? ' start="' + Number(li[3]) + '"' : "") + ">" : "<ul>");
      } else {
        out.push("</li>");
      }
      // Task boxes in Kiro's four states (` ` open, `~` queued, `-` in progress, `x` done), `*` = optional;
      // each carries its source line so a tasks.md view can act on the row.
      const mark = li[4] === undefined ? null : li[4].toLowerCase();
      const state = mark === null ? "" : mark === "x" ? " on" : mark === "-" ? " part" : mark === "~" ? " queued" : " open";
      const glyph = mark === "x" ? "☑" : mark === "-" ? "◪" : mark === "~" ? "◷" : "☐";
      const box = mark === null ? "" : '<span class="box' + state + (li[5] ? " optional" : "") + '" data-line="' + i + '"' + (li[5] ? ' title="optional task"' : "") + ">" + glyph + "</span> ";
      // Continuation lines: indented past the marker, not a new item, not blank.
      const body = [li[6]];
      const markerWidth = li[1].length + (li[2] ? 2 : li[3].length + 2);
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(lines[i + 1]) && /^\s+/.test(lines[i + 1]) && lines[i + 1].search(/\S/) >= Math.min(markerWidth, indent + 2)) {
        body.push(lines[i + 1].trim()); i += 1;
      }
      out.push("<li>" + box + inline(body.join("\n")));
      i += 1;
      continue;
    }
    if (listStack.length && /^\s+/.test(line)) { // lazy continuation inside a list item
      out.push(" " + inline(line.trim())); i += 1; continue;
    }
    closeLists();
    para.push(line);
    i += 1;
  }
  flushPara(para); closeLists();
  return out.join("\n");
}

function specEditorHtml(specName, stage, present) {
  const crumbs = STAGES.map((s) => {
    const here = s.file === stage.file;
    const missing = !present[s.file];
    return "<button class='stage" + (here ? " on" : "") + (missing ? " missing" : "") + "' data-file='" + s.file + "'" + (missing ? " title='not written yet'" : "") + "><span class='n'>" + s.n + "</span>" + s.label + "</button>";
  }).join("<span class='sep'>›</span>");
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
 :root{color-scheme:light dark}
 body{margin:0;font:13px/1.55 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
 #banner{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-panel-border);z-index:2;flex-wrap:wrap}
 #banner .name{font-weight:600;margin-right:4px}
 .stage{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--vscode-button-secondaryBackground);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit}
 .stage.on{background:var(--vscode-button-secondaryBackground)}
 .stage.missing{opacity:.5}
 .stage .n{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:4px;padding:0 5px;font-size:11px}
 .sep{opacity:.4}
 #actions{margin-left:auto;display:flex;gap:8px}
 #actions button{border:0;border-radius:6px;padding:4px 12px;cursor:pointer;font:inherit;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 #actions #continue{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
 #doc{max-width:920px;margin:0 auto;padding:16px 22px 60px}
 #doc h1{font-size:1.5em}#doc h2{font-size:1.25em;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:4px}#doc h3{font-size:1.1em}
 #doc code{background:var(--vscode-textCodeBlock-background);border-radius:3px;padding:1px 5px;font-family:var(--vscode-editor-font-family)}
 #doc pre{background:var(--vscode-textCodeBlock-background);border-radius:6px;padding:10px 12px;overflow:auto}
 #doc pre code{background:transparent;padding:0}
 #doc .codeblock{margin:8px 0;border-radius:6px;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border)}#doc .codeblock pre{border-radius:0;margin:0}
 #doc .codebar{display:flex;justify-content:space-between;padding:2px 10px;font-size:11px;opacity:.7;border-bottom:1px solid var(--vscode-panel-border)}#doc .codebar .copy{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}
 #doc table{border-collapse:collapse;margin:8px 0;display:block;overflow:auto}#doc th,#doc td{border:1px solid var(--vscode-panel-border);padding:3px 8px;vertical-align:top}#doc th{background:var(--vscode-editorWidget-background)}
 #doc ol{padding-left:22px}#doc del{opacity:.7}#doc a.link,#doc a.path{color:var(--vscode-textLink-foreground);text-decoration:none;cursor:pointer}#doc a.link:hover,#doc a.path:hover{text-decoration:underline}
 #doc ul{padding-left:22px}#doc li{margin:2px 0}
 #doc blockquote{border-left:3px solid var(--vscode-focusBorder);margin:8px 0;padding:2px 12px;opacity:.85}
 .box{opacity:.8}.box.on{color:var(--vscode-charts-green,inherit)}.box.part{opacity:.6}.box.queued{opacity:.7}.box.optional{opacity:.55}
 .start{margin-left:8px;border:1px solid var(--vscode-button-secondaryBackground);background:transparent;color:var(--vscode-textLink-foreground);border-radius:4px;padding:0 7px;cursor:pointer;font:inherit;font-size:11px;line-height:18px;vertical-align:middle;opacity:.6}
 #doc li:hover>.start,.start:focus,.start:hover{opacity:1}
 .start.state{cursor:default;color:var(--vscode-descriptionForeground);border-color:transparent;opacity:1}
 .start.state.part::before{content:'';display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:var(--vscode-focusBorder);animation:kide-pulse 1.1s ease-in-out infinite;vertical-align:middle}
 @keyframes kide-pulse{0%,100%{opacity:.35}50%{opacity:1}}
 .path{opacity:.7;font-family:var(--vscode-editor-font-family);font-size:12px}
 #stale{display:none;position:sticky;top:44px;text-align:center;font-size:12px;padding:3px;background:var(--vscode-inputValidation-infoBackground);border-bottom:1px solid var(--vscode-inputValidation-infoBorder)}
</style></head><body>
<div id="noscript-hint" style="padding:10px 12px;font-size:12px;opacity:.7">Loading the spec editor&hellip; If this line never disappears, scripts inside webviews are blocked &mdash; screenshot this and report it. The markdown source is available via right-click &rarr; Reopen Editor With &rarr; Text Editor.</div>
<div id="banner"><span class="name">${specName}</span>${crumbs}
 <span id="actions"><button id="edit" title="Open the markdown source in a text editor">Edit source</button><button id="sync" title="Reload this document from disk">⟳ Sync Files</button><button id="continue" title="">→ Continue</button></span></div>
<div id="stale">updated on disk — synced</div>
<div id="doc"></div>
<script>
document.getElementById('noscript-hint').remove();
const vscode = acquireVsCodeApi();
const STAGE_FILE = ${JSON.stringify(stage.file)};
document.querySelectorAll('.stage').forEach(b=>b.onclick=()=>vscode.postMessage({type:'stage', file:b.dataset.file}));
document.addEventListener('click', (e)=>{ const a=e.target.closest && e.target.closest('a.path, a.link, button.copy, button.start'); if(!a) return; e.preventDefault();
  if(a.classList.contains('start')){ if(!a.classList.contains('state')) vscode.postMessage({type:'startTask', line:Number(a.dataset.line)}); return; }
  if(a.classList.contains('copy')){ const pre=a.closest('.codeblock').querySelector('pre'); vscode.postMessage({type:'copy', text: pre?pre.textContent:''}); a.textContent='Copied'; setTimeout(()=>{a.textContent='Copy';},1200); return; }
  if(a.dataset.url) vscode.postMessage({type:'link', url:a.dataset.url}); else vscode.postMessage({type:'open', path:a.dataset.path, line:a.dataset.line?Number(a.dataset.line):undefined, column:a.dataset.col?Number(a.dataset.col):undefined}); });
document.getElementById('sync').onclick=()=>vscode.postMessage({type:'sync'});
document.getElementById('continue').onclick=()=>vscode.postMessage({type:'continue'});
document.getElementById('edit').onclick=()=>vscode.postMessage({type:'edit'});
// tasks.md: like Kiro's IDE, every task row that is not done gets its own "Start task"
// (one task, one session); a queued or running row shows its state instead.
function decorateTasks(){
  if(STAGE_FILE!=='tasks.md') return;
  document.querySelectorAll('#doc .box[data-line]').forEach((box)=>{
    if(box.classList.contains('on')) return;
    const b=document.createElement('button'); b.type='button'; b.className='start'; b.dataset.line=box.dataset.line;
    if(box.classList.contains('part')){ b.classList.add('state','part'); b.textContent='In progress'; }
    else if(box.classList.contains('queued')){ b.classList.add('state','queued'); b.textContent='Queued'; }
    else { b.textContent='▶ Start task'; b.title='Run this task in its own KiroCrew session'; }
    const li=box.parentElement; const anchor=Array.from(li.children).find((c)=>c.tagName==='UL'||c.tagName==='OL');
    if(anchor) li.insertBefore(b, anchor); else li.appendChild(b);
  });
}
window.addEventListener('message',(e)=>{
  const m=e.data;
  if(m.type==='doc'){ document.getElementById('doc').innerHTML=m.html; decorateTasks(); if(m.synced){const s=document.getElementById('stale'); s.style.display='block'; setTimeout(()=>{s.style.display='none';},1500);} }
  if(m.type==='continueLabel'){ const b=document.getElementById('continue'); b.textContent='→ '+m.label; b.title=m.title||''; }
});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

/** What → Continue does from each stage; returns {label, run} resolved against the live spec state. */
function continueAction(stage, spec) {
  // A stage whose successor already exists OPENS it (no chat); a missing one is written by KiroCrew.
  if (stage.file === "requirements.md") {
    return spec.present["design.md"]
      ? { label: "Open design", command: "kirocrew.spec.open", open: "design.md" }
      : { label: "Write design", command: "kirocrew.spec.design" };
  }
  if (stage.file === "design.md") {
    return spec.present["tasks.md"]
      ? { label: "Open task list", command: "kirocrew.spec.open", open: "tasks.md" }
      : { label: "Write task list", command: "kirocrew.spec.tasks" };
  }
  // tasks.md: like Kiro's IDE, the document's primary action runs ALL remaining
  // required tasks in one go (one session, no stopping between tasks); a single
  // task is started from the ▶ on its own row. "Resume" once some are done.
  const tasks = spec.tasks || [];
  const leaves = tasks.filter((t) => t.leaf !== false && !t.optional);
  const remaining = leaves.filter((t) => !t.done);
  if (remaining.length) {
    const started = leaves.length > remaining.length || remaining.some((t) => t.partial || t.queued);
    return { label: (started ? "Resume tasks" : "Run all tasks") + " (" + remaining.length + " left)", command: "kirocrew.spec.runAll", remaining: remaining.length };
  }
  const optional = tasks.filter((t) => t.leaf !== false && t.optional && !t.done).length;
  if (optional) return { label: "Run optional tasks (" + optional + ")", command: "kirocrew.spec.runAllOptional", remaining: optional };
  return { label: "All tasks done", command: null };
}

class SpecEditorProvider {
  constructor(context) { this.context = context; }
  async resolveCustomTextEditor(document, panel) {
    try {
      await this._resolve(document, panel);
    } catch (error) {
      try { panel.webview.options = { enableScripts: false }; } catch { /* keep going */ }
      panel.webview.html = errorHtml("spec editor", error);
      vscode.window.showErrorMessage("KiroCrew spec editor: " + (error.message || error));
    }
  }
  async _resolve(document, panel) {
    const stage = stageOf(document.uri.path) || { ...STAGES[0], index: 0 };
    const specName = specNameOf(document.uri.path);
    const dir = document.uri.with({ path: document.uri.path.replace(/\/[^/]+$/, "") });
    const present = {};
    for (const s of STAGES) {
      try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, s.file)); present[s.file] = true; } catch { present[s.file] = false; }
    }
    panel.webview.options = { enableScripts: true };
    panel.webview.html = specEditorHtml(specName, stage, present);
    const specObj = async () => {
      const specs = await listSpecs();
      return specs.find((x) => x.name === specName && sameDir(x.dir.path, dir.path)) || { name: specName, dir, present, tasks: [], workspace: (vscode.workspace.workspaceFolders || [])[0] };
    };
    const push = async (synced) => {
      panel.webview.postMessage({ type: "doc", html: mdToHtml(document.getText()), synced: Boolean(synced) });
      const action = continueAction(stage, await specObj());
      panel.webview.postMessage({ type: "continueLabel", label: action.label, title: "Continue the spec workflow from " + stage.label });
    };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === document.uri.toString()) push(true); });
    panel.onDidDispose(() => sub.dispose());
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") await push(false);
        else if (msg.type === "link" && msg.url) await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
        else if (msg.type === "copy") await vscode.env.clipboard.writeText(String(msg.text || ""));
        else if (msg.type === "open") await openPathLink(msg.path, msg.line, msg.column);
        else if (msg.type === "edit") await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
        else if (msg.type === "sync") {
          await vscode.commands.executeCommand("workbench.action.files.revert", document.uri).then(undefined, () => undefined);
          await push(true);
        } else if (msg.type === "stage") {
          const target = vscode.Uri.joinPath(dir, msg.file);
          try { await vscode.workspace.fs.stat(target); } catch {
            const spec = await specObj();
            const phase = msg.file.replace(".md", "");
            const go = await vscode.window.showInformationMessage(specName + " has no " + msg.file + " yet.", "Write it with KiroCrew");
            if (go) await vscode.commands.executeCommand("kirocrew.spec." + (phase === "tasks" ? "tasks" : phase), { spec });
            return;
          }
          await vscode.commands.executeCommand("vscode.openWith", target, "kirocrew.spec");
        } else if (msg.type === "startTask") {
          const spec = await specObj();
          const task = (spec.tasks || []).find((t) => t.line === Number(msg.line));
          if (!task) return void vscode.window.showWarningMessage("That task row is not in " + specName + "/tasks.md any more — Sync Files and try again.");
          if (task.done) return void vscode.window.showInformationMessage("Task " + (task.number || task.title) + " is already ticked.");
          await vscode.commands.executeCommand("kirocrew.spec.runTask", { spec, task, contextValue: "task-open" });
        } else if (msg.type === "continue") {
          const spec = await specObj();
          const action = continueAction(stage, spec);
          if (!action.command) return void vscode.window.showInformationMessage("Every task of " + specName + " is ticked.");
          if (action.open) await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.joinPath(dir, action.open), "kirocrew.spec");
          else await vscode.commands.executeCommand(action.command, { spec, contextValue: "spec" });
        }
      } catch (error) {
        vscode.window.showErrorMessage("KiroCrew spec: " + (error.message || error));
      }
    });
  }
}

// -------------------------------------------------------------- theme sync

/** The workbench's stock themes, by polarity: the only ones the sync ever replaces. */
const STOCK_THEMES = {
  dark: ["Default Dark Modern", "Default Dark+", "Visual Studio Dark", "Dark Modern", "Dark+"],
  light: ["Default Light Modern", "Default Light+", "Visual Studio Light", "Light Modern", "Light+"],
};
const SCHEME_THEMES = { dark: "Default Dark Modern", light: "Default Light Modern" };

/**
 * Pure: the theme to set for a dashboard `scheme`, or null to leave it alone.
 * `current` is the user's explicit setting (undefined when unset). A stock
 * theme of either polarity follows the dashboard; anything the user chose
 * themselves (Monokai, a custom pack, high contrast) is theirs and never touched.
 */
function themeFor(scheme, current) {
  const target = SCHEME_THEMES[scheme];
  if (!target) return null;
  if (current === undefined || current === null || current === "") return target;
  const stock = Object.values(STOCK_THEMES).some((list) => list.includes(current));
  if (!stock) return null;
  return current === target ? null : target;
}

/**
 * Keep the workbench's light/dark in step with the dashboard's. The App
 * reports the dashboard scheme to the mod route; the bridge polls it and
 * applies `themeFor` (a real user theme wins), so switching the dashboard from
 * light to dark switches a stock IDE with it, without a reload.
 */
function syncTheme(context) {
  let lastScheme = null;
  const tick = async () => {
    if (!cfg("syncTheme", true)) return;
    let doc;
    try { doc = await api("/apps/floofycrew/mods/" + IDE_TAG + "/api/theme"); } catch { return; }
    const scheme = doc && doc.scheme;
    if (!scheme || scheme === lastScheme) return;
    lastScheme = scheme;
    const wb = vscode.workspace.getConfiguration("workbench");
    const info = wb.inspect("colorTheme") || {};
    const explicit = info.globalValue !== undefined ? info.globalValue : info.workspaceValue;
    const next = themeFor(scheme, explicit);
    if (next) await wb.update("colorTheme", next, vscode.ConfigurationTarget.Global).then(undefined, (e) => console.warn("[kirocrew] theme sync", e));
  };
  tick();
  const timer = setInterval(tick, 4000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// ---------------------------------------------------------------- activate

function activate(context) {
  const feed = new Feed();
  const sessions = new Sessions(feed);
  const chat = new ChatView(context, sessions, feed);
  const specsTree = new SpecsTree(context);
  const trees = { steering: new AssetTree(context, "steering"), skills: new AssetTree(context, "skills"), hooks: new AssetTree(context, "hooks") };
  // A steering file written or renamed re-reads the composer's steering indicator.
  context.subscriptions.push(trees.steering.onDidChangeTreeData(() => chat.pushSteering().catch(() => undefined)));
  context.subscriptions.push(
    feed,
    vscode.window.registerWebviewViewProvider("kirocrew.chat", chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider("kirocrew.specs", specsTree),
    vscode.window.registerTreeDataProvider("kirocrew.steering", trees.steering),
    vscode.window.registerTreeDataProvider("kirocrew.skills", trees.skills),
    vscode.window.registerTreeDataProvider("kirocrew.hooks", trees.hooks),
    vscode.window.registerCustomEditorProvider("kirocrew.spec", new SpecEditorProvider(context), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("kirocrew.spec.editSource", (uri) => vscode.commands.executeCommand("vscode.openWith", uri, "default")),
  );
  log(`bridge ${context.extension && context.extension.packageJSON ? context.extension.packageJSON.version : "?"} activated`);
  // The other way a chat pane stays blank: the workbench never asked for the view at all. Leave a trace either way.
  const resolvedCheck = setTimeout(() => log(chat.view ? "chat view resolved by the workbench" : "chat view NOT resolved 10s after activation (KiroCrew Chat container hidden, or the workbench never asked for it)"), 10000);
  context.subscriptions.push({ dispose: () => clearTimeout(resolvedCheck) });
  feed.start();
  sessions.refresh().catch((error) => console.warn("[kirocrew] initial refresh failed", error));
  watchApprovals(feed, sessions, context);
  syncTheme(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("kirocrew.chatFontSize")) chat.post({ type: "fontSize", px: Number(cfg("chatFontSize", 0)) || 0 });
  }));

  // First run in this browser profile: our Chat is contributed to the secondary
  // side bar (where the built-in AI chat used to be — the mod turns that off via
  // chat.disableAIFeatures); make sure that bar is open with our chat showing
  // and the KiroCrew container is the active primary view. Later runs respect
  // whatever layout the user left. `landed` is versioned so a layout change in
  // a new release lands once more.
  const LANDED = "kirocrew.landed.v4";
  if (!context.globalState.get(LANDED)) {
    context.globalState.update(LANDED, true);
    setTimeout(async () => {
      // Existing profiles still open "Get Started" walkthrough tabs (machine
      // settings only fill keys the profile has not set). Close them once and
      // record the preference in the profile so it sticks.
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (/Walkthrough|Get Started|Welcome/i.test(tab.label)) await vscode.window.tabGroups.close(tab).then(undefined, () => undefined);
        }
      }
      const wb = vscode.workspace.getConfiguration("workbench");
      if (wb.inspect("startupEditor") && wb.inspect("startupEditor").globalValue === undefined) {
        await wb.update("startupEditor", "none", vscode.ConfigurationTarget.Global).then(undefined, () => undefined);
      }
      await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
      await vscode.commands.executeCommand("workbench.view.extension.kirocrew").then(undefined, () => undefined);
    }, 1500);
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "kirocrew.history";
  context.subscriptions.push(status, sessions.onDidChange(() => {
    const mine = sessions.mine();
    const busy = mine.filter((s) => s.running).length;
    const waiting = mine.filter((s) => s.pending_approval || s.needs_input || s.waiting_for_input).length;
    status.text = "$(hubot) KiroCrew " + (waiting ? "$(bell) " + waiting + " waiting" : busy ? "$(sync~spin) " + busy + " running" : mine.length + " sessions");
    status.tooltip = "KiroCrew sessions of this project (they run in the gateway) — click for history";
    status.show();
  }));

  const pickAgent = async () => {
    await sessions.refresh().catch(() => undefined);
    const items = [{ label: "$(circle-outline) crew default", description: "let KiroCrew pick", agent: "" }]
      .concat(sessions.agents.map((a) => ({ label: "$(person) " + a.name, description: a.description || a.model || "", agent: a.name })));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Agent for new KiroCrew chats and spec phases" });
    if (!picked) return;
    await vscode.workspace.getConfiguration("kirocrew").update("agent", picked.agent, vscode.ConfigurationTarget.Global);
    chat.setAgent(picked.agent);
  };

  // A spec phase or task runs in a NEW chat tab in Spec mode: the tab inherits
  // the current agent/model/effort picks (kirocrew.specAgent overrides the
  // agent), and the send goes through the chat's own path so the Spec workflow
  // frame is injected and the tab shows "Spec", not "Default".
  const dispatch = async (spec, prompt, kind, title) => {
    await vscode.commands.executeCommand("kirocrew.chat.focus");
    const key = await chat.dispatch(prompt, { mode: "spec", agent: cfg("specAgent", "") || undefined, title, kind });
    vscode.window.setStatusBarMessage("KiroCrew: " + title + " running in session " + key, 5000);
    return key;
  };

  const specOf = async (node) => {
    if (node && node.spec) return node.spec;
    const specs = await listSpecs();
    if (!specs.length) throw new Error("no specs in this workspace");
    if (specs.length === 1) return specs[0];
    const picked = await vscode.window.showQuickPick(specs.map((s) => ({ label: s.name, spec: s })), { placeHolder: "Which spec?" });
    if (!picked) throw new Error("cancelled");
    return picked.spec;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("kirocrew.refresh", () => { sessions.refresh().catch(() => undefined); specsTree.refresh(); Object.values(trees).forEach((t) => t.refresh()); }),
    vscode.commands.registerCommand("kirocrew.pickAgent", pickAgent),
    vscode.commands.registerCommand("kirocrew.newSession", async () => { chat.newTab(); await vscode.commands.executeCommand("kirocrew.chat.focus"); }),
    vscode.commands.registerCommand("kirocrew.toggleChat", () => vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar")),
    vscode.commands.registerCommand("kirocrew.chat.reload", () => chat.reload("command")),
    vscode.commands.registerCommand("kirocrew.extensions.installFromMarketplace", installFromMarketplace),
    vscode.commands.registerCommand("kirocrew.openSession", async (key) => { await vscode.commands.executeCommand("kirocrew.chat.focus"); await chat.open(key); }),
    vscode.commands.registerCommand("kirocrew.openInDashboard", (key) => vscode.env.openExternal(vscode.Uri.parse(ORIGIN + "/chat/" + encodeURIComponent(typeof key === "string" ? key : chat.key || "")))),
    vscode.commands.registerCommand("kirocrew.stopSession", (key) => sessions.stop(typeof key === "string" ? key : chat.key).catch((e) => vscode.window.showErrorMessage(e.message))),
    vscode.commands.registerCommand("kirocrew.history", async () => {
      await sessions.refresh().catch(() => undefined);
      const rows = sessions.history();
      const project = sessions.projectPath();
      if (!rows.length) return vscode.window.showInformationMessage("No KiroCrew sessions for " + (project || "this workspace") + " yet — send a message to start one.");
      const items = rows.map((s) => {
        const busy = s.running ? "$(sync~spin) running" : (s.pending_approval || s.needs_input || s.waiting_for_input) ? "$(bell) waiting" : "";
        const when = ageLabel(slotActivity(s));
        return { label: (chat.tabForKey(s.key) ? "$(check) " : "") + (s.title || s.label || s.key), description: [s.effective_agent || s.agent, busy, when].filter(Boolean).join("  ·  "), detail: (s.last_message || s.prompt_preview || "").toString().slice(0, 120), key: s.key };
      });
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Sessions of " + (project || "this workspace") + " — newest first, created here or in the dashboard", matchOnDescription: true, matchOnDetail: true });
      if (picked) { await vscode.commands.executeCommand("kirocrew.chat.focus"); await chat.open(picked.key); }
    }),
    vscode.commands.registerCommand("kirocrew.openFile", async (uri) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("kirocrew.steering.new", () => newAsset("steering", vscode.workspace.workspaceFolders || [])),
    vscode.commands.registerCommand("kirocrew.skills.new", () => newAsset("skills", vscode.workspace.workspaceFolders || [])),
    vscode.commands.registerCommand("kirocrew.hooks.new", () => newAsset("hooks", vscode.workspace.workspaceFolders || [])),
    vscode.commands.registerCommand("kirocrew.spec.open", async (uri, line) => {
      // A task row jumps to its line in the source; a stage file opens the Kiro spec editor.
      if (typeof line !== "number" && stageOf(uri.path)) {
        await vscode.commands.executeCommand("vscode.openWith", uri, "kirocrew.spec");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (typeof line === "number") {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("kirocrew.spec.new", async () => {
      const folders = vscode.workspace.workspaceFolders || [];
      if (!folders.length) return vscode.window.showErrorMessage("Open a folder first.");
      const name = await vscode.window.showInputBox({ prompt: "Spec name (kebab-case)", validateInput: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "lowercase letters, digits and dashes" });
      if (!name) return;
      const idea = await vscode.window.showInputBox({ prompt: "One or two sentences: what should this feature do?" });
      if (idea === undefined) return;
      const dir = vscode.Uri.joinPath(folders[0].uri, ".kiro", "specs", name);
      await vscode.workspace.fs.createDirectory(dir);
      const spec = { name, dir, present: {}, tasks: [], workspace: folders[0] };
      specsTree.refresh();
      await dispatch(spec, phasePrompt("requirements", spec, idea), "spec", "spec " + name + ": requirements");
    }),
    vscode.commands.registerCommand("kirocrew.spec.requirements", async (node) => {
      const spec = await specOf(node);
      const idea = spec.present["requirements.md"] ? "" : await vscode.window.showInputBox({ prompt: "What should this feature do?" });
      if (idea === undefined) return;
      await dispatch(spec, phasePrompt("requirements", spec, idea), "spec", "spec " + spec.name + ": requirements");
    }),
    vscode.commands.registerCommand("kirocrew.spec.design", async (node) => {
      const spec = await specOf(node);
      if (!spec.present["requirements.md"]) return vscode.window.showWarningMessage("Write requirements first — the design is derived from them.");
      await dispatch(spec, phasePrompt("design", spec), "spec", "spec " + spec.name + ": design");
    }),
    vscode.commands.registerCommand("kirocrew.spec.tasks", async (node) => {
      const spec = await specOf(node);
      if (!spec.present["design.md"]) return vscode.window.showWarningMessage("Write the design first — tasks are derived from it.");
      await dispatch(spec, phasePrompt("tasks", spec), "spec", "spec " + spec.name + ": tasks");
    }),
    vscode.commands.registerCommand("kirocrew.spec.runTask", async (node) => {
      if (!node || !node.task) return vscode.window.showWarningMessage("Pick a task in the Specs view.");
      let spec = node.spec;
      if (!spec.taskTree) spec = (await listSpecs()).find((s) => s.name === spec.name && sameDir(s.dir.path, spec.dir.path)) || spec;
      const task = (spec.taskTree && findTask(spec.taskTree, node.task.id || node.task.line)) || null;
      const text = task ? task.text : (node.task.number ? node.task.number + " " : "") + node.task.title;
      await runTasks(spec, (kiro) => (kiro && task ? kiroTaskRequest(spec, task) : taskPrompt(spec, node.task)), "Execute Task: " + text, "task");
    }),
    vscode.commands.registerCommand("kirocrew.spec.runAll", (node) => runAllOf(node, false)),
    vscode.commands.registerCommand("kirocrew.spec.runAllOptional", (node) => runAllOf(node, true)),
  );

  /**
   * Run every remaining task of a spec in ONE session, the way Kiro's IDE does
   * when you click "Run all tasks": no confirmation, Autopilot on, and the
   * request is Kiro's own — its Task Orchestrator queues the required tasks and
   * runs them back to back, so you never click "Start task" again. With
   * `optional`, the `*` marks are removed from tasks.md first (Kiro's "make all
   * required"), so the optional tasks run too.
   */
  async function runAllOf(node, optional) {
    let spec = await specOf(node);
    const remaining = spec.tasks.filter((t) => !t.done && t.leaf && (optional || !t.optional)).length;
    if (!remaining) return vscode.window.showInformationMessage("Every " + (optional ? "" : "required ") + "task in " + spec.name + " is ticked.");
    if (optional && /\[[ xX\-~]\]\\?\*/.test(spec.tasksText || "")) {
      const uri = vscode.Uri.joinPath(spec.dir, "tasks.md");
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(makeAllTasksRequired(spec.tasksText)));
      spec = (await listSpecs()).find((s) => s.name === spec.name && sameDir(s.dir.path, spec.dir.path)) || spec;
    }
    const display = optional ? "Run all required and optional tasks" : "Run all tasks";
    await runTasks(spec, (kiro) => (kiro ? kiroRunAllRequest(spec) : runAllPrompt(spec)), display, "spec");
  }

  /** Dispatch a task run: Spec mode, the configured spec agent, Autopilot per `kirocrew.specAutopilot`, Kiro's visible turn text. */
  async function runTasks(spec, text, display, kind) {
    await vscode.commands.executeCommand("kirocrew.chat.focus");
    const key = await chat.dispatch(text, { mode: "spec", agent: cfg("specAgent", "") || undefined, title: display, kind, display, autopilot: cfg("specAutopilot", true) !== false });
    vscode.window.setStatusBarMessage("KiroCrew: " + display + " — session " + key, 5000);
    return key;
  }
}

module.exports = { activate, deactivate() {} };
// Pure helpers, exposed for `tests/extension_unit.test.mjs` (never used by the host).
module.exports.__test = { isReservedModeRefusal, isErrorRow, readText, readWholeText, HOST_CONTEXT_MAX, CONTEXT_BUDGET, parseSteering, globToRegExp, steeringMatches, steeringMentions, listSteering, agentLoadsSteering, parseTasks, parseTaskLine, parseTaskTree, flattenTasks, findTask, serializeTask, makeAllTasksRequired, kiroTaskRequest, kiroRunAllRequest, phasePrompt, taskPrompt, runAllPrompt, normalizeRow, findPathLinks, chatHtml, sameDir, slotTime, slotActivity, ageLabel, HOOK_TEMPLATE, STEERING_TEMPLATE, SKILL_TEMPLATE, mdToHtml, stageOf, specNameOf, continueAction, specEditorHtml, workflowContext, splitOptions, WORKFLOWS, CONTEXT_KINDS, clip, ChatView, Sessions, themeFor, STOCK_THEMES, kasAgentFor, mergeRosters, agentPicks, modeOfAgent, activate };
