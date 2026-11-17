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
/** A call to this mod's own hook routes (`/apps/floofycrew/mods/kirocrew-ide/api/<route>`); a 409 `unsupported` answer is flagged on the error. */
async function modApi(route, init) {
  try {
    return await api("/apps/floofycrew/mods/" + IDE_TAG + "/api/" + route, init);
  } catch (error) {
    if (error && error.body && error.body.unsupported) error.unsupported = true;
    throw error;
  }
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

// Agent ids the gateway never runs: KAS's bundled modes (KiroCrew's
// KAS_RESERVED_AGENT_IDS). They reached gateway sessions through the retired
// kiro-spec-plan handles (`~/.kiro/agents/spec.json`) and still live on in old
// slots, `kirocrew.agent` / `kirocrew.specAgent` settings and restored tabs; once
// the handle files are gone the gateway answers "Bot 'spec' is unavailable;
// restore it or choose a member". The modes run on Kiro's engine (kas tabs),
// never as a gateway agent, so every place that hands an agent id to the
// gateway goes through gatewayAgent(), which maps a reserved id to the crew
// default ("").
const GATEWAY_RESERVED_AGENT_IDS = new Set(["default", "vibe", "spec", "quick-spec", "bug-fix", "plan", "autonomous"]);
function gatewayAgent(agent) {
  const id = String(agent || "").trim();
  return GATEWAY_RESERVED_AGENT_IDS.has(id) ? "" : id;
}
/** The gateway's answer when a session's recorded agent no longer resolves (turn_context.unavailable_agent_message). */
const UNAVAILABLE_AGENT_RE = /Bot '([^']+)' is unavailable; restore it or choose a member/;
function unavailableAgentOf(text) {
  const m = UNAVAILABLE_AGENT_RE.exec(String(text || ""));
  return m ? m[1] : "";
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
    agent = gatewayAgent(agent);
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
    if (title) await this.setTitle(key, title).catch(() => undefined);
    await this.refresh().catch(() => undefined);
    return key;
  }
  /** The gateway's rename route (the one the dashboard's title edit uses): `PATCH /chat/slots/<key>/title`. */
  setTitle(key, title) { return api("/chat/slots/" + encodeURIComponent(key) + "/title", { method: "PATCH", json: { title } }); }
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
  /** The host's delete route (the dashboard's session delete): the slot and its transcript are gone. */
  async remove(key) { return api("/chat/slots/" + encodeURIComponent(key), { method: "DELETE" }); }
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
  setSlotAgent(key, agent) { return api("/chat/slots/" + encodeURIComponent(key) + "/agent", { method: "POST", json: { agent: gatewayAgent(agent) } }); }
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

/**
 * The tab the Ctrl/Cmd+Alt+→/← shortcuts land on (requirement 8.1): `dir` steps
 * from the active tab and wraps at both ends. `tabs` is the ordered strip (any
 * objects with an `id`), the result an index into it: -1 for an empty strip,
 * the first tab when the active id is not in the strip.
 */
function nextTabIndex(tabs, activeId, dir) {
  const n = Array.isArray(tabs) ? tabs.length : 0;
  if (!n) return -1;
  const at = tabs.findIndex((t) => t && t.id === activeId);
  if (at < 0) return 0;
  const step = dir < 0 ? -1 : 1;
  return (((at + step) % n) + n) % n;
}

/** The label a tab shows: a user's Rename wins over the gateway's title, which wins over the local one. */
function tabLabel(t, slot) {
  if (t && t.renamed && t.title) return t.title;
  return (slot && (slot.title || slot.label)) || (t && t.title) || "New chat";
}

/** Rename's input box: a trimmed, non-empty title of at most TAB_TITLE_MAX characters. */
const TAB_TITLE_MAX = 120;
function validateTabTitle(value) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return "A tab needs a title";
  if (v.length > TAB_TITLE_MAX) return "At most " + TAB_TITLE_MAX + " characters";
  return null;
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
    this.agent = gatewayAgent(cfg("agent", ""));
    this.nextId = 1;
    this.dispatchSeq = 0;    // local ids of the bubbles dispatch() draws ahead of the session ("d<n>")
    this.lastSettings = null; // a new tab inherits the previous tab's picks
    this.kas = null;          // the KasLink of this workspace (Kiro-mode tabs), opened on first use
    this.kasSpecListeners = new Set(); // spec machinery listening for specEvent frames (task state)
    feed.on((frame) => this.onFrame(frame));
    sessions.onDidChange(() => this.pushTabs());
    this.restoreTabs();
  }
  storageKey() { return "kirocrew.tabs:" + (this.sessions.projectPath() || "-"); }
  /** Per-tab composer picks: agent, model, reasoning effort, workflow mode, Autopilot; `engine` is "kas" for a Kiro-mode pick. */
  defaultSettings() {
    const s = Object.assign({ agent: this.agent || "", model: "", effort: "", mode: "default", autopilot: false, engine: "" }, this.lastSettings || {});
    // A reserved mode id inherited from an old tab must not become the next gateway session's agent.
    s.agent = gatewayAgent(s.agent);
    if (s.baseAgent !== undefined) s.baseAgent = gatewayAgent(s.baseAgent);
    return s;
  }
  /**
   * The tabs as they were when the window closed, and the one that was in front.
   * The record carries `active` (the selected tab's session key) since 0.30.8;
   * before that the first tab was selected on every restore, so a window with
   * several chats always came back on the oldest one. A record without it (an
   * older version's, or one saved while a draft tab was selected) opens on the
   * LAST tab, the newest chat.
   */
  restoreTabs() {
    const saved = this.context.workspaceState.get(this.storageKey());
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      this.tabs = saved.tabs.filter((t) => t && t.key).map((t) => ({ id: this.nextId++, key: t.key, title: t.title || t.key, renamed: Boolean(t.renamed && t.title), settings: Object.assign(this.defaultSettings(), t.settings || {}), kind: t.kind || undefined, run: t.run && typeof t.run === "object" ? t.run : null, spec: specTabRecord(t.spec), link: typeof t.link === "string" && t.link ? t.link : null, kas: t.kind === "kas" ? kasTabState(t.kas) : undefined }));
      const front = (typeof saved.active === "string" && this.tabForKey(saved.active)) || this.tabs[this.tabs.length - 1] || null;
      this.active = front ? front.id : null;
      if (this.tabs.length) this.lastSettings = Object.assign({}, this.tabs[this.tabs.length - 1].settings);
    }
    if (!this.tabs.length) this.newTab();
  }
  saveTabs() {
    const front = this.tab(this.active);
    this.context.workspaceState.update(this.storageKey(), {
      tabs: this.tabs.filter((t) => t.key).map((t) => ({ key: t.key, title: t.title, renamed: Boolean(t.renamed), settings: t.settings, kind: t.kind, run: t.run || null, spec: t.spec || null, link: t.link || null, kas: t.kind === "kas" ? kasTabRecord(t.kas) : null })),
      active: (front && front.key) || null,
    });
  }
  /** Bring a tab to the front and remember the choice for the next window. */
  select(id) {
    if (!this.tab(id)) return;
    this.active = id;
    this.saveTabs();
    this.pushTabs();
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
    // Transcripts first, then one judgement per restored tab: an interrupted
    // run gets its card under the history (never a send at startup).
    Promise.all(this.tabs.filter((t) => t.key).map((t) => this.load(t))).then(() => this.checkRestoredRuns()).catch((e) => log("run check (startup): " + e.message));
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
    const [models, efforts, kas] = await Promise.all([this.sessions.models(), this.sessions.effortLevels(this.key), kasStatus()]);
    const dropped = this.pruneRetiredModels(models);
    if (dropped.length) log("dropped retired model pick(s) " + dropped.join(", ") + "; those tabs use the agent's model");
    this.post({
      type: "choices",
      agents: kasPicks(kas).concat(agentPicks(this.sessions.agents)),
      models: [{ id: "", label: "agent's model", description: "the agent's configured default" }].concat(models.map((m) => ({ id: m.id, label: m.label || m.id, description: m.id !== m.label ? m.id : "" }))),
      efforts: [{ id: "", label: "default effort", description: "the model's default" }].concat(efforts.map((e) => ({ id: e, label: e[0].toUpperCase() + e.slice(1), description: "" }))),
    });
    this.post({ type: "fontSize", px: Number(cfg("chatFontSize", 0)) || 0 });
    this.post({ type: "width", preset: String(cfg("chatWidth", "compact") || "compact") });
    this.post({ type: "toolCardDisplayMode", mode: String(cfg("toolCardDisplayMode", "collapseOnComplete") || "collapseOnComplete") });
    this.post({ type: "composerHeight", px: Number(this.context.workspaceState.get("kirocrew.composerHeight")) || 0 });
    this.pushSteering().catch((error) => console.warn("[kirocrew] steering inventory unavailable", error));
  }
  /** The composer's steering indicator: every steering file of both tiers with its inclusion mode (fileMatch hits are decided per send). */
  async pushSteering() {
    const docs = await listSteering(this.sessions.projectPath());
    this.post({ type: "steering", items: docs.map((d) => ({ name: d.name, label: d.label, scope: d.scope, inclusion: d.inclusion, mode: steeringModeLabel(d), description: d.description, path: d.path })) });
  }
  /**
   * The picker's hint row was clicked. `kas`: Kiro's modes are unavailable on
   * this host (kiro-cli missing, too old, or not logged in); the reason from
   * `kas/status` is shown and "Check again" re-reads it.
   */
  async explainModes() {
    const status = await kasStatus(true);
    const reason = status.available ? "kiro-cli is usable now; reopen the picker." : String(status.reason || "kiro-cli is not usable on the gateway host");
    const choice = await vscode.window.showInformationMessage("Kiro modes (Spec, Quick Spec, Bug Fix, Plan) run in kiro-cli on the gateway host. " + reason, "Check again");
    if (choice === "Check again") { invalidateKasStatus(); await this.pushChoices(); }
  }
  pushTabs() {
    const rows = this.tabs.map((t) => {
      if (isKasTab(t)) {
        // A Kiro-mode tab has no gateway slot: its state is what the Kas_Link reported.
        const k = t.kas || (t.kas = kasTabState());
        t.live = {};
        const shown = Object.assign({}, t.settings, { engine: "kas", mode: k.mode || t.settings.mode, autopilot: k.sessionId ? k.autopilot : Boolean(t.settings.autopilot) });
        return { id: t.id, key: t.key, title: tabLabel(t, null), settings: shown, engine: "kas", kasState: k.state,
          running: Boolean(k.running), waiting: Object.keys(k.asks || {}).length > 0 };
      }
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
      return { id: t.id, key: t.key, title: tabLabel(t, slot), settings: shown,
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
  // -- the tab shortcuts (requirement 8.1): each command is forwarded to the page, which
  //    takes the same path its own strip buttons take (select / close / new round trips).
  /** Ctrl/Cmd+Alt+→ / ←. */
  stepTab(dir) { this.post({ type: dir < 0 ? "tabs.prev" : "tabs.next" }); }
  /** Ctrl/Cmd+T. */
  requestNewTab() { this.post({ type: "tabs.new" }); }
  /** Ctrl/Cmd+F (requirement 8.3): the page opens its find bar over the active transcript (idempotent: an open bar regains focus). */
  openFind() { this.post({ type: "find.open" }); }
  /**
   * Ctrl/Cmd+Enter / Ctrl/Cmd+Shift+C (requirement 8.4): the page resolves every pending
   * approval card of the active tab through the card's own button path, so each still
   * arrives here as one `approve` message; nothing pending, nothing happens.
   */
  approveAll() { this.post({ type: "approvals.approveAll" }); }
  rejectAll() { this.post({ type: "approvals.rejectAll" }); }
  /** Ctrl/Cmd+W: a tab whose session is running asks first; the page then posts `close` for the active tab. */
  async requestCloseTab() {
    const t = this.tab(this.active);
    if (!t) return;
    const slot = t.key ? this.sessions.slot(t.key) : null;
    const running = isKasTab(t) ? Boolean(t.kas && t.kas.running) : Boolean(slot && slot.running);
    if (running) {
      const label = tabLabel(t, slot);
      const detail = isKasTab(t) ? "The session keeps running in kiro-cli on the gateway host; find it again under History (Kiro modes)." : "The session keeps running in the gateway; find it again under History.";
      const pick = await vscode.window.showWarningMessage("Close the running tab “" + label + "”?", { modal: true, detail }, "Close");
      if (pick !== "Close") return;
    }
    this.post({ type: "tabs.close" });
  }
  /**
   * Rename (requirement 8.2): the new title is stored with the tab record (it
   * outranks the gateway's title on this tab, see tabLabel) and pushed to the
   * page; a tab with a session also asks the gateway to rename it, once, through
   * `PATCH /chat/slots/<key>/title`. A refused rename leaves the label local.
   */
  async renameTab(id) {
    const t = this.tab(id != null ? id : this.active);
    if (!t) return;
    const current = tabLabel(t, t.key ? this.sessions.slot(t.key) : null);
    const value = await vscode.window.showInputBox({ prompt: "Rename chat tab", value: current, valueSelection: [0, current.length], validateInput: validateTabTitle, ignoreFocusOut: true });
    if (value === undefined) return;
    const title = value.trim();
    if (!title || title === current) return;
    t.title = title;
    t.renamed = true;
    this.saveTabs();
    this.post({ type: "tabs.rename", id: t.id, title });
    this.pushTabs();
    if (!t.key) return;
    try {
      await this.sessions.setTitle(t.key, title);
      await this.sessions.refresh().catch(() => undefined);
    } catch (error) {
      log("gateway rename of " + t.key + " refused (" + (error.message || error) + "); the title stays local");
    }
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
      if (slot && gatewayAgent(slot.agent)) t.settings.agent = gatewayAgent(slot.agent);
    }
    this.select(t.id);
    await this.load(t);
  }
  async load(t) {
    if (isKasTab(t) && t.kas && t.kas.sessionId) { await this.kasAttach(t, "load"); return; }
    this.post({ type: "clear", id: t.id });
    this.post({ type: "session", id: t.id, key: t.key });
    const rows = await this.sessions.transcript(t.key).catch(() => []);
    for (const row of rows) this.post({ type: "row", id: t.id, row: normalizeRow(row) });
    this.post({ type: "scroll", id: t.id });
  }
  /**
   * Open a Kiro-mode session (from History's "Kiro modes" group or a spec
   * action) in a tab: the open one when the session already has a tab, else a
   * fresh Kas_Tab attached with `since: 0`, so the hook replays everything it
   * holds (or `session/load`s the session into a new kiro-cli child).
   */
  async openKas(sessionId, { mode, title, select = true, adopt = null } = {}) {
    const key = "kas:" + sessionId;
    let t = this.tabForKey(key);
    if (!t) {
      // `adopt` is the tab a spec action prepared (beginSpecRun) so its starting row and
      // working foxes carry over into this session's tab; otherwise the selected draft.
      const draft = (adopt && !adopt.key && this.tabs.includes(adopt) ? adopt : null) || this.tabs.find((x) => !x.key && x.id === this.active) || null;
      t = draft || this.newTab(false);
      t.key = key;
      t.kind = "kas";
      t.kas = kasTabState({ sessionId, mode: mode || "", state: "detached" });
      t.settings.engine = "kas";
      if (mode) t.settings.mode = mode;
      t.title = title || "Kiro " + (mode || "mode");
      this.saveTabs();
    }
    if (select) this.select(t.id);
    await this.kasAttach(t, "open");
    return t;
  }
  // -- Kiro-mode tabs (hook/kas.py over the Kas_Link) -----------------------
  /** This workspace's Kas_Link, created on first use; its frames feed onKasFrame. */
  kasLink() {
    if (!this.kas) {
      this.kas = new KasLink(this.sessions.projectPath());
      this.kas.on((frame) => this.onKasFrame(frame));
      this.context.subscriptions.push({ dispose: () => { if (this.kas) this.kas.dispose(); } });
    }
    return this.kas;
  }
  /** Every open Kiro-mode tab with a session. */
  kasTabs() { return this.tabs.filter((t) => isKasTab(t) && t.kas && t.kas.sessionId); }
  /**
   * Attach (or re-attach) a Kiro-mode tab to its session: `attach {sessionId,
   * since: lastSeq}`; the hook replays what the tab missed, or `clear`s and
   * replays everything after a `session/load` into a fresh child. `why` is
   * "load" (startup), "open", "reconnect" (the link came back) or "reload"
   * (the user's button on a detached session).
   */
  async kasAttach(t, why) {
    const k = t.kas;
    if (!k || !k.sessionId) return false;
    this.post({ type: "session", id: t.id, key: t.key, engine: "kas" });
    if (why === "load" || why === "open") { this.post({ type: "clear", id: t.id }); k.lastSeq = 0; k.asks = {}; }
    const link = this.kasLink();
    try {
      await link.ready();
      await link.request({ op: "attach", sessionId: k.sessionId, since: k.lastSeq });
      k.state = "live";
      if (why === "load" || why === "open") this.post({ type: "scroll", id: t.id });
      this.saveTabs();
      this.pushTabs();
      return true;
    } catch (error) {
      k.state = "detached";
      this.pushTabs();
      const text = error && error.frame && error.frame.login ? String(error.message) + " — run `kiro-cli login` on the gateway host." : "Kiro-mode session: " + (error && error.message || error);
      this.post({ type: "error", id: t.id, text });
      this.post({ type: "interrupted", id: t.id, text: "This Kiro-mode session is detached.", resume: true, label: "Reload session", hint: "Attach again (the hook starts kiro-cli for this workspace if needed and loads the session)." });
      return false;
    }
  }
  /** A frame from the Kas_Link: link events, spec events, and per-session frames through the Adapter. */
  onKasFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.kind === "_open") {
      // The link (re)opened: every Kiro-mode tab attaches again with what it last saw.
      for (const t of this.kasTabs()) this.kasAttach(t, "reconnect").catch((e) => log("kas re-attach " + t.key + ": " + e.message));
      invalidateKasStatus();
      return;
    }
    if (frame.kind === "_closed") {
      for (const t of this.kasTabs()) { t.kas.state = "reconnecting"; this.post({ type: "status", id: t.id, text: "Reconnecting to kiro-cli…" }); }
      this.pushTabs();
      return;
    }
    if (frame.kind === "_helloFailed") {
      for (const t of this.kasTabs()) this.post({ type: "error", id: t.id, text: "kiro-cli: " + frame.error });
      return;
    }
    if (frame.kind === "specEvent" || frame.kind === "sessionsChanged") {
      for (const fn of this.kasSpecListeners) { try { fn(frame); } catch (e) { log("kas spec listener: " + e.message); } }
      if (frame.kind === "sessionsChanged") return;
    }
    if (frame.kind === "childState") {
      // Not per session: every tab of the workspace whose child exited learns it.
      const ids = new Set(Array.isArray(frame.sessions) ? frame.sessions : []);
      for (const t of this.kasTabs()) if (!ids.size || ids.has(t.kas.sessionId) || frame.wsHash === t.kas.wsHash) this.applyKasMessages(t, kasFramesToMessages(frame, t.kas));
      this.pushTabs();
      return;
    }
    if (!frame.sessionId) return;
    const t = this.tabForKey("kas:" + frame.sessionId);
    if (!t || !t.kas) return;
    this.applyKasMessages(t, kasFramesToMessages(frame, t.kas));
  }
  /** Post the Adapter's messages to the tab's pane; the `_`-prefixed ones update the tab record instead. */
  applyKasMessages(t, messages) {
    let tabsChanged = false;
    for (let m of messages) {
      if (m.type === "_attached") { tabsChanged = true; if (m.title && !t.renamed && (t.title === "New chat" || /^Kiro /.test(t.title))) t.title = String(m.title).slice(0, 60); continue; }
      if (m.type === "_mode") { t.settings.mode = m.mode; tabsChanged = true; continue; }
      if (m.type === "_config") {
        if (m.autopilot !== undefined) t.settings.autopilot = m.autopilot;
        if (m.model !== undefined) t.settings.model = m.model;
        if (m.effort !== undefined) t.settings.effort = m.effort;
        if (m.mode) t.settings.mode = m.mode;
        tabsChanged = true;
        continue;
      }
      if (m.type === "_title") { if (!t.renamed && (t.title === "New chat" || /^Kiro /.test(t.title))) { t.title = String(m.title).slice(0, 60); tabsChanged = true; } continue; }
      if (m.type === "done" || m.type === "row" || m.type === "question" || m.type === "questionResolved") tabsChanged = true;
      // A spec action on Kiro's engine takes its checkpoint in runKasSpec, before the
      // invoke; KAS echoes the turn's user message afterwards, and that is the bubble
      // the Revert action belongs on, so the pending id rides along with it.
      if (m.type === "user" && t.kas && t.kas.pendingCheckpoint) {
        m = Object.assign({}, m, { checkpoint: t.kas.pendingCheckpoint });
        t.kas.pendingCheckpoint = null;
      }
      this.post(Object.assign({ id: t.id }, m));
      if (m.type === "done") this.noteKasTurnEnd(t);
    }
    if (tabsChanged) { this.saveTabs(); this.pushTabs(); }
    else if (messages.length) this.saveTabs();
  }
  /** A Kiro-mode turn ended: the task-run link (if any) learns its outcome. */
  noteKasTurnEnd(t) {
    if (t.link) this.noteLinkOutcome(t, t.stopped ? "stopped" : "ok");
    t.stopped = false;
  }
  // -- workspace checkpoints: "Revert changes" on a turn (hook/checkpoints.py) --------
  /**
   * Checkpoint the workspace before a turn runs, like Kiro's per-message
   * checkpoint: the hook writes a git tree of the working tree through a
   * temporary index (the user's index and HEAD untouched). Returns the
   * checkpoint id for the bubble's Revert action, or undefined when the
   * folder is not a git repository, `kirocrew.checkpoints` is off, or the hook
   * did not answer (a turn never waits on a failed snapshot; the reason is
   * logged once per tab).
   */
  async checkpointBeforeTurn(t, label) {
    if (cfg("checkpoints", true) === false) return undefined;
    const folder = this.sessions.projectPath();
    if (!folder) return undefined;
    try {
      const rec = await modApi("checkpoints/snapshot", { method: "POST", json: { folder, session: t.key || null, turn: (t.turns = (t.turns || 0) + 1), label: String(label || "").slice(0, 120) } });
      return rec && rec.id ? String(rec.id) : undefined;
    } catch (error) {
      if (!t.checkpointNoted) {
        t.checkpointNoted = true;
        const why = error && error.unsupported ? "this folder is not a git repository" : (error && error.message) || "the gateway did not answer";
        log("checkpoint before turn skipped: " + why);
        if (error && error.unsupported) this.post({ type: "status", id: t.id, text: "Revert changes is unavailable here: " + why + "." });
      }
      return undefined;
    }
  }
  /**
   * Restore the workspace to checkpoint `id` after a modal confirmation that
   * names what would change; the result lands as a row with Undo (the hook
   * checkpoints the current state first). `undoOf` marks an undo/redo so the
   * row reads the other way round and skips the confirmation.
   */
  async revertTo(t, id, { undoOf = "" } = {}) {
    const folder = this.sessions.projectPath();
    if (!folder) return;
    try {
      if (!undoOf) {
        const preview = await modApi("checkpoints/changed?folder=" + encodeURIComponent(folder) + "&id=" + encodeURIComponent(id));
        const files = (preview && preview.files) || [];
        if (!files.length) { this.post({ type: "reverted", id: t.id, files: [], checkpoint: id, root: preview && preview.root }); return; }
        const sample = files.slice(0, 6).map((f) => "  " + (f.status === "A" ? "remove " : f.status === "D" ? "restore " : "restore ") + f.path).join("\n");
        const more = files.length > 6 ? "\n  … and " + (files.length - 6) + " more" : "";
        const pick = await vscode.window.showWarningMessage(
          "Revert " + files.length + " file" + (files.length === 1 ? "" : "s") + " to how they were before this message?",
          { modal: true, detail: sample + more + "\n\nFiles created since are removed, edits since are undone. Undo stays available in the chat." },
          "Revert");
        if (pick !== "Revert") return;
      }
      const result = await modApi("checkpoints/revert", { method: "POST", json: { folder, id } });
      this.post({ type: "reverted", id: t.id, files: result.files || [], undo: result.undo, undoOf: undoOf || undefined, checkpoint: id, root: result.root });
      const n = (result.files || []).length;
      if (n) vscode.window.setStatusBarMessage("KiroCrew: " + (undoOf ? "undo — " : "reverted ") + n + " file" + (n === 1 ? "" : "s"), 5000);
    } catch (error) {
      this.post({ type: "reverted", id: t.id, error: (error && error.message) || String(error), checkpoint: id });
    }
  }
  /**
   * Send from a Kiro-mode tab (requirements 3.2, 3.8): open the link, create
   * the session on first use (`new` with the mode and the tab's picks), say the
   * once-per-tab notice, upload non-image attachments, build the ACP prompt
   * blocks and send `prompt`. The `#` contexts travel as text blocks, images
   * inline; steering is KAS's own.
   */
  async kasSend(t, msg) {
    const text = String(msg.text || "");
    const files = Array.isArray(msg.files) ? msg.files : [];
    const contexts = Array.isArray(msg.contexts) ? msg.contexts : [];
    if (!text.trim() && !files.length && !contexts.length) return;
    const k = t.kas || (t.kas = kasTabState());
    t.kind = "kas";
    t.settings.engine = "kas";
    t.turnError = ""; t.stopped = false;
    const link = this.kasLink();
    const hello = await link.ready();
    if (hello && hello.login === false) throw new Error((hello.message || "kiro-cli is not logged in") + " — run `kiro-cli login` on the gateway host.");
    if (k.running) throw new Error("this Kiro-mode session is still running; wait for the turn to end or press Stop");
    if (!k.sessionId) {
      const mode = KAS_MODES.includes(t.settings.mode) ? t.settings.mode : (KAS_MODES.includes(k.mode) ? k.mode : "spec");
      const created = await link.request({ op: "new", mode, autopilot: Boolean(t.settings.autopilot), model: t.settings.model || undefined, effort: t.settings.effort || undefined, title: t.pendingTitle || (t.renamed ? t.title : undefined), tabRef: String(t.id) });
      k.sessionId = created.sessionId; k.mode = created.mode || mode; k.wsHash = created.wsHash || ""; k.state = "live"; k.autopilot = Boolean(t.settings.autopilot);
      t.key = "kas:" + k.sessionId;
      if (!t.renamed) t.title = t.pendingTitle || (text || (files[0] && files[0].name) || "Kiro " + mode).slice(0, 40);
      delete t.pendingTitle;
      for (const note of created.notes || []) this.post({ type: "status", id: t.id, text: String(note) });
      this.saveTabs();
      this.pushTabs();
      this.post({ type: "session", id: t.id, key: t.key, engine: "kas" });
      if (t.link && taskSessionLinks()) taskSessionLinks().setSession(t.link, t.key);
    }
    if (!k.noticeShown) { this.post({ type: "status", id: t.id, text: KAS_TAB_NOTICE }); k.noticeShown = true; this.saveTabs(); }
    const attached = [];
    for (const f of files) {
      const image = /^image\//.test(f.mime || "");
      if (image) {
        const size = Math.floor(String(f.data || "").length * 3 / 4);
        attached.push({ name: f.name, image: true, mime: f.mime, data: f.data, preview: size <= IMAGE_PREVIEW_MAX ? "data:" + f.mime + ";base64," + f.data : undefined });
      } else {
        const bytes = Uint8Array.from(atob(f.data || ""), (c) => c.charCodeAt(0));
        const path = await this.sessions.upload(f.name || "attachment", bytes, f.mime);
        attached.push({ name: f.name, image: false, path });
      }
    }
    const blocks = kasPromptBlocks(text, contexts, attached);
    const checkpoint = await this.checkpointBeforeTurn(t, msg.display || text);
    this.post({ type: "user", id: t.id, local: msg.local || undefined, checkpoint, text: msg.display || text.trim() || blocks[blocks.length - 1].text, contexts: contexts.map((c) => contextChipEcho(c)), files: attached.map((a) => ({ name: a.name, path: a.path, image: a.image, data: a.preview })) });
    const accepted = await link.request({ op: "prompt", sessionId: k.sessionId, blocks });
    this.applyKasMessages(t, kasFramesToMessages(accepted, k));
    this.pushTabs();
  }
  /** Approve / Reject on a Kiro-mode approval card: the parked request is answered with the matching ACP option. */
  async kasApprove(t, requestId, action) {
    const k = t.kas;
    const rid = /^\d+$/.test(String(requestId)) ? Number(requestId) : String(requestId);
    const ask = (k && k.asks && k.asks[rid]) || null;
    const choice = kasPermissionChoice(ask ? ask.options : [], action);
    await this.kasLink().ready();
    this.kasLink().send({ op: "answer", requestId: rid, optionId: choice || undefined, cancel: !choice });
  }
  /** A Kiro-mode question card: the chosen option's title is the `_kiro/userInput` answer; Dismiss cancels it. */
  async kasAnswer(t, askId, answers, dismissed) {
    const raw = String(askId || "").replace(/^kas:/, "");
    const rid = /^\d+$/.test(raw) ? Number(raw) : raw;
    const answer = Object.values(answers || {}).map((v) => String(v)).filter(Boolean)[0] || "";
    await this.kasLink().ready();
    this.kasLink().send({ op: "answer", requestId: rid, answer: dismissed ? undefined : answer, cancel: Boolean(dismissed) || !answer });
  }
  /** Stop on a Kiro-mode tab: `session/cancel`; the turn ends with stopReason `cancelled`. */
  async kasStop(t) {
    if (!t.kas || !t.kas.sessionId) return;
    t.stopped = true;
    await this.kasLink().ready();
    this.kasLink().send({ op: "cancel", sessionId: t.kas.sessionId });
  }
  /** Autopilot / model / effort / mode on a live Kiro-mode tab go to KAS through `config`. */
  async kasConfig(t, patch) {
    if (!t.kas || !t.kas.sessionId) return;
    const link = this.kasLink();
    await link.ready();
    const reply = await link.request(Object.assign({ op: "config", sessionId: t.kas.sessionId }, patch));
    if (reply && reply.autopilot !== undefined) { t.kas.autopilot = Boolean(reply.autopilot); t.settings.autopilot = t.kas.autopilot; }
    if (reply && reply.mode) { t.kas.mode = reply.mode; t.settings.mode = reply.mode; }
    for (const note of (reply && reply.notes) || []) this.post({ type: "status", id: t.id, text: String(note) });
    this.saveTabs();
    this.pushTabs();
  }
  // -- spec actions on Kiro's engine (requirements 5.1–5.3, 5.6, 5.7) -----------
  /**
   * The engine spec actions run on: "kas" when `kirocrew.specEngine` is kas, or
   * when the tab in front is a Kiro-mode tab (the user picked Spec / Quick Spec /
   * Bug Fix / Plan from the Kiro modes group, so a Specs-view click should run on
   * that engine too), AND kiro-cli is usable; else "gateway".
   */
  async specEngine() {
    const front = this.tab(this.active);
    const wanted = cfg("specEngine", "gateway") === "kas" || (front && isKasTab(front));
    if (!wanted) return "gateway";
    const status = await kasStatus();
    return status && status.available ? "kas" : "gateway";
  }
  /** One `_kiro/spec/*` call through the Kas_Link; a method the installed KAS lacks rejects with `.methodNotFound`. */
  async kasSpec(method, params) {
    const link = this.kasLink();
    await link.ready();
    try {
      const reply = await link.request({ op: "spec", method, params });
      return reply && reply.result;
    } catch (error) {
      if (error && error.frame && error.frame.code === -32601) error.methodNotFound = true;
      throw error;
    }
  }
  /**
   * Run a spec action on the engine `specEngine()` picks: `viaKas()` on Kiro's
   * engine, else `viaGateway()` (the existing Send_Path, unchanged). A spec
   * method the installed KAS does not implement (-32601) falls back to the
   * gateway once, with a status row and a status-bar note saying so; any other
   * KAS error is the caller's.
   */
  async specAction(viaKas, viaGateway) {
    if ((await this.specEngine()) !== "kas") return viaGateway();
    try {
      return await viaKas();
    } catch (error) {
      if (!(error && error.methodNotFound)) throw error;
      log("Kiro's engine lacks a spec method (" + error.message + "); this action runs on the gateway");
      vscode.window.setStatusBarMessage("KiroCrew: Kiro's engine does not implement this spec method; running it on the gateway", 6000);
      const t = this.tab(this.active);
      if (t) this.post({ type: "status", id: t.id, text: "Kiro's engine (kiro-cli) does not implement this spec method; the mod's own version runs on the gateway instead." });
      return viaGateway();
    }
  }
  /**
   * A spec action on Kiro's engine (design §Spec operations): resolve the
   * feature's spec session (`fresh` for createSpec, `reuse` otherwise), open or
   * focus it as a Kiro-mode tab, then `_kiro/spec/invoke` with `op` and `args`.
   * The tab carries the spec (findSpecTab) and the task link (engine kas) but
   * NO run record: Kiro's orchestrator owns resume through its checkpoint, so
   * the mod's resume logic never touches these tabs. Returns the tab.
   */
  async runKasSpec(op, args, { feature, dir, title, link, tab } = {}) {
    const root = this.sessions.projectPath();
    // Every spec action opens its own chat, so each operation resolves a FRESH KAS
    // session (Kiro's IDE does the same for executeTask and runAllTasks).
    const params = { strategy: "fresh", workspacePaths: [root] };
    if (feature && op !== "createSpec") params.featureName = feature;
    const resolved = await this.kasSpec("_kiro/spec/resolveSession", params);
    const sessionId = resolved && resolved.sessionId;
    if (!sessionId) throw new Error("_kiro/spec/resolveSession returned no session");
    await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
    const t = await this.openKas(sessionId, { mode: "spec", title: title || ("Kiro spec" + (feature ? ": " + feature : "")), adopt: tab || null });
    t.kind = "kas";
    t.spec = feature ? specTabRecord({ name: feature, dir: dir && dir.path !== undefined ? dir.path : dir }) : null;
    t.run = null;
    t.link = typeof link === "string" && link ? link : null;
    t.stopped = false;
    if (title && !t.renamed) t.title = String(title).slice(0, 60);
    if (!t.kas.noticeShown) { this.post({ type: "status", id: t.id, text: KAS_TAB_NOTICE }); t.kas.noticeShown = true; }
    this.saveTabs();
    this.pushTabs();
    if (t.link && taskSessionLinks()) taskSessionLinks().setSession(t.link, sessionId);
    // The workspace as it is before Kiro's engine writes anything, so this run's message
    // offers "Revert changes" like every other turn; applyKasMessages puts the id on the
    // user bubble KAS echoes for the invoke.
    t.kas.pendingCheckpoint = (await this.checkpointBeforeTurn(t, title || op)) || null;
    await this.kasSpec("_kiro/spec/invoke", Object.assign({ operation: op, sessionId }, args));
    t.kas.running = true;   // the invoke's turn (KAS echoes its user message; turnEnd closes it)
    this.pushTabs();
    // The task metadata is polled while this run is live (requirement 5.4), event or not.
    if (feature && kasTasks() && (op === "executeTask" || op === "runAllTasks")) kasTasks().track(feature, () => Boolean(t.kas && t.kas.running));
    return t;
  }
  /**
   * The spec's existing documents as absolute paths — `specDocuments` of the
   * `_kiro/spec/invoke` operations — and its tasks.md path.
   */
  static kasSpecDocuments(spec) {
    const dir = spec.dir.path !== undefined ? spec.dir.path : String(spec.dir);
    const files = SPEC_MODEL_FILES.filter((f) => spec.present && spec.present[f]);
    return { specDocuments: files.map((f) => dir + "/" + f), tasksFilePath: dir + "/tasks.md" };
  }
  async onMessage(msg) {
    try {
      if (msg.type === "ready") { this.onReady(); return; }
      if (msg.type === "highlight") { this.post(Object.assign({ type: "highlighted", req: msg.req }, await nativeHighlight(msg.text))); return; }
      if (msg.type === "select") { this.select(msg.id); return; }
      if (msg.type === "close") { this.closeTab(msg.id); return; }
      if (msg.type === "new") { this.newTab(); return; }
      if (msg.type === "rename") { await this.renameTab(msg.id); return; }
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
      } else if (msg.type === "image" && msg.path) {
        this.post(Object.assign({ type: "image", id: t.id, path: msg.path }, await imageData(msg.path)));
      } else if (msg.type === "stop" && isKasTab(t)) {
        await this.kasStop(t);
      } else if (msg.type === "stop" && t.key) {
        t.stopped = true; // a run the user stopped is not resumed on its own
        this.noteLinkOutcome(t, "stopped");
        await this.sessions.stop(t.key);
      } else if (msg.type === "resume" && isKasTab(t)) {
        await this.kasAttach(t, "reload");
      } else if (msg.type === "resume" && t.key) {
        await this.resume(t, "button");
      } else if (msg.type === "approve" && isKasTab(t)) {
        await this.kasApprove(t, msg.requestId, msg.action);
      } else if (msg.type === "approve" && t.key) {
        await this.sessions.approve(t.key, msg.requestId, msg.action);
      } else if (msg.type === "dashboard" && isKasTab(t)) {
        this.post({ type: "status", id: t.id, text: "Kiro-mode sessions live in kiro-cli's own store on the gateway host (not in KiroCrew's); the mod's FloofyCrew page lists them." });
      } else if (msg.type === "dashboard" && t.key) {
        vscode.env.openExternal(vscode.Uri.parse(ORIGIN + "/chat/" + encodeURIComponent(t.key)));
      } else if (msg.type === "answer" && isKasTab(t) && msg.card && /^kas:/.test(String(msg.card.ask_id || ""))) {
        await this.kasAnswer(t, msg.card.ask_id, msg.answers || {}, Boolean(msg.dismissed));
      } else if (msg.type === "answer" && t.key) {
        await this.answer(t.key, msg.card, msg.answers || {}, Boolean(msg.dismissed));
      } else if (msg.type === "open") {
        await openPathLink(msg.path, msg.line, msg.column);
      } else if (msg.type === "revert" && msg.checkpoint) {
        await this.revertTo(t, String(msg.checkpoint), { undoOf: msg.undoOf ? String(msg.undoOf) : "" });
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
    const text = String(msg.text || "");
    const files = Array.isArray(msg.files) ? msg.files : [];
    const contexts = Array.isArray(msg.contexts) ? msg.contexts : [];
    if (!text.trim() && !files.length && !contexts.length) return;
    // The page drew this turn's bubble already (`msg.local`) and set its pane to running;
    // should anything below throw, the error row lands under it and the pane is released.
    const release = () => { if (msg.local) this.post({ type: "done", id: t.id }); };
    if (isKasTab(t)) {
      try { await this.kasSend(t, msg); } catch (error) { release(); throw error; }
      return;
    }
    try { await this._send(t, msg, text, files, contexts); } catch (error) { release(); throw error; }
  }
  async _send(t, msg, text, files, contexts) {
    const s = t.settings;
    text = String(text || "");
    // A new turn supersedes the judgement of the last one.
    if (t.runCheck) { clearTimeout(t.runCheck); t.runCheck = null; }
    t.turnError = ""; t.stopped = false; t.lastAssistant = "";
    // Kiro's own modes run in kiro-cli through a Kiro-mode tab (kasSend); a gateway tab
    // runs the mod's prompt-guided workflow frame on the picked agent.
    const agent = s.agent;
    const fresh = !t.key;
    if (!t.key) {
      // A draft tab the user renamed keeps that title and hands it to the new session.
      t.key = await this.sessions.create({ agent, kind: t.kind || "chat", title: t.pendingTitle || (t.renamed ? t.title : undefined) });
      if (!t.renamed) t.title = t.pendingTitle || (text || (files[0] && files[0].name) || "New chat").slice(0, 40);
      delete t.pendingTitle;
      this.saveTabs();
      this.pushTabs();
      this.post({ type: "session", id: t.id, key: t.key });
      // A task run's link learns its session now that the gateway has named it.
      if (t.link && taskSessionLinks()) taskSessionLinks().setSession(t.link, t.key);
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
      const image = /^image\//.test(f.mime || "");
      // The bytes are at hand: an image under the preview cap goes back to the page as a data URL
      // for its thumbnail, so the bubble shows the picture without a round trip to the disk.
      attached.push({ name: f.name, path, image, data: image && bytes.length <= IMAGE_PREVIEW_MAX ? "data:" + f.mime + ";base64," + f.data : undefined });
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
    const frame = workflowContext(s.mode, this.sessions.projectPath());
    if (frame) await this.sessions.inject(t.key, frame, "kirocrew-ide workflow").catch((e) => this.post({ type: "error", id: t.id, text: "workflow: " + e.message }));
    if (!text.trim()) text = attached.length ? "See the attached file(s)." : "See the context provided.";
    // A session's first turn says what steers it (Kiro's IDE shows the included steering as context).
    if (steered && steered.note) this.post({ type: "status", id: t.id, text: steered.note });
    // The transcript shows what was typed (the chips name the files; a provider's chip keeps
    // its glyph and note, see contextChipEcho); the markers are for the host.
    // `local` names the bubble the page drew at send time, which this message completes.
    const checkpoint = await this.checkpointBeforeTurn(t, msg.display || typed || text);
    this.post({ type: "user", id: t.id, local: msg.local || undefined, checkpoint, text: msg.display || typed || text, contexts: contexts.map((c) => contextChipEcho(c)), files: attached.map((a) => ({ name: a.name, path: a.path, image: a.image, data: a.data })) });
    const meta = attached.length ? { files: attached.map((a) => a.path) } : undefined;
    // The gateway's unavailable-agent refusal can arrive as the turn's streamed error
    // row; onFrame resends this turn once from here (set before the POST so the row
    // cannot outrun it).
    t.retryTurn = { text, agent: gatewayAgent(agent), meta, tried: false };
    try {
      await this.sessions.send(t.key, text, agent, meta);
    } catch (error) {
      // An old session pinned to an agent the gateway no longer has (a retired
      // kiro-spec-plan handle such as "spec"): re-pin to the crew default once and resend.
      if (!(await this.repinUnavailableAgent(t, error && error.message))) throw error;
      t.retryTurn.tried = true;
      await this.sessions.send(t.key, text, gatewayAgent(agent), meta);
    }
  }
  /**
   * The gateway's "Bot 'X' is unavailable; restore it or choose a member" on a
   * session whose recorded agent is one of KAS's mode ids (left by the retired
   * kiro-spec-plan handles): re-pin the slot and the tab to the crew default,
   * tell the transcript once, and answer true so the caller resends. Any other
   * agent or text answers false. Once per tab, so a second refusal surfaces.
   */
  async repinUnavailableAgent(t, text) {
    const name = unavailableAgentOf(text);
    if (!name || !GATEWAY_RESERVED_AGENT_IDS.has(name) || !t.key || isKasTab(t)) return false;
    if (t.repinned) return false;
    t.repinned = true;
    t.settings.agent = ""; if (t.settings.baseAgent !== undefined) t.settings.baseAgent = "";
    if (this.lastSettings && GATEWAY_RESERVED_AGENT_IDS.has(String(this.lastSettings.agent || ""))) this.lastSettings.agent = "";
    await this.sessions.setSlotAgent(t.key, "").catch(() => undefined);
    this.saveTabs(); this.pushTabs();
    this.post({ type: "status", id: t.id, text: "This session was pinned to '" + name + "', a Kiro mode id the gateway cannot run (it came from the retired kiro-spec-plan handles). It now runs on the crew default agent; pick another agent from the picker if you want one. Kiro's own modes run in kiro-cli through the Kiro modes group." });
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
   * their modes. Names the agent.
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
   * bar shows the mode. `text` may be a function (called with null; the
   * callers' task-run texts take the engine's own request or the mod's own,
   * and on the gateway path it is always the mod's). `display`
   * is what the transcript shows for the turn (Kiro shows "Execute Task: …"
   * while sending the engine its longer request); `autopilot` approves every
   * tool of the session, as Kiro's IDE does for task runs. Neither is
   * inherited by the next tab. `spec` ({ name, dir }) names the spec the tab
   * works on, so a later phase turn finds it (findSpecTab); `contexts` are
   * `#` context items (the sibling documents of a spec turn) injected before
   * the text, as the composer's chips are. `link` is the id of the
   * TaskSessionLinks record of a task run: the tab fills in its session id
   * once created and its outcome when the turn ends. Returns the session key.
   */
  async dispatch(text, { mode, agent, title, kind, display, autopilot, run, spec, contexts, link, engine, tab } = {}) {
    // `tab` is a tab beginSpecRun already prepared and drew the starting row in, so a
    // Specs-view click shows the chat working before the engine probe and the session
    // create; without one the tab is made here, as every other programmatic turn does.
    const t = tab || this.newTab(true);
    // A spec turn runs on the gateway path unless the caller asks for Kiro's engine
    // (task 7's specEngine); the inherited `engine: "kas"` of the last tab must not decide it.
    t.settings.engine = engine === "kas" ? "kas" : "";
    if (engine === "kas") { t.kind = "kas"; t.kas = kasTabState({ mode: mode || "spec" }); }
    if (mode) t.settings.mode = mode;
    if (gatewayAgent(agent)) t.settings.agent = gatewayAgent(agent);
    if (autopilot) t.settings.autopilot = true;
    t.kind = kind || "spec";
    // A task run remembers what it runs, so the host's turn ceiling can be
    // resumed from tasks.md (see onTurnLimit); `resumed` counts those resumes.
    t.run = run ? Object.assign({ resumed: 0 }, run) : null;
    t.spec = specTabRecord(spec) || (run ? specTabRecord({ name: run.spec, dir: run.dir }) : null);
    t.link = typeof link === "string" && link ? link : null;
    t.pendingTitle = title;
    this.pushTabs();
    const body = typeof text === "function" ? text(null) : text;
    const local = this.earlyBubble(t, display || body, contexts);
    await this.send(t, { text: body, display, local, contexts: Array.isArray(contexts) ? contexts.slice() : undefined });
    return t.key;
  }
  /**
   * The tab a spec action runs in, prepared and on screen BEFORE the slow part
   * (the engine probe, re-reading the spec, creating the session): a fresh tab,
   * selected, with a "starting…" row and the working foxes going, so a click in
   * the Specs view answers at once. The caller passes the tab to `dispatch`
   * (gateway) or lets `openKas` adopt it (Kiro's engine picks up the selected
   * keyless tab), so either engine lands in this tab and the row is replaced by
   * the turn's own bubble.
   */
  beginSpecRun({ mode, agent, title, kind, display, autopilot, run, spec, link } = {}) {
    const t = this.newTab(true);
    t.settings.engine = "";
    if (mode) t.settings.mode = mode;
    if (gatewayAgent(agent)) t.settings.agent = gatewayAgent(agent);
    if (autopilot) t.settings.autopilot = true;
    t.kind = kind || "spec";
    t.run = run ? Object.assign({ resumed: 0 }, run) : null;
    t.spec = specTabRecord(spec) || (run ? specTabRecord({ name: run.spec, dir: run.dir }) : null);
    t.link = typeof link === "string" && link ? link : null;
    t.pendingTitle = title;
    if (title && !t.renamed) t.title = String(title).slice(0, 40);
    this.pushTabs();
    this.post({ type: "starting", id: t.id, text: String(display || title || "Starting") + " — starting…" });
    return t;
  }
  /**
   * Draw a programmatic turn's bubble (and start the working foxes) NOW, before
   * the session is created and the picks, steering and contexts go out, each a
   * round trip: the page draws the turn from the display text under a local id
   * ("d<n>"), and _send's own 'user' message for the turn completes that bubble
   * in place, the page's rule for composer sends. Returns the local id to pass
   * to send(); undefined (nothing drawn) for a Kiro-mode tab or an empty text.
   */
  earlyBubble(t, shown, contexts) {
    const text = String(shown || "");
    if (isKasTab(t) || !text) return undefined;
    const local = "d" + (++this.dispatchSeq);
    const early = Array.isArray(contexts) ? contexts.slice() : [];
    this.post({ type: "user", id: t.id, local, text, contexts: early.map((c) => contextChipEcho(c)), files: [] });
    return local;
  }
  /**
   * The tab working on the spec `feature` (its directory `dir` when given, so
   * two workspace folders with a spec of the same name stay apart): one with
   * a Run_Record for the spec (a task run), or one a phase turn opened for it
   * (`t.spec`). The newest IDLE one wins, so a phase turn lands in the session
   * that already holds the spec's context; with none idle the newest match is
   * returned and the caller sees it running. Null when no tab is the spec's.
   */
  findSpecTab(feature, dir) {
    const name = String(feature || "");
    if (!name) return null;
    const matches = this.tabs.filter((x) => x.key && !isKasTab(x) && specTabMatches(x, name, dir));
    if (!matches.length) return null;
    const idle = matches.filter((x) => { const slot = this.sessions.slot(x.key); return !(slot && slot.running); });
    return (idle.length ? idle : matches)[(idle.length ? idle : matches).length - 1];
  }
  /**
   * Send one spec turn (`kind`: create | generate | update | fix | review; see
   * specTurnText) on the spec `feature`, the way the title-bar actions, the
   * Specs view and the review comments do: the Spec_Agent (`kirocrew.specAgent`,
   * Spec mode) on the gateway, or Kiro's own engine when `kirocrew.specEngine` is kas,
   * always in its OWN new chat (a spec action never continues the spec's last
   * session; the documents it needs travel as contexts), the sibling documents
   * that exist attached as `#file` contexts through the Send_Path, and
   * `opts.displayText` (or the kind's short label) as the transcript's bubble in
   * place of the long request. `opts`: { dir, displayText, title, idea, task,
   * body, autopilot, run, tab }. Returns { key, reused }.
   */
  async sendSpecTurn(feature, kind, document, opts = {}) {
    const name = String(feature || "");
    const file = specDocumentName(document || "");
    // The chat answers the click FIRST: focus the view, then draw the starting row and
    // the working foxes in a fresh tab — before reading the specs, probing the engine
    // and creating the session, each of which is a round trip the user used to wait
    // through with nothing on screen.
    await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
    const prepared = opts.tab || this.beginSpecRun({
      mode: "spec", agent: cfg("specAgent", "") || undefined, kind: "spec",
      title: opts.title || "", display: opts.displayText || opts.title || (name ? "spec " + name : "Spec"),
      autopilot: Boolean(opts.autopilot), run: opts.run || null,
    });
    try {
      return await this.sendSpecTurnIn(name, kind, file, Object.assign({}, opts, { tab: prepared }));
    } catch (error) {
      // Nothing was sent, so the prepared tab has no session: drop it rather than leave
      // an empty chat with a starting row that will never finish.
      if (!prepared.key && !opts.tab) this.closeTab(prepared.id);
      throw error;
    }
  }
  /** `sendSpecTurn`'s body, with the spec named by `name` and the tab already prepared in `opts.tab`. */
  async sendSpecTurnIn(name, kind, file, opts) {
    const specs = await listSpecs();
    let spec = specs.find((s) => s.name === name && (!opts.dir || sameDir(s.dir.path, opts.dir.path !== undefined ? opts.dir.path : opts.dir))) || null;
    if (!spec && opts.dir && kind === "create") {
      // A spec whose directory was written a moment ago (the ＋ flow): the listing has nothing to parse yet.
      const dir = opts.dir.path !== undefined ? opts.dir : vscode.Uri.file(String(opts.dir));
      const workspace = (vscode.workspace.workspaceFolders || []).find((f) => String(dir.path).startsWith(f.uri.path + "/")) || (vscode.workspace.workspaceFolders || [])[0];
      if (!workspace) throw new Error("open a folder first");
      spec = { name, dir, present: {}, tasks: [], taskTree: [], tasksText: "", workspace, config: await readSpecConfig(dir) };
    }
    if (!spec) throw new Error("spec " + name + " is not in the workspace");
    const text = specTurnText(kind, file, Object.assign({}, opts, { spec }));
    const display = opts.displayText || specTurnDisplay(kind, file, Object.assign({}, opts, { spec }));
    const title = opts.title || specTurnTitle(kind, file, Object.assign({}, opts, { spec }));
    if ((await this.specEngine()) === "kas") {
      // Kiro's engine: createSpec / generateDocument are its own operations (design §Spec
      // operations); a review or fix turn is the mod's text, sent as a prompt into the
      // spec's KAS session. A method KAS lacks falls back to the gateway path below.
      const viaKas = async () => {
        const docs = ChatView.kasSpecDocuments(spec);
        if (kind === "create") {
          const t = await this.runKasSpec("createSpec", { userPrompt: String(opts.idea || text) }, { feature: spec.name, dir: spec.dir, title, tab: opts.tab || null });
          return { key: t.key, reused: false, engine: "kas" };
        }
        if (kind === "generate" || kind === "update") {
          const documentType = String(file || "").replace(/\.md$/, "") || "requirements";
          const t = await this.runKasSpec("generateDocument", { featureName: spec.name, specDocuments: docs.specDocuments, documentType, action: kind === "generate" ? "create" : "update" }, { feature: spec.name, dir: spec.dir, title, tab: opts.tab || null });
          return { key: t.key, reused: false, engine: "kas" };
        }
        // A review or fix turn also gets its own chat (strategy "fresh"), like every other spec action.
        const resolved = await this.kasSpec("_kiro/spec/resolveSession", { featureName: spec.name, strategy: "fresh", workspacePaths: [this.sessions.projectPath()] });
        await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
        const t = await this.openKas(resolved.sessionId, { mode: "spec", title, adopt: opts.tab || null });
        t.spec = specTabRecord({ name: spec.name, dir: spec.dir.path });
        await this.send(t, { text, display, contexts: await specSiblingContexts(spec, file) });
        return { key: t.key, reused: false, engine: "kas" };
      };
      try {
        const out = await viaKas();
        vscode.window.setStatusBarMessage("KiroCrew: " + display + " — Kiro's engine, session " + out.key.replace(/^kas:/, ""), 5000);
        return out;
      } catch (error) {
        if (!(error && error.methodNotFound)) throw error;
        vscode.window.setStatusBarMessage("KiroCrew: Kiro's engine does not implement this spec method; running it on the gateway", 6000);
        const t = this.tab(this.active);
        if (t) this.post({ type: "status", id: t.id, text: "Kiro's engine (kiro-cli) does not implement this spec method; the mod's own version runs on the gateway instead." });
      }
    }
    const contexts = await specSiblingContexts(spec, file);
    await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
    // Every spec action opens its own chat: a phase turn is a fresh session, not a
    // continuation of whatever the spec's last tab was doing. The documents it needs
    // travel as contexts, so nothing is lost by starting clean.
    const key = await this.dispatch(text, {
      mode: "spec", agent: cfg("specAgent", "") || undefined, title, kind: "spec", display, contexts,
      autopilot: Boolean(opts.autopilot), run: opts.run || null, spec: { name: spec.name, dir: spec.dir.path },
      tab: opts.tab || null,
    });
    vscode.window.setStatusBarMessage("KiroCrew: " + display + " — session " + key, 5000);
    return { key, reused: false };
  }
  /**
   * The tab a turn from outside the composer lands in (the editor actions of
   * requirement 10): the tab in front when its session is idle (or has none
   * yet), else a fresh one, so a running session is never interrupted.
   */
  idleTab() {
    const t = this.tab(this.active);
    const slot = t && t.key && !isKasTab(t) ? this.sessions.slot(t.key) : null;
    const running = isKasTab(t) ? Boolean(t.kas && t.kas.running) : Boolean(slot && slot.running);
    if (t && !running) return t;
    return this.newTab(true);
  }
  /** Resolves once the page has said `ready` (or after `timeout` ms): a message posted before that is lost. */
  async whenReady(timeout = 3000) {
    const until = Date.now() + timeout;
    while (!this.ready && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    return Boolean(this.ready);
  }
  /**
   * Put context chips in the composer of the idle tab without sending — the
   * page's `context` message, the one the `#` picker's answers take — and give
   * the composer focus so the user types the message ("Ask about this").
   * Returns the tab.
   */
  async stageContexts(contexts) {
    await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
    await this.whenReady();
    const t = this.idleTab();
    this.select(t.id);
    for (const item of contexts || []) if (item) this.post({ type: "context", id: t.id, item });
    this.post({ type: "compose.focus" });
    return t;
  }
  /**
   * Put text into the composer without sending ("Add code block to chat"): the
   * view is revealed, the page's `compose.insert` puts `text` at the caret (on
   * its own line when the composer already has text) and focuses the composer.
   * The composer is shared by the tabs, so the tab in front keeps the focus; a
   * view with no tab yet gets one so the text has somewhere to go.
   */
  async insertComposerText(text) {
    await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
    await this.whenReady();
    if (!this.tab(this.active)) this.newTab(true);
    this.post({ type: "compose.insert", text: String(text || "") });
  }
  /**
   * Send one turn with context entries from outside the composer: the chat view
   * is revealed, the idle tab takes the turn through the Send_Path (`send`), and
   * `opts.displayText` is the transcript's bubble in place of `text`. Returns the
   * tab's session key.
   */
  async sendWithContexts(text, contexts, opts = {}) {
    await vscode.commands.executeCommand("kirocrew.chat.focus").then(undefined, () => undefined);
    const t = this.idleTab();
    this.select(t.id);
    await this.send(t, { text: String(text || ""), display: opts.displayText || undefined, contexts: Array.isArray(contexts) ? contexts.slice() : [] });
    return t.key;
  }
  /**
   * Continue a tab whose turn the host cut at its ceiling: a task run re-reads
   * tasks.md and sends the run's own request again (Kiro's engine request on
   * the Spec agent, the paraphrase otherwise), skipping what is ticked; a plain
   * chat sends a continuation. `why` is "limit" (automatic) or "button".
   * Nothing is sent while the session is still running or when nothing is left.
   */
  async resume(t, why) {
    if (!t.key) return false;
    const slot = this.sessions.slot(t.key);
    if (slot && slot.running) { this.post({ type: "status", id: t.id, text: "The session is still running; nothing to resume." }); return false; }
    if (t.run) {
      const r = await resumeRequest(t.run, null);
      if (!r.text) { this.post({ type: "status", id: t.id, text: "Nothing to resume: " + r.reason + "." }); return false; }
      log("resume (" + why + ") " + t.key + ": " + r.display);
      await this.send(t, { text: r.text, display: r.display });
      return true;
    }
    log("resume (" + why + ") " + t.key + ": plain continuation");
    await this.send(t, { text: RESUME_CHAT_TEXT });
    return true;
  }
  /**
   * A turn on this tab ended (`chat_done`), or the host posted a failure row.
   * Whether the task run is finished is judged a moment later from tasks.md
   * (see checkRun), not from the error text: the ⏱ card, "Connection
   * unstable", a backend error and a model that simply stopped all leave the
   * same evidence in the file, and only the file says whether work is left. A
   * failure row records the reason for the message; the turn-ceiling card is
   * the one row the host guarantees is terminal (it follows the turn's
   * `chat_done`), so it arms the check itself; any other error row only joins
   * a check that `chat_done` already armed, since the host also posts
   * non-terminal ones mid-turn ("⟳ Connection unstable — resuming…").
   */
  noteTurnEnd(t, { done, error } = {}) {
    if (error) t.turnError = String(error);
    if (!done && !t.runCheck && !(error && isTurnLimitRow({ role: "error", content: error }))) return;
    // The task run's link learns how its turn ended: a stop the user asked for,
    // a failure row (this one, or one the turn posted earlier), else ok.
    this.noteLinkOutcome(t, t.stopped ? "stopped" : (error || t.turnError) ? "error" : "ok");
    if (t.runCheck) clearTimeout(t.runCheck);
    t.runCheck = setTimeout(() => {
      t.runCheck = null;
      this.checkRun(t, "turn").catch((e) => this.post({ type: "error", id: t.id, text: "resume: " + e.message }));
    }, this.settleMs != null ? this.settleMs : RESUME_SETTLE_MS);
  }
  /**
   * The run this tab carries: the record `dispatch` kept, or, for a Spec tab
   * without one (a tab from before the record existed, a run the dashboard
   * started, a window reloaded mid-run), the one spec of the project whose
   * tasks.md still carries Kiro's `[~]` / `[-]` marks — the orchestrator writes
   * those as it goes and leaves none behind when it finishes, so they are the
   * run's own trace. Adopted onto the tab (`derived`), so later checks and the
   * resume count see the same run. Several such specs: none is guessed.
   */
  async runOf(t) {
    if (t.run) return t.run;
    if (!isSpecTab(t)) return null;
    const specs = await listSpecs();
    const interrupted = specs.filter((s) => s.tasks.some((x) => x.leaf && (x.queued || x.partial)));
    if (interrupted.length !== 1) return interrupted.length ? { several: interrupted.map((s) => s.name) } : null;
    const s = interrupted[0];
    t.run = { resumed: 0, spec: s.name, dir: s.dir.path, task: null, optional: s.tasks.some((x) => x.leaf && (x.queued || x.partial) && x.optional), display: "Run all tasks", derived: true };
    this.saveTabs();
    return t.run;
  }
  /**
   * Judge the tab's run against tasks.md and act. Unfinished means: the run's
   * spec still has queued (`[~]`) or in-progress (`[-]`) rows, or — for a run
   * this IDE dispatched, which asked for every remaining task — required rows
   * still open; and the session is idle. Then, unless the user stopped it, a
   * question is waiting, or the turn ended on what reads as a question, the
   * run resumes itself (`kirocrew.specAutoResume`, up to `specResumeLimit`);
   * otherwise, and at startup, a card with a Resume button says what is left.
   * `when` is "turn" or "startup".
   */
  async checkRun(t, when) {
    if (!t.key) return false;
    const error = t.turnError || ""; t.turnError = "";
    const stopped = Boolean(t.stopped); t.stopped = false;
    const run = await this.runOf(t);
    if (!run) return false;
    if (run.several) {
      this.post({ type: "interrupted", id: t.id, text: "Several specs carry an interrupted run (" + run.several.join(", ") + "); resume the right one from the Specs view (its ⟳ Resume run)." });
      return false;
    }
    const slot = this.sessions.slot(t.key);
    if (slot && slot.running) return false;
    const limit = isTurnLimitRow({ role: "error", content: error });
    const state = await runState(run);
    const unfinished = state && (state.queued || state.partial || (!run.derived && state.remaining));
    // The ceiling card is explicit: even with nothing left, resume() says so (as before).
    if (!unfinished && !limit) return false;
    const left = state ? describeLeft(state) : "";
    const cause = limit ? "The host stopped this turn at its " + turnLimitOf(error) + " limit"
      : error ? "The turn ended on an error (" + clip(error.split("\n")[0], 120) + ")"
      : "The turn ended" + (left ? " with " + left : "") + ", without finishing the run";
    if (stopped) { this.post({ type: "interrupted", id: t.id, text: "Stopped" + (left ? " with " + left : "") + ". Resume run continues from tasks.md.", resume: true }); return false; }
    if (t.questions && t.questions.size) { this.post({ type: "interrupted", id: t.id, text: "The run is waiting on your answer above" + (left ? " (" + left + ")" : "") + "." }); return false; }
    if (!limit && looksLikeQuestion(t.lastAssistant)) { this.post({ type: "interrupted", id: t.id, text: cause + " and seems to be asking you something; answer it, or Resume run to carry on from tasks.md.", resume: true }); return false; }
    if (when === "startup") { this.post({ type: "interrupted", id: t.id, text: "This run was interrupted" + (left ? ": " + left : "") + ", and the session is idle. Resume run continues from tasks.md.", resume: true }); return false; }
    if (cfg("specAutoResume", true) === false) {
      this.post({ type: "status", id: t.id, text: cause + "; auto-resume is off (kirocrew.specAutoResume). " + (limit ? "Continue" : "Resume run") + " resumes the run by hand." });
      if (!limit) this.post({ type: "interrupted", id: t.id, text: left ? "Left in tasks.md: " + left + "." : "The run did not finish.", resume: true });
      return false;
    }
    const cap = Math.max(0, Math.floor(Number(cfg("specResumeLimit", 3))) || 0);
    const resumed = Number(run.resumed) || 0;
    if (resumed >= cap) {
      const times = (resumed + 1) + " time" + (resumed ? "s" : "");
      if (limit) this.post({ type: "error", id: t.id, text: "Stopped at the host's " + turnLimitOf(error) + " limit " + times + " on this run; not resuming again on its own (kirocrew.specResumeLimit = " + cap + "). Continue resumes it by hand; agent.chat_turn_timeout_secs in ~/.kiro/crew/config.json raises the host's limit (up to 24 h)." });
      else this.post({ type: "interrupted", id: t.id, text: cause + ", " + times + " on this run; not resuming again on its own (kirocrew.specResumeLimit = " + cap + "). Resume run continues it by hand.", resume: true });
      return false;
    }
    run.resumed = resumed + 1;
    this.saveTabs();
    this.post({ type: "status", id: t.id, text: cause + "; resuming the run from tasks.md (" + run.resumed + " of " + cap + ")…" });
    try {
      return await this.resume(t, limit ? "limit" : error ? "error" : "unfinished");
    } catch (e) {
      this.post({ type: "error", id: t.id, text: "resume: " + e.message });
      return false;
    }
  }
  /** Kept for callers of the 0.27 name: the ceiling card is one cause the check reads. */
  async onTurnLimit(t, row) { this.noteTurnEnd(t, { error: row.content }); }
  /** Record `outcome` (ok | error | stopped) on the TaskSessionLinks record this tab's run carries, when it carries one. */
  noteLinkOutcome(t, outcome) {
    const links = taskSessionLinks();
    if (!t || !t.link || !links) return null;
    try { return links.setOutcome(t.link, outcome); } catch (e) { log("task session link: " + e.message); return null; }
  }
  /**
   * Resume the run of `spec` from the Specs view or the spec editor. Every spec
   * action opens its own chat, so this starts a fresh run (`dispatch`) that
   * continues from the ticked boxes in tasks.md rather than typing into the
   * session that ran before. What it still refuses is a second run of the same
   * spec while the first is live: that tab is selected and nothing is sent.
   * Returns "running" or "dispatched". (The automatic mid-run resume, when a
   * turn is cut, is a different path and stays in its own session.)
   */
  async resumeSpec(spec, dispatch) {
    let t = this.tabs.find((x) => x.key && x.run && x.run.spec === spec.name && (!x.run.dir || sameDir(x.run.dir, spec.dir.path)));
    if (!t) {
      // A Spec tab without a record adopts the interrupted spec if it is the one.
      for (const x of this.tabs) if (x.key && !x.run && isSpecTab(x) && (await this.runOf(x)) && x.run && x.run.spec === spec.name) { t = x; break; }
    }
    if (t) {
      const slot = this.sessions.slot(t.key);
      if (slot && slot.running) {
        this.select(t.id);
        this.post({ type: "status", id: t.id, text: "The run is still going in this session." });
        return "running";
      }
    }
    await dispatch();
    return "dispatched";
  }
  /** Startup: every restored tab is judged once (card only, never a send) after its history is in. */
  async checkRestoredRuns() {
    for (const t of this.tabs) if (t.key) await this.checkRun(t, "startup").catch((e) => log("run check (startup) " + t.key + ": " + e.message));
  }
  /** A composer pick changed: remember it on the tab (and as the default for new tabs), apply it live when the session exists. */
  async setSetting(t, key, value) {
    if (!["agent", "model", "effort", "mode", "autopilot", "pick"].includes(key)) return;
    const liveKas = isKasTab(t) && t.kas && t.kas.sessionId;
    if (key === "pick") {
      // One picker, Kiro-style: a Kiro mode (kas:<mode>) runs in kiro-cli; a Kiro-mode agent IS the
      // mode; a prompt workflow is a mode on the crew default; else a plain agent.
      const pick = String(value || "");
      const [kind, ...rest] = pick.split(":");
      const name = rest.join(":");
      if (kind === "kas") {
        if (!KAS_MODES.includes(name)) return;
        if (liveKas) { await this.kasConfig(t, { mode: name }); this.lastSettings = Object.assign({}, t.settings); return; }
        if (t.key) { this.post({ type: "status", id: t.id, text: "A Kiro mode runs in kiro-cli, not in this gateway session: open a new tab for it." }); this.pushTabs(); return; }
        t.settings.engine = "kas"; t.settings.mode = name; t.kind = "kas";
        t.kas = t.kas || kasTabState({ mode: name });
        t.kas.mode = name;
      } else {
        if (liveKas) { this.post({ type: "status", id: t.id, text: "This tab runs in kiro-cli; open a new tab for a crew agent." }); this.pushTabs(); return; }
        if (t.settings.engine === "kas") { t.settings.engine = ""; t.kind = undefined; t.kas = undefined; }
        if (kind === "workflow") { t.settings.mode = name || "default"; t.settings.agent = t.settings.baseAgent || ""; }
        else { t.settings.agent = kind === "agent" ? name : ""; t.settings.baseAgent = t.settings.agent; t.settings.mode = "default"; }
      }
      this.lastSettings = Object.assign({}, t.settings);
      this.saveTabs();
      if (t.key && !isKasTab(t)) await this.sessions.setSlotAgent(t.key, t.settings.agent).catch(() => undefined);
      this.pushTabs();
      return;
    }
    t.settings[key] = key === "autopilot" ? Boolean(value) : String(value || (key === "mode" ? "default" : ""));
    this.lastSettings = Object.assign({}, t.settings);
    this.saveTabs();
    if (liveKas) {
      if (key === "autopilot") await this.kasConfig(t, { autopilot: t.settings.autopilot });
      else if (key === "model") await this.kasConfig(t, { model: t.settings.model || "auto" });
      else if (key === "effort") await this.kasConfig(t, { effort: t.settings.effort });
      else if (key === "mode" && KAS_MODES.includes(t.settings.mode)) await this.kasConfig(t, { mode: t.settings.mode });
      this.pushTabs();
      return;
    }
    if (t.key) {
      if (key === "model") await this.sessions.setModel(t.key, t.settings.model);
      else if (key === "effort") await this.sessions.setEffort(t.key, t.settings.effort);
      else if (key === "autopilot") await this.sessions.setTrust(t.key, t.settings.autopilot);
      else if (key === "agent") await this.sessions.setSlotAgent(t.key, t.settings.agent).catch(() => undefined);
    }
    this.pushTabs();
  }
  setAgent(agent) {
    this.agent = gatewayAgent(agent);
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
      case "question_card": (t.questions || (t.questions = new Set())).add(frame.data.ask_id || frame.data.card_id || "q"); this.post({ type: "question", id, card: frame.data }); break;
      case "question_card_resolved": if (t.questions) t.questions.delete(frame.data.ask_id || frame.data.card_id || "q"); this.post({ type: "questionResolved", id, qid: frame.data.ask_id || frame.data.card_id }); break;
      case "chat_chunk": this.post({ type: "chunk", id, text: frame.data.content || "", seq: frame.data.seq }); break;
      case "chat_segment": this.post({ type: "segment", id }); break;
      case "chat_thinking": this.post({ type: "thinking", id, text: frame.data.content || frame.data.text || "" }); break;
      case "chat_status": this.post({ type: "status", id, text: frame.data.status || frame.data.text || "" }); break;
      case "chat_message": {
        const row = normalizeRow(frame.data);
        this.post({ type: "row", id, row });
        // The answer's text decides later whether a stop was a question; a
        // failure row (the ceiling card included) is the reason the run check
        // reads once the turn is judged from tasks.md.
        if (row.role === "assistant" && !isErrorRow(row)) t.lastAssistant = row.content || "";
        if (isErrorRow(row)) {
          // The unavailable-agent refusal streamed as the turn's error row: re-pin once and resend the same turn.
          const retry = t.retryTurn;
          if (retry && !retry.tried && unavailableAgentOf(row.content)) {
            retry.tried = true;
            this.repinUnavailableAgent(t, row.content).then((ok) => ok && this.sessions.send(t.key, retry.text, retry.agent, retry.meta))
              .catch((e) => this.post({ type: "error", id, text: "resend: " + e.message }));
            break;
          }
          this.noteTurnEnd(t, { error: row.content });
        }
        break;
      }
      case "chat_done": this.post({ type: "done", id }); this.noteTurnEnd(t, { done: true }); break;
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
/** Largest image the transcript previews inline (bytes); past it the card names the file and opens it on click. */
const IMAGE_PREVIEW_MAX = 8 * 1024 * 1024;
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif" };
const imageCache = new Map(); // path -> data URL, the last few the page asked for
/**
 * The bytes of an image on the gateway host as a data URL, for the page to show.
 * A webview cannot reach the disk, and the dashboard's uploads live outside the
 * workspace (`~/.kiro/crew/uploads/`), so the extension reads them the way it
 * reads `~/.kiro/crew/config.json`: through the workbench's remote fs, which sees
 * the same disk the sessions write to. Returns `{ data }` or `{ error }`.
 */
async function imageData(rawPath) {
  const path = String(rawPath || "");
  const ext = (path.match(/\.(\w+)$/) || [, ""])[1].toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return { error: "not an image file" };
  if (imageCache.has(path)) return { data: imageCache.get(path) };
  const folders = vscode.workspace.workspaceFolders || [];
  const candidates = [];
  if (path.startsWith("/")) {
    if (folders.length) candidates.push(folders[0].uri.with({ path }));
    candidates.push(vscode.Uri.file(path));
  } else {
    for (const folder of folders) candidates.push(vscode.Uri.joinPath(folder.uri, path.replace(/^\.\//, "")));
  }
  let lastError = "not found";
  for (const uri of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > IMAGE_PREVIEW_MAX) return { error: "too large to preview (" + (stat.size / 1048576).toFixed(1) + " MB)" };
      const bytes = await vscode.workspace.fs.readFile(uri);
      const data = "data:" + mime + ";base64," + bytesToBase64(bytes);
      imageCache.set(path, data);
      while (imageCache.size > 24) imageCache.delete(imageCache.keys().next().value);
      return { data };
    } catch (e) { lastError = (e && e.message) || String(e); }
  }
  return { error: lastError };
}
function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

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

// The `#` picker (requirement 9.1): the file kinds first, then the context
// providers of CONTEXT_PROVIDERS (defined after `pickContext`, which they share
// `readText` and the quick picks with). `icon` is the codicon of a native quick
// pick; `glyph` is what the webview menu, which loads no icon font, draws.
const CONTEXT_FILE_KINDS = [
  { kind: "file", label: "File", icon: "$(file)", glyph: "▤", section: "Files", description: "One workspace file" },
  { kind: "open-files", label: "Currently Open Files", icon: "$(files)", glyph: "▣", section: "Files", description: "Every file open in an editor tab" },
  { kind: "steering", label: "Steering", icon: "$(compass)", glyph: "◎", section: "Files", description: "A steering file of this workspace or ~/.kiro" },
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
// The steering inventory is read on every send (and for the compass). Each directory and
// each file is an RPC through the workbench's remote fs, so the result is kept for a short
// while: a save under .kiro/steering invalidates it at once (the Steering view's watcher),
// and STEERING_CACHE_MS bounds how stale an edit to ~/.kiro/steering can look.
const STEERING_CACHE_MS = 20000;
let steeringCache = null; // { key, at, docs }
function invalidateSteeringCache() { steeringCache = null; }
async function listSteering(root) {
  const key = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.path).join("|");
  if (steeringCache && steeringCache.key === key && Date.now() - steeringCache.at < STEERING_CACHE_MS) return steeringCache.docs;
  const docs = await scanSteering(root);
  steeringCache = { key, at: Date.now(), docs };
  return docs;
}
async function scanSteering(root) {
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

/** Pure: a NUL byte in the first KB marks decoded file text as binary (what the folder resolver and the explorer skip). */
function looksBinary(text) { return String(text || "").slice(0, 1024).includes("\u0000"); }

/**
 * Pure: the `#file` composer entry — `{kind: "file", label, content, paths}`,
 * the content under a `--- path ---` header and clipped to CONTEXT_BUDGET. The
 * `#` picker and the explorer's "Add to chat context" build their entries here.
 */
function fileContextEntry(label, text, uriPath) {
  const entry = { kind: "file", label: String(label || ""), content: "--- " + label + " ---\n" + clip(text, CONTEXT_BUDGET) };
  if (uriPath) entry.paths = [uriPath];
  return entry;
}

/** The `#file` entry of one file on disk, labelled by `rel(uri.path)`. */
async function fileContext(uri, rel) {
  return fileContextEntry(rel(uri.path), new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), uri.path);
}

/**
 * One `#` context item, chosen with the workbench's own pickers: returns
 * { kind, label, content } for the composer chip, or null when cancelled. The
 * content travels as silent background context on the next send.
 */
async function pickContext(kind, root) {
  const rel = (p) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  // The provider kinds (problems, terminal, git-diff, folder, spec) and the pre-registry name of problems.
  const provider = CONTEXT_PROVIDERS.find((p) => p.id === (kind === "diagnostics" ? "problems" : kind));
  if (provider) return providerContext(provider, root);
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
  if (kind === "file") {
    const files = await vscode.workspace.findFiles("**/*", CONTEXT_FIND_EXCLUDE, 4000);
    const picked = await vscode.window.showQuickPick(files.map((u) => ({ label: rel(u.path), uri: u })).sort((a, b) => a.label.localeCompare(b.label)), { placeHolder: "File to add as context", matchOnDescription: true });
    if (!picked) return null;
    return fileContext(picked.uri, rel);
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

// ---- Context providers (requirement 9): the registry the `#` picker lists after
// the file kinds. Each entry is `{id, label, icon, glyph, description, resolve}`;
// `resolve({root, rel})` may prompt (quick picks) and answers null when the user
// cancels or there is nothing to attach, else `{text, label?, note?, paths?}`.
// `providerContext` caps the text (requirement 9.3) and shapes the composer entry
// `{kind, label, content, truncated, note, paths}` — `content` is what `_send`
// injects, the same field a `#file` entry carries, so the Send_Path is unchanged.
// The pure formatters and `capText` are exported for tests.

const CONTEXT_CAP = 64 * 1024; // bytes of resolved text a provider may hand over
// The host refuses a context entry over HOST_CONTEXT_MAX chars and `inject`
// re-clips to fit, which would hide the real cut from the chip; so the cap in
// force is the smaller of the two (a char is at least one byte).
const PROVIDER_CAP = Math.min(CONTEXT_CAP, CONTEXT_BUDGET);
const TERMINAL_TAIL_LINES = 200;  // the "last N lines" of the terminal provider
const TERMINAL_HISTORY_MAX = 20;  // shell executions remembered per terminal
const FOLDER_FILES_MAX = 200;     // files whose contents the folder provider reads at most
const CONTEXT_FIND_EXCLUDE = "{**/node_modules/**,**/.git/**,**/build/**,**/dist/**,**/__pycache__/**}";
const GIT_ABSENT_MESSAGE = "Git diff is unavailable: the built-in git extension is not reachable from this extension host and the gateway's gitdiff route did not answer.";
const SEVERITY_NAMES = ["error", "warning", "info", "hint"]; // vscode.DiagnosticSeverity order

/** UTF-8 size of a string (what the cap counts). */
function byteLength(text) { return new TextEncoder().encode(String(text || "")).length; }

/**
 * Pure: `text` cut to at most `cap` bytes of UTF-8, never inside a surrogate pair,
 * with the marker line `… [truncated: N of M bytes shown]` appended when it was cut
 * → `{text, truncated, shown, total}` (`shown` counts the kept bytes, marker excluded).
 */
function capText(text, cap) {
  const s = String(text === undefined || text === null ? "" : text);
  const limit = Math.max(0, Number(cap) || 0);
  const total = byteLength(s);
  if (total <= limit) return { text: s, truncated: false, shown: total, total };
  let end = Math.min(s.length, limit);
  for (let size = byteLength(s.slice(0, end)); size > limit; size = byteLength(s.slice(0, end))) end -= Math.max(1, Math.ceil((size - limit) / 3));
  if (end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
  const head = s.slice(0, end);
  const shown = byteLength(head);
  return { text: head + "\n… [truncated: " + shown + " of " + total + " bytes shown]", truncated: true, shown, total };
}

/** Pure: the last `n` lines of `text` (trailing blank lines dropped first). */
function tailLines(text, n) {
  const lines = String(text || "").replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - Math.max(1, n | 0))).join("\n");
}

/** Pure: terminal output without its escape sequences (CSI, OSC, single-char ESC) and carriage returns. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-Z\\-_]/g, "").replace(/\r+\n/g, "\n").replace(/\r/g, "");
}

/**
 * Pure: diagnostics as one line each, `path:line:col severity [source code]: message`,
 * grouped per file in the order given. `byFile` is `[[path, diagnostics]]` with
 * vscode-shaped diagnostics (`range.start.{line,character}` zero-based, `severity`
 * 0–3 or a name, `message`, optional `source` and `code` or `code.value`).
 */
function formatProblems(byFile) {
  const out = [];
  for (const [file, list] of byFile || []) {
    for (const d of list || []) {
      const start = (d.range && d.range.start) || { line: 0, character: 0 };
      const sev = typeof d.severity === "number" ? SEVERITY_NAMES[d.severity] || "info" : String(d.severity || "info");
      const code = d.code && typeof d.code === "object" ? d.code.value : d.code;
      const tag = [d.source, code].filter((x) => x !== undefined && x !== null && x !== "").join(" ");
      out.push(file + ":" + (start.line + 1) + ":" + (start.character + 1) + " " + sev + (tag ? " [" + tag + "]" : "") + ": " + String(d.message || "").replace(/\s+/g, " ").trim());
    }
  }
  return out.join("\n");
}

/**
 * Pure: a folder as its listing then each read file under a `--- path ---` header.
 * `entries` are the relative paths (listed in full), `contents` `[{path, text}]`
 * for the files read; `opts.dir` names the folder, `opts.omitted` says how many
 * files were listed but not read (binary, too big, or past the cap).
 */
function formatFolder(entries, contents, opts) {
  const o = opts || {};
  const name = o.dir ? o.dir.replace(/\/+$/, "") + "/" : "the workspace root";
  const parts = ["Folder " + name + " — " + (entries || []).length + " file" + ((entries || []).length === 1 ? "" : "s") + ":\n" + (entries || []).map((e) => "  " + e).join("\n")];
  for (const c of contents || []) parts.push("--- " + c.path + " ---\n" + String(c.text || ""));
  if (o.omitted) parts.push("(" + o.omitted + " listed file" + (o.omitted === 1 ? " is" : "s are") + " not shown: binary, too large, or past the size cap)");
  return parts.join("\n\n");
}

/**
 * Pure: a spec's documents concatenated, each under a `## <file>` header, in the
 * order given; a document that does not exist is noted rather than skipped so
 * the agent sees which phase is still unwritten.
 */
function formatSpec(name, docs) {
  const parts = ["# Spec " + name];
  for (const d of docs || []) parts.push("## " + d.file + "\n\n" + (d.exists === false ? "(not written yet)" : String(d.text || "").replace(/\s+$/, "") || "(empty)"));
  return parts.join("\n\n");
}

/** Pure: one `git diff` as the agent would see it on a shell, with the command it answers. */
function formatGitDiff(diff, opts) {
  const o = opts || {};
  const command = "$ git diff" + (o.staged ? " --cached" : "") + (o.branch ? "   # on " + o.branch : "");
  const body = String(diff || "").replace(/\s+$/, "");
  return command + "\n" + (body || (o.staged ? "(nothing staged)" : "(clean working tree)"));
}

/**
 * Pure: the composer entry for a provider's answer — the text capped to `cap`
 * bytes, `truncated` set, the chip's `note` saying how much was shown (11.2 puts
 * it in the tooltip). `content` is the field `_send` injects, like a `#file` entry.
 */
function providerEntry(provider, result, cap) {
  const capped = capText(result.text, cap === undefined ? PROVIDER_CAP : cap);
  const note = [result.note, capped.truncated ? "Truncated: " + capped.shown + " of " + capped.total + " bytes shown." : ""].filter(Boolean).join(" ");
  const entry = { kind: provider.id, label: result.label || provider.label, content: capped.text, truncated: capped.truncated };
  if (provider.glyph) entry.glyph = provider.glyph;
  if (note) entry.note = note;
  if (result.paths && result.paths.length) entry.paths = result.paths.slice();
  return entry;
}

/**
 * Pure: a context chip's text — the entry's glyph (a provider's own; `#` for the
 * file kinds and steering) then its label, e.g. "⚠ Problems (3, active file)" or
 * "#src/main.js". A bare string is a label, as the file kinds' `user` echo and
 * history rows carry it. Shared with the page (stringified into chatHtml) so the
 * composer and the user bubble draw the same chip.
 */
function contextChipLabel(entry) {
  if (entry == null) return "";
  if (typeof entry !== "object") return "#" + String(entry);
  const glyph = String(entry.glyph || "#");
  const label = String(entry.label || entry.kind || "");
  return glyph === "#" ? "#" + label : glyph + " " + label;
}

/**
 * Pure: the chip's tooltip — the resolver's note (which `providerEntry` ends with
 * "Truncated: N of M bytes shown." when it cut the text, requirement 9.3); an
 * entry marked truncated whose note does not say so gets a plain truncation line.
 * "" when there is nothing to tell, so file chips keep no tooltip.
 */
function contextChipTooltip(entry) {
  if (!entry || typeof entry !== "object") return "";
  const note = String(entry.note || "").trim();
  if (entry.truncated && !/\bTruncated\b/.test(note)) return [note, "Truncated to the size cap."].filter(Boolean).join(" ");
  return note;
}

/**
 * Pure: what the `user` echo and the page's own bubble carry per context — never
 * the content. A plain file or steering entry stays the bare label (what history
 * rows and the sendSpecTurn echo expect); a provider entry keeps the chip fields
 * `{kind, label, glyph, note, truncated}` so the bubble draws the composer's chip.
 */
function contextChipEcho(entry) {
  if (!entry || typeof entry !== "object") return entry;
  if (!entry.glyph && !entry.note && !entry.truncated) return entry.label;
  const out = { kind: entry.kind, label: entry.label, truncated: Boolean(entry.truncated) };
  if (entry.glyph) out.glyph = entry.glyph;
  if (entry.note) out.note = entry.note;
  return out;
}

/** Run one provider for the picker: null when cancelled or empty, else the composer entry. */
async function providerContext(provider, root) {
  const rel = (p) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
  const result = await provider.resolve({ root, rel });
  return result ? providerEntry(provider, result) : null;
}

// ---- Editor actions (requirement 10.1, 10.2): the "KiroCrew" submenu of the
// editor's context menu. Each action attaches the selection as a `#selection`
// context entry (the same `{kind, label, content, truncated, note, glyph, paths}`
// shape the providers hand the Send_Path) and sends its instruction; the
// instruction comes from DEFAULT_ACTION_PROMPTS unless the setting
// `kirocrew.editorActions.prompts` names the action id. "ask" stages the chip in
// the composer and leaves the question to the user.

const EDITOR_ACTION_IDS = ["ask", "fixGrammar", "writeComments", "writeDocstring", "fixCode", "optimize"];
const SELECTION_GLYPH = "✂"; // the chip's glyph for a `#selection` entry
/** The menu titles, also the transcript bubble's text in place of the instruction. */
const EDITOR_ACTION_TITLES = {
  ask: "Ask about this",
  fixGrammar: "Fix grammar and spelling",
  writeComments: "Write comments",
  writeDocstring: "Write a docstring",
  fixCode: "Fix this code",
  optimize: "Optimize this code",
};
/** Our own instruction per action; `kirocrew.editorActions.prompts[id]` overrides it (actionPrompt). */
const DEFAULT_ACTION_PROMPTS = {
  ask: "I have a question about the selected code.",
  fixGrammar: "Fix the grammar, spelling and punctuation in the selected text. Keep the meaning, tone, formatting and any code or identifiers as they are. Apply the fix in the file and list what you changed.",
  writeComments: "Add comments to the selected code where they help a reader: explain the intent and the non-obvious decisions, not what each line does. Follow the comment style of the surrounding file and do not change the code itself. Apply the edit in the file.",
  writeDocstring: "Write a docstring (or the language's equivalent documentation comment) for the selected function, class or module: what it does, its parameters, return value, errors it raises and any side effects, in the file's conventions. Apply the edit in the file without changing the code.",
  fixCode: "Fix the selected code: find the bugs, wrong edge cases and misuses of the APIs it calls, correct them in place with the smallest change that works, and keep the surrounding style. Then say what was wrong and how you verified the fix.",
  optimize: "Optimize the selected code for speed and memory without changing its behaviour or its public interface. Prefer the clear algorithmic win over micro-tuning; keep the file's style. Apply the edit in the file and explain the trade-off you made and how much it should help.",
};

/**
 * Pure: the instruction for the action `id` — `overrides[id]` when it is a
 * non-empty string (the user's `kirocrew.editorActions.prompts`), else the
 * default. Unknown ids answer "" so a stale menu entry sends nothing.
 */
function actionPrompt(id, overrides) {
  const key = String(id || "");
  const own = overrides && typeof overrides === "object" ? overrides[key] : undefined;
  if (typeof own === "string" && own.trim()) return own;
  return Object.prototype.hasOwnProperty.call(DEFAULT_ACTION_PROMPTS, key) ? DEFAULT_ACTION_PROMPTS[key] : "";
}

/** Pure: a code fence long enough that a backtick run inside `text` does not close it. */
function fenceFor(text) {
  const longest = (String(text || "").match(/`{3,}/g) || []).reduce((n, run) => Math.max(n, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Pure: the `#selection` context entry for `{path, languageId, startLine,
 * endLine, text}` (lines one-based, inclusive; `path` as shown to the user,
 * `uriPath` the absolute path steering's fileMatch sees, defaulting to `path`).
 * `content` names the path and range on its first line and carries the text in
 * a fence tagged with the language id (a fence long enough that a ``` inside
 * the selection does not close it); `label` is `file:start-end` (`file:start`
 * for one line). Text past PROVIDER_CAP is cut the way providerEntry cuts.
 */
function buildSelectionContext(input) {
  const o = input || {};
  const path = String(o.path || "");
  const file = path.split(/[\\/]/).pop() || path || "selection";
  const start = Math.max(1, Number(o.startLine) || 1);
  const end = Math.max(start, Number(o.endLine) || start);
  const range = start === end ? String(start) : start + "-" + end;
  const language = String(o.languageId || "").trim();
  const body = String(o.text === undefined || o.text === null ? "" : o.text).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const capped = capText(body, PROVIDER_CAP);
  const fence = fenceFor(capped.text);
  const header = "Selection from " + (path || "the editor") + ", line" + (start === end ? " " : "s ") + range + (language ? " (" + language + ")" : "") + ":";
  const entry = {
    kind: "selection",
    label: file + ":" + range,
    content: header + "\n" + fence + language + "\n" + capped.text + "\n" + fence,
    truncated: capped.truncated,
    glyph: SELECTION_GLYPH,
    selection: { path, languageId: language, range: { startLine: start, endLine: end } },
  };
  if (capped.truncated) entry.note = "Truncated: " + capped.shown + " of " + capped.total + " bytes shown.";
  const uriPath = String(o.uriPath || path);
  if (uriPath) entry.paths = [uriPath];
  return entry;
}

/**
 * Pure: the editor selection as a fenced block for the composer (requirement
 * 10.7) — "Add code block to chat" inserts text the user goes on editing, so
 * unlike buildSelectionContext there is no header sentence and no cap. The
 * fence carries the language id and is long enough that a ``` inside the text
 * does not close it. When `path` is given, a plain `path:start-end` line
 * (`path:start` for one line, bare `path` without a range) sits above the fence
 * so the agent knows where the code came from. Trailing newlines are dropped so
 * the closing fence follows the last line of code.
 */
function fencedBlock(input) {
  const o = input || {};
  const language = String(o.languageId || "").trim();
  const body = String(o.text === undefined || o.text === null ? "" : o.text).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const fence = fenceFor(body);
  const block = fence + language + "\n" + body + "\n" + fence;
  const path = String(o.path || "");
  if (!path) return block;
  const start = Number(o.startLine) || 0;
  if (start < 1) return path + "\n" + block;
  const end = Math.max(start, Number(o.endLine) || start);
  return path + ":" + (start === end ? String(start) : start + "-" + end) + "\n" + block;
}

/**
 * The active editor's selection as plain data `{path, uriPath, languageId,
 * startLine, endLine, text}` (lines one-based, inclusive), or null when nothing
 * is selected. A selection ending at column 0 of a later line does not include
 * that line. `path` is workspace-relative when the file is inside one.
 */
function selectionInput(editor) {
  if (!editor || !editor.selection || editor.selection.isEmpty) return null;
  const doc = editor.document;
  const sel = editor.selection;
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  return {
    path: vscode.workspace.asRelativePath(doc.uri, false),
    uriPath: doc.uri.path,
    languageId: doc.languageId,
    startLine: sel.start.line + 1,
    endLine: endLine + 1,
    text: doc.getText(sel),
  };
}

/** The active editor's selection as a `#selection` context entry (buildSelectionContext), or null when nothing is selected. */
function selectionContext(editor) {
  const input = selectionInput(editor);
  return input ? buildSelectionContext(input) : null;
}

/**
 * One editor action: read the active selection (an information message and
 * nothing else when there is none), build the `#selection` entry and either
 * stage it in the composer ("ask": the user types the question) or send the
 * action's instruction with it, the menu title as the bubble's text.
 */
async function runEditorAction(chat, id) {
  const editor = vscode.window.activeTextEditor;
  const entry = selectionContext(editor);
  if (!entry) { vscode.window.showInformationMessage("Select some text in the editor first."); return null; }
  if (id === "ask") return chat.stageContexts([entry]);
  const text = actionPrompt(id, cfg("editorActions.prompts", {}));
  if (!text) throw new Error("unknown editor action " + id);
  return chat.sendWithContexts(text, [entry], { displayText: EDITOR_ACTION_TITLES[id] || text });
}

/**
 * "Add code block to chat" (requirement 10.7): the active selection as a fenced
 * block (fencedBlock) inserted into the composer's text — not a chip — so the
 * user writes around it. An information message and nothing else when there is
 * no selection. Returns the inserted text (null when nothing was inserted).
 */
async function addCodeBlockToChat(chat) {
  const input = selectionInput(vscode.window.activeTextEditor);
  if (!input) { vscode.window.showInformationMessage("Select some text in the editor first."); return null; }
  const block = fencedBlock(input);
  await chat.insertComposerText(block);
  return block;
}

// ---- Generate commit message (requirement 10.6): the sparkle in the SCM title
// reads the diff through the git API, runs one background turn on a fresh
// session with the mod's default agent (no chat tab draws it) and writes the
// first assistant text into the commit input box.

const COMMIT_MESSAGE_COMMAND = "kirocrew.scm.generateCommitMessage";
const COMMIT_MESSAGE_SESSION_TITLE = "Generate commit message";
const COMMIT_MESSAGE_TIMEOUT_MS = 60000;
/** Shown when the git API is not reachable: the input box the message would land in belongs to that extension. */
const COMMIT_MESSAGE_GIT_ABSENT = "Generate commit message is unavailable: the built-in git extension is not reachable from this extension host, and the commit input box belongs to it.";
const COMMIT_MESSAGE_NOTHING = "Nothing to commit: the index is empty and the working tree is clean.";
/** Our own instruction (not Kiro's text). The diff follows, in the `$ git diff` frame formatGitDiff prints. */
const COMMIT_MESSAGE_PROMPT = [
  "Write a commit message for the diff below.",
  "",
  "Rules:",
  "- Conventional Commits: `<type>(<scope>): <subject>`, the type one of feat, fix, docs, style, refactor, perf, test, chore, ci; the scope optional.",
  "- Subject in the imperative mood (\"Add\", not \"Added\"), capitalized, no trailing period, at most 50 characters.",
  "- Then a blank line and a body wrapped at 72 columns that explains what changed and why, not how. Skip the body when the subject says it all.",
  "- Return ONLY the message: no code fence, no quotes, no label such as \"Commit message:\", no commentary before or after.",
].join("\n");

/**
 * Pure: which diff the message describes → `{diff, staged}`. The index when
 * anything is staged (what the commit would contain), else the working tree;
 * `null` when both are empty (nothing to commit). Whitespace-only diffs count
 * as empty; the kept text loses its trailing whitespace only.
 */
function pickDiff({ staged, working } = {}) {
  const s = String(staged === undefined || staged === null ? "" : staged);
  const w = String(working === undefined || working === null ? "" : working);
  if (s.trim()) return { diff: s.replace(/\s+$/, ""), staged: true };
  if (w.trim()) return { diff: w.replace(/\s+$/, ""), staged: false };
  return null;
}

/** Pure: the turn's text — the instruction, then the diff capped at PROVIDER_CAP (capText's marker says when it was cut). */
function commitMessagePrompt(pick) {
  const capped = capText(pick.diff, PROVIDER_CAP);
  return COMMIT_MESSAGE_PROMPT + "\n\n" + formatGitDiff(capped.text, { staged: pick.staged });
}

/**
 * Pure: the agent's answer as the message to commit with. Strips, in turn, a
 * leading "Commit message:" label (bold or plain, on its own line or not), one
 * surrounding fence (any info string), the label again should it sit inside the
 * fence, and one pair of surrounding quotes (", ', `) — then trims. CRLF
 * becomes LF. Anything else is kept as written: the agent owns the wording.
 */
function cleanCommitMessage(text) {
  let s = String(text === undefined || text === null ? "" : text).replace(/\r\n?/g, "\n").trim();
  const label = /^(?:\*\*|__)?\s*commit message\s*:?\s*(?:\*\*|__)?\s*:?\s*\n?/i;
  s = s.replace(label, "").trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/;
  const fenced = s.match(fence);
  if (fenced) s = fenced[1].trim();
  s = s.replace(label, "").trim();
  if (s.length >= 2 && /^["'`]/.test(s) && s[0] === s[s.length - 1] && !s.slice(1, -1).includes(s[0])) s = s.slice(1, -1).trim();
  return s;
}

/**
 * The git API repository the command works on: the one the `scm/title` menu
 * named (its SourceControl's `rootUri`), else the one holding the active
 * editor's file, else the first. `null` when the API lists none.
 */
function gitRepository(git, arg) {
  const repos = (git && git.repositories) || [];
  if (!repos.length) return null;
  const wanted = arg && arg.rootUri ? String(arg.rootUri.toString ? arg.rootUri.toString() : arg.rootUri) : "";
  const byArg = wanted && repos.find((r) => r.rootUri && r.rootUri.toString() === wanted);
  if (byArg) return byArg;
  const editor = vscode.window.activeTextEditor;
  const file = editor && editor.document && editor.document.uri && editor.document.uri.scheme === "file" ? editor.document.uri.path : "";
  const byFile = file && repos.find((r) => r.rootUri && (file === r.rootUri.path || file.startsWith(r.rootUri.path + "/")));
  return byFile || repos[0];
}

/**
 * One turn on a fresh session, no chat tab: `prompt` goes to a new slot under
 * `agent` (the mod's default when empty, like a new tab's), the feed is watched
 * for that slot's frames, and the FIRST complete assistant row (`chat_message`,
 * role assistant — the host sends it once the streamed text is final) is the
 * answer. An error row (host failure, agent refusal) rejects; `chat_done`
 * before any text rejects ("no answer"); `timeoutMs` without either rejects.
 * The listener is attached before the send, since `/chat?ws=1` answers at once
 * and the frames follow on the socket.
 *
 * Afterwards the slot is stopped when its turn still runs (the answer was
 * taken from the first row) and, on success, deleted: the session served its
 * one purpose and would otherwise add a row to the project's History for every
 * commit. On failure it is kept, so the transcript can be inspected there.
 * `sessions` and `feed` are the extension's; tests pass stubs.
 */
async function runBackgroundTurn({ sessions, feed, agent, prompt, title, timeoutMs }) {
  const wait = Math.max(1000, Number(timeoutMs) || COMMIT_MESSAGE_TIMEOUT_MS);
  const key = await sessions.create({ agent: agent || undefined, kind: "background", title });
  let sub = null, timer = null, done = false, failed = true;
  const answer = new Promise((resolve, reject) => {
    sub = feed.on((frame) => {
      if (!frame || !frame.data || frame.data.slot !== key) return;
      if (frame.type === "chat_message") {
        const row = normalizeRow(frame.data);
        if (isErrorRow(row)) { reject(new Error(String(row.content || "the turn failed").trim())); return; }
        if (row.role === "assistant" && String(row.content || "").trim()) resolve(row.content);
      } else if (frame.type === "chat_done") {
        done = true;
        reject(new Error("the turn ended without an answer"));
      }
    });
    timer = setTimeout(() => reject(new Error("no answer within " + Math.round(wait / 1000) + " s")), wait);
  });
  try {
    await sessions.send(key, prompt, agent || undefined);
    const text = await answer;
    failed = false;
    return text;
  } finally {
    clearTimeout(timer);
    if (sub) sub.dispose();
    if (!done) await sessions.stop(key).catch(() => undefined);
    if (!failed) await sessions.remove(key).catch((e) => log("background turn: could not delete " + key + ": " + e.message));
    sessions.refresh().catch(() => undefined);
  }
}

/**
 * The command. Git API absent → an information message (nothing else can reach
 * the input box); no repository → message; nothing staged and a clean tree →
 * message; else the SCM title shows "Generating commit message…" while the
 * background turn runs, and the cleaned answer lands in `repository.inputBox`.
 * A failure or the 60 s timeout is an error message. Returns the message
 * written (null when none was).
 */
async function generateCommitMessage(sessions, feed, arg) {
  const git = gitApi();
  if (!git) { vscode.window.showInformationMessage(COMMIT_MESSAGE_GIT_ABSENT); return null; }
  const repo = gitRepository(git, arg);
  if (!repo) { vscode.window.showInformationMessage("Generate commit message: no git repository is open in this workspace."); return null; }
  const [staged, working] = await Promise.all([repo.diff(true), repo.diff(false)]);
  const pick = pickDiff({ staged, working });
  if (!pick) { vscode.window.showInformationMessage(COMMIT_MESSAGE_NOTHING); return null; }
  let text;
  try {
    text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: "Generating commit message…", cancellable: false },
      () => runBackgroundTurn({ sessions, feed, agent: cfg("agent", ""), prompt: commitMessagePrompt(pick), title: COMMIT_MESSAGE_SESSION_TITLE, timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS }));
  } catch (error) {
    vscode.window.showErrorMessage("Generate commit message: " + (error && error.message ? error.message : String(error)));
    return null;
  }
  const message = cleanCommitMessage(text);
  if (!message) { vscode.window.showErrorMessage("Generate commit message: the agent returned an empty message."); return null; }
  repo.inputBox.value = message;
  return message;
}

/** A vscode Diagnostic as plain data for `formatProblems` (survives postMessage and tests). */
function plainDiagnostic(d) {
  return { range: { start: { line: d.range.start.line, character: d.range.start.character } }, severity: d.severity, message: d.message, source: d.source, code: d.code && typeof d.code === "object" ? d.code.value : d.code };
}

// ---- Quick fix (requirement 10.3): "Ask the agent to fix" in the light-bulb
// menu of any diagnostic, from any language or extension. The action's command
// carries the diagnostic as plain data; the handler re-reads the document and
// hands the agent a `#diagnostic` context entry (the problem line as the
// Problems provider formats it, then the affected lines in a fence) with our
// own fix instruction. The spec task warnings keep their own "Fix task line"
// (requirement 5.2) and are skipped here.

const DIAGNOSTIC_FIX_COMMAND = "kirocrew.editor.fixDiagnostic";
const DIAGNOSTIC_FIX_TITLE = "Ask the agent to fix";
const DIAGNOSTIC_TITLE_MAX = 60; // of the message, in the light-bulb entry and the bubble
const DIAGNOSTIC_GLYPH = "⚠"; // the chip's glyph for a `#diagnostic` entry
const DIAGNOSTIC_FIX_PROMPT = "Fix the reported problem in the attached code: correct it in place with the smallest change that resolves the diagnostic, keep the surrounding style and leave unrelated code alone. Then say what was wrong and how you verified the fix.";

/** Pure: a diagnostic message as one line cut to `max` characters (an ellipsis marks the cut). */
function diagnosticTitle(message, max) {
  const cap = Number(max) || DIAGNOSTIC_TITLE_MAX;
  const one = String(message || "").replace(/\s+/g, " ").trim() || "(no message)";
  return one.length > cap ? one.slice(0, Math.max(1, cap - 1)).replace(/\s+$/, "") + "…" : one;
}

/** A range (the host's or plain) as `{ start: {line, character}, end: {line, character} }`; a missing end is the start. */
function plainRange(r) {
  const start = (r && r.start) || { line: 0, character: 0 };
  const end = (r && r.end) || start;
  return { start: { line: start.line | 0, character: start.character | 0 }, end: { line: end.line | 0, character: end.character | 0 } };
}

/**
 * Pure: the `#diagnostic` context entry for `{path, uriPath, languageId,
 * diagnostic, text}` — `diagnostic` is `{message, severity, source, code, range}`
 * (vscode-shaped, zero-based), `text` the document's text (omit it and the
 * entry carries the problem line alone). `content` is the problem as
 * formatProblems writes it (`path:line:col severity [source code]: message`)
 * followed by the diagnostic's range expanded to whole lines in a fence tagged
 * with the language id; `label` is `file:line source` (`file:line severity`
 * without a source). The range's end at column 0 of a later line does not
 * include that line.
 */
function buildDiagnosticFixContext(input) {
  const o = input || {};
  const d = o.diagnostic || {};
  const path = String(o.path || "");
  const file = path.split(/[\\/]/).pop() || path || "file";
  const language = String(o.languageId || "").trim();
  const range = plainRange(d.range);
  const startLine = range.start.line;
  const endLine = range.end.character === 0 && range.end.line > startLine ? range.end.line - 1 : Math.max(startLine, range.end.line);
  const sev = typeof d.severity === "number" ? SEVERITY_NAMES[d.severity] || "info" : String(d.severity || "info");
  const code = d.code && typeof d.code === "object" ? d.code.value : d.code;
  const problem = formatProblems([[path || file, [{ range, severity: d.severity, message: d.message, source: d.source, code }]]]);
  const entry = {
    kind: "diagnostic",
    label: file + ":" + (startLine + 1) + " " + (d.source ? String(d.source) : sev),
    content: problem,
    glyph: DIAGNOSTIC_GLYPH,
    diagnostic: { message: String(d.message || ""), severity: d.severity, source: d.source, code, range },
    selection: { path, languageId: language, range: { startLine: startLine + 1, endLine: endLine + 1 } },
  };
  if (o.text !== undefined && o.text !== null) {
    const lines = String(o.text).replace(/\r\n?/g, "\n").split("\n");
    const body = lines.slice(startLine, endLine + 1).join("\n").replace(/\n+$/, "");
    const capped = capText(body, PROVIDER_CAP);
    const fence = fenceFor(capped.text);
    const span = startLine === endLine ? "line " + (startLine + 1) : "lines " + (startLine + 1) + "-" + (endLine + 1);
    entry.content = problem + "\nAffected " + span + (language ? " (" + language + ")" : "") + ":\n" + fence + language + "\n" + capped.text + "\n" + fence;
    entry.truncated = capped.truncated;
    if (capped.truncated) entry.note = "Truncated: " + capped.shown + " of " + capped.total + " bytes shown.";
  }
  const uriPath = String(o.uriPath || path);
  if (uriPath) entry.paths = [uriPath];
  return entry;
}

/**
 * One "Ask the agent to fix: <message>" quick fix for the diagnostic `d` of
 * `document`: kind QuickFix, the diagnostic attached, the command
 * DIAGNOSTIC_FIX_COMMAND with `{ uri, range, diagnostic }` as plain data. A
 * plain object with the same fields when the host (the tests' stub) has no
 * `CodeAction`.
 */
function diagnosticFixAction(document, d) {
  const kind = vscode.CodeActionKind && vscode.CodeActionKind.QuickFix ? vscode.CodeActionKind.QuickFix : "quickfix";
  const title = DIAGNOSTIC_FIX_TITLE + ": " + diagnosticTitle(d.message);
  const action = typeof vscode.CodeAction === "function" ? new vscode.CodeAction(title, kind) : { title, kind };
  const range = plainRange(d.range);
  action.diagnostics = [d];
  action.command = {
    command: DIAGNOSTIC_FIX_COMMAND,
    title,
    arguments: [{ uri: document ? document.uri : undefined, range, diagnostic: { ...plainDiagnostic(d), range } }],
  };
  return action;
}

/**
 * The code action provider on every document (`"*"`): for each diagnostic of
 * the request that touches the range — any source but the spec task warnings,
 * which have their own fix — one "Ask the agent to fix" action; two diagnostics
 * with the same message at the same range (two linters agreeing) give one.
 */
class AgentFixCodeActionProvider {
  provideCodeActions(document, range, context) {
    const diagnostics = ((context && context.diagnostics) || []).filter((d) => d && d.range && d.source !== SPEC_TASK_DIAGNOSTICS && (!range || rangesIntersect(d.range, range)));
    const seen = new Set();
    const actions = [];
    for (const d of diagnostics) {
      const r = plainRange(d.range);
      const key = [r.start.line, r.start.character, r.end.line, r.end.character, String(d.message || "").replace(/\s+/g, " ").trim()].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push(diagnosticFixAction(document, d));
    }
    return actions;
  }
}

/**
 * The quick fix's command: `arg` is `{ uri, range, diagnostic }` from the
 * action (a string `uri` is parsed); without one, the active editor's file. The
 * document is opened (not shown) for its text and language, the `#diagnostic`
 * entry built and sent with DIAGNOSTIC_FIX_PROMPT, "Fix: <message>" as the
 * bubble's text. Returns the tab's session key, or null when nothing was sent.
 */
async function runDiagnosticFix(chat, arg) {
  const a = arg || {};
  let uri = a.uri;
  if (typeof uri === "string") uri = vscode.Uri.parse(uri);
  if (!uri) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage("Open the file with the problem first."); return null; }
    uri = editor.document.uri;
  }
  const d = a.diagnostic || {};
  const doc = await vscode.workspace.openTextDocument(uri);
  const entry = buildDiagnosticFixContext({
    path: vscode.workspace.asRelativePath(uri, false),
    uriPath: uri.path,
    languageId: doc.languageId,
    diagnostic: { ...d, range: d.range || a.range },
    text: doc.getText(),
  });
  return chat.sendWithContexts(DIAGNOSTIC_FIX_PROMPT, [entry], { displayText: "Fix: " + diagnosticTitle(d.message) });
}

/** Problems: the diagnostics of the active file or of every file (asked when an editor is active). */
async function resolveProblems({ rel }) {
  const editor = vscode.window.activeTextEditor;
  let scope = "all";
  if (editor) {
    const picked = await vscode.window.showQuickPick([
      { label: "$(file) Active file", description: rel(editor.document.uri.path), scope: "active" },
      { label: "$(files) All files", description: "every diagnostic of the workspace", scope: "all" },
    ], { placeHolder: "Problems of which files?" });
    if (!picked) return null;
    scope = picked.scope;
  }
  const all = scope === "active" ? [[editor.document.uri, vscode.languages.getDiagnostics(editor.document.uri)]] : vscode.languages.getDiagnostics();
  const byFile = [], paths = [];
  let count = 0;
  for (const [uri, list] of all) {
    if (!list || !list.length) continue;
    byFile.push([rel(uri.path), list.map(plainDiagnostic)]);
    paths.push(uri.path);
    count += list.length;
  }
  if (!count) { vscode.window.setStatusBarMessage("KiroCrew: no problems" + (scope === "active" ? " in the active file" : ""), 3000); return null; }
  return { label: "Problems (" + count + (scope === "active" ? ", active file" : "") + ")", text: formatProblems(byFile), note: count + " diagnostic" + (count === 1 ? "" : "s") + (scope === "active" ? " of " + rel(editor.document.uri.path) : " across " + byFile.length + " file" + (byFile.length === 1 ? "" : "s")), paths };
}

// Terminal output seen through the shell-integration API (stable since VS Code
// 1.93, present in the bundled openvscode-server 1.109): `read()` must be called
// inside the start event or the stream misses the first chunks. Per terminal, the
// last TERMINAL_HISTORY_MAX commands with their raw output. `terminal.selection`
// is a proposed API this extension cannot enable, so the selection goes through
// `workbench.action.terminal.copySelection` and the clipboard instead.
const terminalHistory = new Map(); // vscode.Terminal → [{command, output}]
function trackTerminalOutput(context) {
  if (typeof vscode.window.onDidStartTerminalShellExecution !== "function") return false;
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((e) => {
      const entry = { command: (e.execution.commandLine && e.execution.commandLine.value) || "", output: "" };
      const list = terminalHistory.get(e.terminal) || [];
      list.push(entry);
      while (list.length > TERMINAL_HISTORY_MAX) list.shift();
      terminalHistory.set(e.terminal, list);
      const stream = e.execution.read();
      (async () => {
        try { for await (const chunk of stream) { entry.output += chunk; if (entry.output.length > 4 * CONTEXT_CAP) entry.output = entry.output.slice(-4 * CONTEXT_CAP); } } catch { /* the execution ended */ }
      })();
    }),
    vscode.window.onDidCloseTerminal((t) => terminalHistory.delete(t)),
    { dispose: () => terminalHistory.clear() },
  );
  return true;
}

/**
 * Run a workbench copy command and return what it put on the clipboard: "" when
 * it copied nothing (no selection, no shell integration), null when the clipboard
 * cannot be read here (the browser denied it). The previous clipboard is restored.
 */
async function clipboardVia(command) {
  const clipboard = vscode.env.clipboard;
  let before;
  try { before = await clipboard.readText(); } catch { return null; }
  const sentinel = "\u2063kirocrew-clipboard-" + Date.now();
  let after;
  try {
    await clipboard.writeText(sentinel);
    await vscode.commands.executeCommand(command);
    after = await clipboard.readText();
  } catch { after = sentinel; }
  try { await clipboard.writeText(before); } catch { /* nothing to restore */ }
  return after === sentinel ? "" : after;
}

/**
 * Terminal: the terminal's selection; else its last TERMINAL_TAIL_LINES lines; else
 * ask the user to select. `args.terminal` names the terminal (the `terminal/context`
 * menu hands "Send terminal to chat" its target); default the active one. The copy
 * commands act on the active terminal, so another one is shown first.
 */
async function resolveTerminal(args) {
  const term = (args && args.terminal) || vscode.window.activeTerminal;
  if (!term) { vscode.window.setStatusBarMessage("KiroCrew: no active terminal", 3000); return null; }
  const name = term.name || "terminal";
  if (term !== vscode.window.activeTerminal && typeof term.show === "function") term.show(true);
  const selection = await clipboardVia("workbench.action.terminal.copySelection");
  if (selection && selection.trim()) return { label: "Terminal selection", text: stripAnsi(selection).replace(/\s+$/, ""), note: "selection of " + name, source: "selection" };
  const history = terminalHistory.get(term);
  if (history && history.length) {
    const text = tailLines(history.map((h) => "$ " + h.command + "\n" + stripAnsi(h.output)).join("\n"), TERMINAL_TAIL_LINES);
    return { label: "Terminal (last " + TERMINAL_TAIL_LINES + " lines)", text, note: "last " + TERMINAL_TAIL_LINES + " lines of " + name + " from shell integration; select text in the terminal to send exactly that", source: "shell-integration" };
  }
  const last = await clipboardVia("workbench.action.terminal.copyLastCommandOutput");
  if (last && last.trim()) return { label: "Terminal (last command)", text: tailLines(stripAnsi(last), TERMINAL_TAIL_LINES), note: "output of the last command in " + name, source: "last-command" };
  const why = selection === null ? "this browser does not let the extension read the clipboard, and shell integration has recorded no output yet" : "nothing is selected and shell integration has recorded no output yet";
  vscode.window.showInformationMessage("KiroCrew: select text in " + name + " and try again (" + why + ").");
  return null;
}

/** The built-in git extension's API when it runs in this extension host (it does not in the web host of openvscode-server). */
function gitApi() {
  try {
    const ext = vscode.extensions.getExtension("vscode.git");
    return ext && ext.isActive && ext.exports && typeof ext.exports.getAPI === "function" ? ext.exports.getAPI(1) : null;
  } catch { return null; }
}

/** Git diff: working tree and index through the git API; else the gateway's gitdiff route; else an explicit message. */
async function resolveGitDiff({ root }) {
  const git = gitApi();
  if (git && git.repositories && git.repositories.length) {
    const repo = git.repositories.find((r) => root && (root === r.rootUri.path || root.startsWith(r.rootUri.path + "/"))) || git.repositories[0];
    const branch = repo.state && repo.state.HEAD && repo.state.HEAD.name;
    const [unstaged, staged] = await Promise.all([repo.diff(false), repo.diff(true)]);
    return { label: "Git diff", text: formatGitDiff(unstaged, { staged: false, branch }) + "\n\n" + formatGitDiff(staged, { staged: true }), note: "git API, " + rel0(repo.rootUri.path) };
  }
  if (root) {
    try {
      const doc = await api("/apps/floofycrew/mods/" + IDE_TAG + "/api/gitdiff?path=" + encodeURIComponent(root));
      return { label: "Git diff", text: doc.text || formatGitDiff("", { staged: false }), note: doc.truncated ? "the gateway trimmed the diff to fit a context entry" : undefined };
    } catch (error) {
      return { label: "Git diff", text: GIT_ABSENT_MESSAGE + " (" + error.message + ")", note: "git unavailable" };
    }
  }
  return { label: "Git diff", text: GIT_ABSENT_MESSAGE, note: "git unavailable" };
}
function rel0(p) { return String(p || "").split("/").pop() || p; }

/**
 * Folder: a quick pick over the workspace's directories, then the listing plus
 * file contents up to the cap. With `dir` (a `rel`-relative path, "" for the
 * root) there is no pick — the explorer's "Add to chat context" names the folder,
 * and `uri` then scopes the file search to it.
 */
async function resolveFolder({ rel, dir, uri }) {
  const scope = uri && typeof vscode.RelativePattern === "function" ? new vscode.RelativePattern(uri, "**/*") : "**/*";
  const files = await vscode.workspace.findFiles(scope, CONTEXT_FIND_EXCLUDE, 6000);
  let picked;
  if (typeof dir === "string") picked = { dir: dir.replace(/\/+$/, "") };
  else {
    const dirs = new Set([""]);
    for (const u of files) { const parts = rel(u.path).split("/"); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/")); }
    picked = await vscode.window.showQuickPick([...dirs].sort().map((d) => ({ label: d ? "$(folder) " + d : "$(root-folder) (workspace root)", dir: d })), { placeHolder: "Folder to add as context (its file list and contents, up to the size cap)", matchOnDescription: true });
    if (!picked) return null;
  }
  const inside = files.filter((u) => !picked.dir || rel(u.path).startsWith(picked.dir + "/")).sort((a, b) => rel(a.path).localeCompare(rel(b.path)));
  const entries = inside.map((u) => rel(u.path));
  const contents = [];
  let used = byteLength(formatFolder(entries, [], { dir: picked.dir }));
  let omitted = 0;
  for (const u of inside) {
    if (used >= PROVIDER_CAP || contents.length >= FOLDER_FILES_MAX) { omitted++; continue; }
    let bytes;
    try { bytes = await vscode.workspace.fs.readFile(u); } catch { omitted++; continue; }
    if (bytes.length > PROVIDER_CAP) { omitted++; continue; }
    const text = new TextDecoder().decode(bytes);
    if (looksBinary(text)) { omitted++; continue; }
    contents.push({ path: rel(u.path), text });
    used += bytes.length + rel(u.path).length + 12;
  }
  const label = (picked.dir || "workspace") + "/ (" + entries.length + " file" + (entries.length === 1 ? "" : "s") + ")";
  return { label, text: formatFolder(entries, contents, { dir: picked.dir, omitted }), note: contents.length + " of " + entries.length + " files read", paths: inside.map((u) => u.path) };
}

/** Spec: the documents of one spec (a pick when several exist) from the SpecModel store. */
async function resolveSpec() {
  const specs = await listSpecs();
  if (!specs.length) { vscode.window.setStatusBarMessage("KiroCrew: no specs in this workspace", 3000); return null; }
  const picked = specs.length === 1 ? { spec: specs[0] } : await vscode.window.showQuickPick(specs.map((s) => ({ label: "$(book) " + s.name, description: rel0(s.dir.path.replace(/\/\.kiro\/specs\/[^/]+$/, "")), spec: s })), { placeHolder: "Spec to add as context (its documents, one section per file)" });
  if (!picked) return null;
  const spec = picked.spec;
  const model = specModels ? await specModels.get(spec.dir, spec.name) : await loadSpecModel(spec.dir, spec.name);
  const docs = model.order.map((file) => ({ file, exists: model.documents[file] ? model.documents[file].exists : false, text: model.documents[file] ? model.documents[file].text : "" }));
  const written = docs.filter((d) => d.exists);
  return { label: "spec: " + spec.name, text: formatSpec(spec.name, docs), note: written.length + " of " + docs.length + " documents written", paths: written.map((d) => vscode.Uri.joinPath(spec.dir, d.file).path) };
}

const CONTEXT_PROVIDERS = [
  { id: "problems", label: "Problems", icon: "$(warning)", glyph: "⚠", description: "Problems in the active file / all", resolve: resolveProblems },
  { id: "terminal", label: "Terminal", icon: "$(terminal)", glyph: "❯", description: "Selection of the active terminal, else its last " + TERMINAL_TAIL_LINES + " lines", resolve: resolveTerminal },
  { id: "git-diff", label: "Git Diff", icon: "$(git-compare)", glyph: "±", description: "Working-tree and staged diff of the workspace", resolve: resolveGitDiff },
  { id: "folder", label: "Folder", icon: "$(folder)", glyph: "▸", description: "A folder's listing and file contents, up to " + Math.round(PROVIDER_CAP / 1024) + " KB", resolve: resolveFolder },
  { id: "spec", label: "Spec", icon: "$(book)", glyph: "§", description: "A spec's documents, one section per file", resolve: resolveSpec },
];
/** What the `#` picker lists, in order: the file kinds, then the providers (requirement 9.1). */
const CONTEXT_KINDS = CONTEXT_FILE_KINDS.concat(CONTEXT_PROVIDERS.map((p) => ({ kind: p.id, label: p.label, icon: p.icon, glyph: p.glyph, section: "Providers", description: p.description })));
const providerById = (id) => CONTEXT_PROVIDERS.find((p) => p.id === id);

// ---- Terminal and explorer commands (requirement 10.4, 10.5). Both STAGE their
// entries in the composer (chat.stageContexts) rather than send: the requirement
// says "attaching", and the user types what to ask about the output or the files.

/**
 * "Send terminal to chat": the terminal provider's answer — the selection, else
 * the last TERMINAL_TAIL_LINES lines — as a `❯ Terminal` chip in the composer.
 * `arg` is the `vscode.Terminal` the `terminal/context` menu passes (recognised
 * by its `sendText`); the keybinding and the palette pass nothing, so the active
 * terminal is used. Null when there was nothing to attach (the resolver said why).
 */
async function sendTerminalToChat(chat, arg) {
  const terminal = arg && typeof arg === "object" && typeof arg.sendText === "function" ? arg : undefined;
  const provider = providerById("terminal");
  const result = await provider.resolve({ terminal });
  if (!result) return null;
  return chat.stageContexts([providerEntry(provider, result)]);
}

const EXPLORER_MAX_ITEMS = 20; // selected files and folders "Add to chat context" attaches at most

/**
 * Pure: the explorer's selection as a de-duplicated URI list — `uris` (the
 * multi-selection VS Code passes as the second argument) when it is a non-empty
 * array, else `[uri]`; nothing nullish, each URI once.
 */
function explorerSelection(uri, uris) {
  const list = Array.isArray(uris) && uris.length ? uris : [uri];
  const seen = new Set();
  const out = [];
  for (const u of list) {
    if (!u) continue;
    const key = typeof u === "object" && typeof u.toString === "function" && u.toString !== Object.prototype.toString ? u.toString() : String((u && u.path) || u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/**
 * "Add to chat context" on the explorer's selection: each file becomes the
 * `#file` entry the picker builds (binaries and unreadable files are skipped,
 * long files clipped like any `#file`), each folder the folder provider's entry
 * for that folder without a pick (its own binary/size skipping applies). The
 * first EXPLORER_MAX_ITEMS items are staged together; an information message
 * names what was left out. Labels are relative to the item's workspace folder.
 */
async function addExplorerToChat(chat, uri, uris) {
  const all = explorerSelection(uri, uris);
  if (!all.length) { vscode.window.showInformationMessage("KiroCrew: select files or folders in the explorer first."); return null; }
  const picked = all.slice(0, EXPLORER_MAX_ITEMS);
  const folders = vscode.workspace.workspaceFolders || [];
  const entries = [];
  const skipped = [];
  for (const u of picked) {
    const folder = typeof vscode.workspace.getWorkspaceFolder === "function" ? vscode.workspace.getWorkspaceFolder(u) : undefined;
    const root = folder ? folder.uri.path : folders.length ? folders[0].uri.path : "";
    const rel = (p) => (root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p);
    const label = root === u.path ? "" : rel(u.path);
    let stat;
    try { stat = await vscode.workspace.fs.stat(u); } catch { skipped.push((label || u.path) + " (unreadable)"); continue; }
    if (stat.type & vscode.FileType.Directory) {
      const provider = providerById("folder");
      const result = await provider.resolve({ root, rel, dir: label, uri: u });
      if (result) entries.push(providerEntry(provider, result));
      continue;
    }
    let text;
    try { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(u)); } catch { skipped.push(label + " (unreadable)"); continue; }
    if (looksBinary(text)) { skipped.push(label + " (binary)"); continue; }
    entries.push(fileContextEntry(label, text, u.path));
  }
  const notes = [];
  if (all.length > picked.length) notes.push("only the first " + EXPLORER_MAX_ITEMS + " of " + all.length + " selected items were added");
  if (skipped.length) notes.push("skipped " + skipped.join(", "));
  if (!entries.length) { vscode.window.showInformationMessage("KiroCrew: nothing to add" + (notes.length ? " (" + notes.join("; ") + ")" : "") + "."); return null; }
  if (notes.length) vscode.window.showInformationMessage("KiroCrew: " + notes.join("; ") + ".");
  return chat.stageContexts(entries);
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

// ---- Find in the transcript (requirement 8.3): the two pure parts, shared with the
// webview by `toString()` like mdToHtml. Everything that touches the page (the bar, the
// walk over the active pane, the follow guard) lives in chatHtml's script.

/**
 * Every occurrence of `query` in `text` as `{start, end}` ranges, left to right and
 * non-overlapping (the scan resumes after each match: "aa" in "aaaa" is two). The query
 * is plain text, not a pattern; an empty one matches nothing. Case-insensitive unless
 * `matchCase` (a regexp `i` flag, whose folding keeps the offsets aligned where
 * `toLowerCase` would not: "İ" lowercases to two code units).
 */
function findMatches(text, query, matchCase) {
  const out = [];
  const hay = text == null ? "" : String(text), q = query == null ? "" : String(query);
  if (!q) return out;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
  let m;
  while ((m = re.exec(hay))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * Wrap each `{start, end}` range of the text node `node` (ascending, non-overlapping,
 * as findMatches gives them) in a `<mark class="hit">`; returns the marks in order. The
 * node is split around the ranges and nothing else moves, so replacing every mark by its
 * text and normalizing the parent gives back the node as it was. `doc` creates the marks
 * (the node's document, or any DOM implementation with createElement).
 */
function markTextNode(node, ranges, doc) {
  const marks = [];
  let rest = node, off = 0;
  for (const r of ranges || []) {
    if (!r || !(r.end > r.start) || r.start < off || r.end > off + rest.nodeValue.length) continue;
    const hit = rest.splitText(r.start - off);
    rest = hit.splitText(r.end - r.start);
    off = r.end;
    const mark = doc.createElement("mark");
    mark.className = "hit";
    hit.parentNode.insertBefore(mark, hit);
    mark.appendChild(hit);
    marks.push(mark);
  }
  return marks;
}

/**
 * The pending approval cards under `root` (a pane's log), in document order
 * (requirement 8.4). A card is pending while its Approve / Reject buttons are
 * still in it: a click removes the whole card, so a resolved one is simply gone.
 * Shared with the page (stringified into chatHtml); DOM-only, no globals.
 */
function pendingApprovalCards(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return Array.from(root.querySelectorAll(".row.permission")).filter((card) => card.querySelector("button[data-action]"));
}

const TOOL_CARD_DISPLAY_MODES = ["collapseOnComplete", "alwaysExpanded"];
const DEFAULT_TOOL_CARD_DISPLAY_MODE = "collapseOnComplete";

/**
 * Does `kirocrew.toolCardDisplayMode` want this tool row folded? Only
 * `collapseOnComplete` ever folds, only once the call is finished, and never a
 * row the user opened or closed by hand (folding hides what they asked to see;
 * `alwaysExpanded` never folds, and expanding hides nothing). An unknown mode
 * behaves as the default. Shared with the page (stringified into chatHtml).
 */
function toolRowShouldCollapse(mode, finished, userToggled) {
  const m = mode === "alwaysExpanded" ? mode : "collapseOnComplete";
  return m === "collapseOnComplete" && Boolean(finished) && !userToggled;
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
 :root{color-scheme:light dark;--kide-msg-size:inherit;
   /* The reading column, as the dashboard's Chat settings have it: Compact is a
      centred 800px (816px for the composer) scaled by the message font size, so a
      wide pane gets margins instead of 200-character lines; a narrow pane keeps
      its 8px. Comfortable / Full are percentages (84% / 92%). */
   --kide-content-width:800px;--kide-input-width:816px;--kide-scrollbar:0px;
   --kide-gutter:max(8px,calc((100% - var(--kide-content-width))/2));
   --kide-input-gutter:max(5px,calc((100% - var(--kide-input-width))/2))}
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
 /* The four workflow tiles of an empty chat (Kiro's empty-chat choices). The empty
    state itself takes no clicks, so the row re-enables them for itself. */
 .empty .modes{pointer-events:auto;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:0 16px;max-width:360px}
 .empty .modes button{border:1px solid var(--vscode-widget-border,var(--vscode-input-border,transparent));background:var(--vscode-editorWidget-background);color:var(--vscode-foreground);border-radius:4px;font-size:12px;padding:5px 10px;cursor:pointer;opacity:.9}
 .empty .modes button:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,var(--vscode-button-secondaryHoverBackground))}
 .empty .modes button.on{border-color:var(--vscode-focusBorder);opacity:1}
 .row.starting{opacity:.75;font-style:italic}
 /* Message rows follow KiroCrew's own transcript: the user's turn is a bubble
    on the right (its card colour, small radius), the assistant's is bare text
    on the surface, tool/status lines are a quiet mono row with a hairline. */
 .log.on{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:8px var(--kide-gutter) 4px}
 .log>*{flex:none}
 .row{margin:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;line-height:1.55;min-width:0}
 .user{align-self:flex-end;width:fit-content;max-width:92%;background:var(--vscode-input-background);color:var(--vscode-input-foreground,inherit);border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent));padding:6px 10px;border-radius:6px}
 .user .ctx{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px}
 /* "Revert changes": a small action at the bubble's bottom-right, shown on hover or
    focus, when the turn has a workspace checkpoint (data-checkpoint). Like Kiro's
    per-message Revert, it restores the files to how they were before this message. */
 .user{position:relative}
 .user .revert{position:absolute;right:4px;bottom:-9px;opacity:0;transition:opacity .12s;border:1px solid var(--vscode-widget-border,transparent);background:var(--vscode-editorWidget-background);color:var(--vscode-foreground);border-radius:4px;font-size:11px;line-height:1;padding:3px 6px;cursor:pointer;white-space:nowrap}
 .user:hover .revert,.user:focus-within .revert,.user .revert:focus{opacity:.85}.user .revert:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,var(--vscode-button-secondaryHoverBackground))}
 .revert-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;opacity:.9}
 .revert-row button{border:1px solid var(--vscode-widget-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:4px;font-size:11px;padding:2px 8px;cursor:pointer}
 .revert-row button:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-secondaryBackground))}
 /* The pinned prompt (KiroCrew's pinned-prompt): while the transcript is
    scrolled past a user turn, that turn stays at the top right as a one-line
    card in the bubble's own colours (three lines on hover, the whole prompt on
    ⌄); clicking it scrolls back to where the turn starts. The wrapper lets the
    transcript take every click around the card. */
 .pin{position:absolute;top:0;left:var(--kide-gutter);right:calc(var(--kide-gutter) + var(--kide-scrollbar));z-index:3;display:flex;justify-content:flex-end;padding:4px 0 0;pointer-events:none;font-size:var(--kide-msg-size)}
 .pin[hidden]{display:none}
 .pin-card{pointer-events:auto;display:flex;align-items:flex-start;gap:4px;max-width:92%;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground,inherit);border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent));border-radius:6px;padding:4px 6px 4px 10px;box-shadow:0 2px 8px rgba(0,0,0,.22);will-change:transform;transition:transform .08s linear}
 .pin-text{flex:1;min-width:0;margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;line-height:1.55;text-align:left;cursor:pointer;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;white-space:normal;word-break:break-word;overflow-wrap:anywhere}
 .pin-card:hover .pin-text,.pin-card:focus-within .pin-text{-webkit-line-clamp:3}
 .pin.open .pin-text{display:block;-webkit-line-clamp:unset;max-height:40vh;overflow:auto;white-space:pre-wrap}
 .pin-more{display:none;flex:none;margin:0;padding:0 3px;border:0;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:14px;line-height:1.55;transition:transform .2s}
 .pin.more .pin-more{display:inline-block}.pin-more:hover{opacity:1}.pin.open .pin-more{transform:rotate(180deg)}
 .pin-text:focus-visible,.pin-more:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
 @media (prefers-reduced-motion:reduce){.pin-card{transition:none}}
 /* Jump to latest: a pill over the pane's bottom edge while the transcript is scrolled up
    (the dashboard's scroll-to-bottom), in the widget colours, accented once new content
    arrived unseen. */
 .jump{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:3;display:inline-flex;align-items:center;gap:6px;padding:4px 10px 4px 12px;border-radius:6px;border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent));background:var(--vscode-editorWidget-background,var(--vscode-input-background));color:var(--vscode-foreground);font:inherit;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)}
 .jump[hidden]{display:none}
 .jump:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-button-secondaryHoverBackground,var(--vscode-editorWidget-background)))}
 .jump:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
 .jump.new{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
 .jump.new:hover{background:var(--vscode-button-hoverBackground,var(--vscode-button-background))}
 .jump .ja{font-size:13px;line-height:1}
 /* Find in the transcript (Ctrl/Cmd+F): a bar docked between the tab strip and the pane,
    in the widget colours; matches are <mark class="hit"> in the find-match colours, the
    current one .cur. */
 #find{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12px;border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));background:var(--vscode-editorWidget-background,var(--vscode-sideBar-background))}
 #find[hidden]{display:none}
 #find input{flex:1 1 120px;min-width:80px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:3px 6px;font:inherit}
 #find input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
 #find.none input{outline:1px solid var(--vscode-inputValidation-errorBorder,#be1100);outline-offset:-1px}
 #find .count{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;min-width:52px;text-align:right}
 #find button{flex:none;margin:0;border:1px solid transparent;background:transparent;color:inherit;border-radius:4px;padding:2px 6px;cursor:pointer;font:inherit;line-height:1.2}
 #find button:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-button-secondaryBackground))}
 #find button[aria-pressed="true"]{background:var(--vscode-inputOption-activeBackground,var(--vscode-button-secondaryBackground));border-color:var(--vscode-inputOption-activeBorder,transparent);color:var(--vscode-inputOption-activeForeground,inherit)}
 #find button:disabled{opacity:.4;cursor:default}
 #find button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
 mark.hit{background:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33));color:inherit;border-radius:2px;padding:0}
 mark.hit.cur{background:var(--vscode-editor-findMatchBackground,rgba(168,172,148,.6));outline:1px solid var(--vscode-editor-findMatchBorder,transparent)}
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
 /* The command tip: resting the pointer on a collapsed tool row shows what it ran (the
    dashboard's tool-command-tip). A hover widget in the editor's hover colours, fixed over
    the transcript, one grid row per pipeline segment: the gutter holds \`$\` then each
    operator (a pipe in the accent colour), the cell the segment's pieces. */
 .tool .tool-head[data-tip="true"]{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}
 .ktip{position:fixed;z-index:9999;max-width:min(36rem,calc(100vw - 2rem));padding:5px 9px;border-radius:4px;border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border,GrayText));background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,Canvas));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground,CanvasText));box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.36));pointer-events:none;font-size:12px;line-height:1.45}
 .ktip[hidden]{display:none}
 .ktip.sh{font-family:var(--vscode-editor-font-family);font-size:11.5px;line-height:1.55;max-width:min(36rem,calc(100vw - 2rem))}
 .ktip.txt{max-width:min(26rem,calc(100vw - 2rem));white-space:pre-wrap;overflow-wrap:anywhere}
 .ktip-grid{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px}
 .ktip-op{user-select:none;text-align:right;color:var(--vscode-descriptionForeground)}
 .ktip-op.pipe{color:var(--vscode-textLink-foreground,var(--vscode-focusBorder))}
 .ktip-seg{white-space:pre-wrap;overflow-wrap:anywhere}
 .ktip .p-program{color:var(--vscode-editor-foreground,var(--vscode-foreground));font-weight:600}
 .ktip .p-flag{color:var(--vscode-debugTokenExpression-name,var(--vscode-symbolIcon-propertyForeground))}
 .ktip .p-string{color:var(--vscode-debugTokenExpression-string,var(--vscode-symbolIcon-stringForeground))}
 .ktip .p-redirect{color:var(--vscode-descriptionForeground)}
 .ktip-cut{margin-top:3px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-size:11px}
 .ktip-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
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
 .row.err button.resume,.row.pause button.resume{display:block;margin:8px 0 2px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
 .row.err button.resume[disabled],.row.pause button.resume[disabled]{opacity:.6;cursor:default}
 /* An interrupted run (judged from tasks.md, not from an error): the warning tint, not the red. */
 .row.pause{color:var(--vscode-foreground);background:color-mix(in srgb,var(--vscode-editorWarning-foreground,#d9a300) 10%,transparent);border:1px solid color-mix(in srgb,var(--vscode-editorWarning-foreground,#d9a300) 45%,transparent);border-radius:6px;padding:6px 10px;white-space:pre-wrap}
 /* The host's injected rows (a tool call a safety policy stopped, a turn the gateway
    resumed, a Continue you asked for): the dashboard's recovery card — a one-line header
    (chevron, icon, bold title, muted detail, the matched pattern as a mono chip) and the
    whole notice under it on click. Attention kinds get the warning tint on the icon. */
 .recov{padding:0;white-space:normal;font-size:12px;color:var(--vscode-descriptionForeground);background:var(--vscode-editorWidget-background,transparent);border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,rgba(128,128,128,.35)));border-radius:6px}
 .recov .rc-head{display:flex;align-items:center;gap:6px;width:100%;min-width:0;margin:0;padding:5px 10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
 .recov .rc-head:hover{color:var(--vscode-foreground)}
 .rc-chev{flex:none;opacity:.6;font-size:13px;line-height:1;transition:transform .2s}
 .recov[data-open="true"] .rc-chev{transform:rotate(90deg)}
 .rc-ico{flex:none;display:inline-flex;width:13px;height:13px}
 .rc-ico svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
 .recov[data-severity="attention"] .rc-ico{color:var(--vscode-editorWarning-foreground,#d9a300)}
 .rc-title{flex:none;font-weight:600;color:var(--vscode-foreground)}
 .rc-detail{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.75}
 .rc-chip{flex:0 1 auto;min-width:40px;max-width:45%;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family);font-size:11px;line-height:16px;padding:0 5px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,rgba(128,128,128,.35)));border-radius:4px;background:var(--vscode-editor-background);color:var(--vscode-foreground)}
 .rc-body{margin:0;padding:6px 10px 8px;border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border,rgba(128,128,128,.35)));font-family:var(--vscode-editor-font-family);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:var(--vscode-foreground)}
 .rc-body[hidden]{display:none}
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
 #compose{display:flex;flex-direction:column;gap:4px;padding:5px var(--kide-input-gutter) 4px;border-top:1px solid var(--vscode-panel-border)}
 #chips{display:none;flex-wrap:wrap;gap:4px}#chips.has{display:flex}
 .chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);max-width:100%}
 /* Images in the chat. A pasted or attached image is a thumbnail in the composer's chip row
    (× at its corner); in the user's bubble it is a picture under the text; a markdown image
    in an answer is drawn in place. Every one opens full size in the lightbox on click. */
 .chip.img{position:relative;padding:0;background:transparent;border-radius:4px;overflow:visible}
 .chip.img img{display:block;height:48px;max-width:140px;object-fit:cover;border-radius:4px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));cursor:zoom-in}
 .chip.img .rm{position:absolute;top:-6px;right:-6px;width:16px;height:16px;line-height:14px;border-radius:50%;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border:1px solid var(--vscode-widget-border,transparent);padding:0;text-align:center;opacity:1}
 .user .att{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px;margin:4px 0 2px}
 .user .att img,.md img.mdimg{display:block;max-width:min(100%,360px);max-height:220px;object-fit:contain;border-radius:4px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));cursor:zoom-in;background:var(--vscode-editor-background)}
 .md img.mdimg{margin:6px 0;max-width:min(100%,560px);max-height:360px}
 .imgph{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px dashed var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px;font-size:11px;color:var(--vscode-descriptionForeground);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .imgph.err{border-style:solid}.imgph a.path{color:inherit}
 .user .file{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);cursor:pointer;max-width:100%}
 #lightbox{position:fixed;inset:0;z-index:20;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,.78);padding:16px;box-sizing:border-box}
 #lightbox.on{display:flex}
 #lightbox img{max-width:100%;max-height:calc(100vh - 80px);object-fit:contain;box-shadow:0 6px 30px rgba(0,0,0,.5);background:var(--vscode-editor-background)}
 #lightbox .lb-bar{display:flex;align-items:center;gap:10px;color:#eee;font-size:12px;max-width:100%}
 #lightbox .lb-name{opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60vw}
 #lightbox button{border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);color:#fff;border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
 #lightbox button:hover{background:rgba(255,255,255,.18)}
 #compose.drop{outline:2px dashed var(--vscode-focusBorder);outline-offset:-3px}
 .chip b{font-weight:600;opacity:.8}.chip .cut{opacity:.7;cursor:help}.chip .rm{cursor:pointer;opacity:.7;border:0;background:transparent;color:inherit;padding:0;font-size:12px;line-height:1}
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
 #menu .it[data-glyph]::before{content:attr(data-glyph);display:inline-block;width:1.5em;opacity:.75;text-align:center;margin-right:2px}
 #menu .it[data-glyph] small{padding-left:calc(1.5em + 2px)}
 #hint{font-size:11px;opacity:.55;padding:0 6px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .cursor::after{content:"▍";opacity:.6;animation:b 1s steps(2) infinite}@keyframes b{to{opacity:0}}
</style></head><body>
<div id="noscript-hint" style="padding:10px 12px;font-size:12px;opacity:.7">KiroCrew chat is loading&hellip; If this line never disappears, scripts inside webviews are blocked in this browser &mdash; screenshot this and report it.</div>
<div id="tabs"></div>
<div id="find" role="search" hidden data-testid="find-bar"><input id="findtext" type="text" placeholder="Find in transcript" spellcheck="false" aria-label="Find in transcript"><span class="count" id="findcount" aria-live="polite"></span><button type="button" id="findprev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button><button type="button" id="findnext" title="Next match (Enter)" aria-label="Next match">↓</button><button type="button" id="findcase" title="Match case" aria-pressed="false">Aa</button><button type="button" id="findclose" title="Close (Esc)" aria-label="Close find">✕</button></div>
<div id="panes">
 <div id="pin" class="pin" hidden data-testid="pinned-prompt"><div class="pin-card"><button type="button" class="pin-text" title="Jump to this turn"></button><button type="button" class="pin-more" title="Show the whole prompt" aria-expanded="false">⌄</button></div></div>
 <button type="button" id="jump" class="jump" hidden data-testid="jump-to-latest" title="Scroll to the newest message"><span class="jl">Jump to latest</span><span class="ja" aria-hidden="true">↓</span></button>
 <div id="lightbox" role="dialog" aria-modal="true" aria-label="Image preview" data-testid="lightbox"><img alt=""><div class="lb-bar"><span class="lb-name"></span><button type="button" class="lb-open">Open file</button><button type="button" class="lb-close" title="Close (Esc)">Close</button></div></div>
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
/* The workflow tiles of an empty chat (item 3): Kiro's four modes, in the order its own
   picker lists them. The tile resolves to the kiro-cli mode when available (pickMode). */
const EMPTY_MODES = ${JSON.stringify(WORKFLOWS.filter((w) => w.id !== "default").map((w) => ({ id: w.id, label: w.label, description: w.description })))};
const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs'), panes = $('panes'), text = $('text'), menu = $('menu'), chipsEl = $('chips');
const jump = $('jump'), jumpLabel = jump.querySelector('.jl');
// The find bar's state (requirement 8.3); its functions come after the follow logic, which reads \`find.open\`.
const find = { bar: $('find'), input: $('findtext'), count: $('findcount'), open: false, cs: false, hits: [], cur: -1, timer: 0, refresh: 0, mo: null };
const PATH_RE = new RegExp(${JSON.stringify(PATH_RE.source)}, 'g');
const state = new Map(); // tab id -> {log, streaming, buf, seen, cards, key, contexts, files, running, settings}
let active = null;
let choices = { agents: [], models: [], efforts: [] };
function pane(id){
  let st = state.get(id);
  if(!st){
    const log=document.createElement('div'); log.className='log'; log.dataset.id=id; panes.appendChild(log); log.addEventListener('scroll', ()=>{ pinSchedule(); followUpdate(state.get(id)); }, { passive:true });
    const empty=document.createElement('div'); empty.className='empty';
    if(FOX){const im=document.createElement('img'); im.src=FOX; im.alt=''; empty.appendChild(im);}
    const tx=document.createElement('div'); tx.textContent='New chat — pick an agent and a workflow below, then say something.'; empty.appendChild(tx);
    // The four workflows as tiles, the way Kiro's empty chat offers them: a click sets this
    // tab's pick (Kiro's own mode in kiro-cli when the picker offers it, else the mod's
    // prompt-guided workflow) and leaves the cursor in the composer.
    const modes=document.createElement('div'); modes.className='modes';
    for(const w of EMPTY_MODES){
      const b=document.createElement('button'); b.type='button'; b.textContent=w.label; b.title=w.description||''; b.dataset.mode=w.id;
      b.onclick=()=>{ for(const o of modes.querySelectorAll('button')) o.classList.toggle('on', o===b); pickMode(w.id); };
      modes.appendChild(b);
    }
    empty.appendChild(modes); log.appendChild(empty);
    // The working indicator: four foxes (dots without the asset). \`order\` keeps it
    // the last flex item however rows are appended around it.
    const work=document.createElement('div'); work.className='work'+(FOX?'':' nofox'); work.style.order='1'; work.dataset.testid='working'; work.setAttribute('role','status'); work.setAttribute('aria-label','Agent working');
    for(let i=0;i<4;i++){ if(FOX){const im=document.createElement('img'); im.src=FOX; im.alt=''; work.appendChild(im);} else {const sp=document.createElement('span'); sp.className='fallback'; work.appendChild(sp);} }
    log.appendChild(work);
    st={log, empty, work, streaming:null, buf:'', seen:new Set(), cards:new Map(), key:null, contexts:[], files:[], running:false, settings:{}, think:null, follow:true, unseen:false}; state.set(id, st);
  }
  return st;
}
// Foxes hop while the turn runs and no answer text is on its way (reasoning,
// tool calls, the wait before the first token); streaming text replaces them.
function setWork(st){ if(!st||!st.work) return; const on=Boolean(st.running && !st.streaming && !st.empty); st.work.classList.toggle('on', on); if(on) scrollLog(st); }
function show(id){ active=id; tipHide(); for(const [tid,st] of state) st.log.classList.toggle('on', tid===id); renderCompose(); pinSchedule(); jump.hidden=true; const st=state.get(id); if(st) followUpdate(st); if(find.open) findRun(); }
function el(st, cls, content){ if(st.empty){st.empty.remove(); st.empty=null;} const d=document.createElement('div');d.className='row '+cls;if(content!==undefined)d.textContent=content;st.log.appendChild(d);return d;}
// Named scrollLog, NOT scroll: a global \`scroll\` shadows window.scroll(),
// which the webview host calls during setInitialScrollPosition — the resulting
// TypeError aborted the host's onLoad chain and left the whole pane blank.
// Follow mode, as the dashboard's transcript has it: the pane keeps the newest row in
// view only while it is at the bottom (within FOLLOW_PX of the end). Scrolled up to read,
// new content lands without yanking the view, and the ↓ button over the pane (with a
// "new" note once something arrived) jumps back; reaching the bottom again, by hand or by
// the button, re-arms following. \`force\` (your own turn, a reload) always scrolls.
// While the find bar is open the view belongs to the reader: nothing auto-scrolls (a forced
// scroll included), new content only counts as unseen; closing the bar restores the mode.
const FOLLOW_PX = 8;
function atBottom(log){ return log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_PX; }
function scrollLog(st, force){
  if(!st || !st.log) return;
  if(find.open){ if(force) st.follow = true; if(!atBottom(st.log)) st.unseen = true; jumpUpdate(st); return; }
  if(force) st.follow = true;
  if(st.follow !== false){ st.log.scrollTop = st.log.scrollHeight; st.unseen = false; }
  else st.unseen = true;
  jumpUpdate(st);
}
function followUpdate(st){
  if(!st || !st.log) return;
  const was = st.follow !== false;
  st.follow = atBottom(st.log);
  if(st.follow) st.unseen = false;
  if(st.follow !== was || !st.follow) jumpUpdate(st);
}
function jumpUpdate(st){
  if(!st || active==null || state.get(active)!==st) return;
  const show = (st.follow === false || (find.open && st.unseen)) && st.log.classList.contains('on') && !st.empty;
  jump.hidden = !show;
  if(!show) return;
  jump.classList.toggle('new', Boolean(st.unseen));
  jumpLabel.textContent = st.unseen ? 'New messages' : 'Jump to latest';
}
jump.onclick = ()=>{
  const st = active!=null ? state.get(active) : null; if(!st) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  st.follow = true; st.unseen = false; jumpUpdate(st);
  if(typeof st.log.scrollTo==='function') st.log.scrollTo({ top: st.log.scrollHeight, behavior: reduce ? 'auto' : 'smooth' }); else st.log.scrollTop = st.log.scrollHeight;
};
// ---- Find in the transcript (requirement 8.3), the spec editor's bar adapted to the active
// pane. Matches are text-node local (a phrase split by inline markup is not matched across
// the split); each becomes <mark class="hit">, the current one .cur, scrolled to the centre.
// Message text, tool labels and code are searched; hidden bodies (a collapsed tool row's
// Input/Output, folded reasoning, a recovery card's detail), the working indicator, the
// empty placeholder and buttons are not. Purely additive (requirement 8.6): closing or
// re-searching puts every text node back and normalizes, so the rows are as rendered. The
// host swallows Ctrl+F before the page sees it and forwards the key through the keybinding
// ('find.open'); the page's own keydown opens the bar too, idempotently.
const FIND_CAP = 2000, FIND_DEBOUNCE_MS = 80;
${findMatches.toString()}
${markTextNode.toString()}
const findBtn = (id)=>$(id);
function findOpen(){
  const was = find.open;
  find.open = true; find.bar.hidden = false;
  const sel = window.getSelection ? String(window.getSelection()).trim() : '';
  if(sel && sel.length<200 && !sel.includes('\\n') && !find.bar.contains(window.getSelection().anchorNode)) find.input.value = sel;
  find.input.focus(); find.input.select();
  if(!find.mo && typeof MutationObserver!=='undefined'){ find.mo = new MutationObserver(findSchedule); find.mo.observe(panes, { childList:true, characterData:true, subtree:true }); }
  if(!was || sel) findRun(); else findCount();
  pinSchedule();
}
function findClose(){
  if(!find.open && find.bar.hidden) return;
  find.open = false; find.bar.hidden = true;
  if(find.mo){ find.mo.disconnect(); find.mo = null; }
  clearTimeout(find.timer); find.timer = 0; clearTimeout(find.refresh); find.refresh = 0;
  findClear(); find.input.blur(); find.bar.classList.remove('none'); findCount();
  const st = active!=null ? state.get(active) : null;
  if(st) scrollLog(st); // following resumes where the reader left it: at the bottom it snaps back, scrolled up it keeps the pill
  pinSchedule();
}
function findClear(){
  const marks = panes.querySelectorAll('mark.hit'); const parents = new Set();
  marks.forEach((m)=>{ const p=m.parentNode; if(!p) return; p.replaceChild(document.createTextNode(m.textContent), m); parents.add(p); });
  parents.forEach((p)=>p.normalize());
  find.hits=[]; find.cur=-1;
}
function findNodes(){
  const out=[]; const st = active!=null ? state.get(active) : null; if(!st) return out;
  const w=document.createTreeWalker(st.log, NodeFilter.SHOW_TEXT, { acceptNode(n){
    const p=n.parentElement; if(!p) return NodeFilter.FILTER_REJECT;
    // Not searched: the pane's own widgets (pin, jump, lightbox, placeholder, foxes), action buttons (options, approve, resume), decorative glyphs, chips and attachments, anything hidden.
    if(p.closest('script, style, .pin, .jump, #lightbox, .empty, .work, .ktip, .ctx, .att, .imgph, .tool-ico, .tool-chev, .tool-live, .think-dot, .think-chev, .think-live, .rc-ico, .rc-chev, [hidden]')) return NodeFilter.FILTER_REJECT;
    const b=p.closest('button'); if(b && !b.matches('.tool-head, .think-head, .rc-head')) return NodeFilter.FILTER_REJECT;
    return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } });
  let n; while((n=w.nextNode())) out.push(n);
  return out;
}
// Re-search, keeping the current match's index when \`keep\` (a new row arrived, the tab
// changed); otherwise the first match from the top of the view, as an editor does from its cursor.
function findRun(keep){
  const prev = keep && find.cur>=0 ? find.cur : -1;
  findClear();
  const q=find.input.value;
  if(!q){ find.bar.classList.remove('none'); findCount(); return; }
  const hits=[];
  outer: for(const node of findNodes()){
    for(const mark of markTextNode(node, findMatches(node.nodeValue, q, find.cs), document)){ hits.push(mark); if(hits.length>=FIND_CAP) break outer; }
  }
  find.hits=hits;
  find.bar.classList.toggle('none', !hits.length);
  if(hits.length){
    let start = prev>=0 ? Math.min(prev, hits.length-1) : -1;
    if(start<0){ const fold=panes.getBoundingClientRect().top; start=hits.findIndex((h)=>h.getBoundingClientRect().bottom>=fold); if(start<0) start=0; }
    findGo(start, true, keep);
  }
  findCount();
}
function findGo(index, absolute, still){
  const n=find.hits.length; if(!n){ findCount(); return; }
  if(find.cur>=0 && find.hits[find.cur]) find.hits[find.cur].classList.remove('cur');
  find.cur = absolute ? ((index%n)+n)%n : (((find.cur<0?0:find.cur)+index)%n+n)%n;
  const h=find.hits[find.cur]; h.classList.add('cur');
  if(!still) h.scrollIntoView({ block:'center', inline:'nearest' });
  findCount();
}
function findCount(){
  const n=find.hits.length;
  find.count.textContent = !find.input.value ? '' : !n ? 'No results' : (find.cur+1)+' of '+n+(n>=FIND_CAP?'+':'');
  findBtn('findprev').disabled=findBtn('findnext').disabled=!n;
}
// Typing re-searches after a short pause; the transcript changing under an open bar (a row,
// a streamed chunk, a tool label) re-runs the search once the burst settles, index kept.
function findSchedule(){ if(!find.open) return; clearTimeout(find.refresh); find.refresh=setTimeout(()=>{ find.refresh=0; if(find.open && find.input.value) findRun(true); }, FIND_DEBOUNCE_MS); }
find.input.addEventListener('input', ()=>{ clearTimeout(find.timer); find.timer=setTimeout(()=>{ find.timer=0; findRun(); }, FIND_DEBOUNCE_MS); });
find.input.addEventListener('keydown', (e)=>{
  if(e.key==='Enter'){ e.preventDefault(); if(find.timer){ clearTimeout(find.timer); find.timer=0; findRun(); } else findGo(e.shiftKey?-1:1); }
  else if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); findClose(); }
});
findBtn('findnext').onclick=()=>findGo(1); findBtn('findprev').onclick=()=>findGo(-1);
findBtn('findclose').onclick=findClose;
findBtn('findcase').onclick=(e)=>{ find.cs=!find.cs; e.currentTarget.setAttribute('aria-pressed', String(find.cs)); findRun(); find.input.focus(); };
document.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && !e.altKey && !e.shiftKey && (e.key==='f'||e.key==='F')){ e.preventDefault(); findOpen(); return; }
  if(e.key==='F3'){ e.preventDefault(); if(!find.open) findOpen(); else findGo(e.shiftKey?-1:1); return; }
  if(e.key==='Escape' && find.open && !lightbox.classList.contains('on') && !menu.classList.contains('on')) findClose();
});
// ---- approve all / reject all (requirement 8.4)
// Ctrl/Cmd+Enter approves, Ctrl/Cmd+Shift+C rejects, every pending approval card of the
// active tab, in document order, by clicking the card's own button: the same 'approve'
// message per card, the same removal, nothing new for the extension to understand. With
// no card pending the shortcut does nothing. The key reaches the page first and the
// extension's keybinding ('approvals.*') a moment later, so the second run finds no card
// and is the no-op; that is why there is no fallback to send on Ctrl+Enter here — the
// composer's own Enter handler already sent (it only steps aside while cards are pending).
${pendingApprovalCards.toString()}
function approvalsPending(){ const st = active!=null ? state.get(active) : null; return st ? pendingApprovalCards(st.log) : []; }
function approvalsAll(action){
  const cards = approvalsPending(); if(!cards.length) return 0;
  for(const card of cards){ const b=card.querySelector('button[data-action="'+action+'"]'); if(b && card.isConnected) b.click(); }
  return cards.length;
}
const isApproveAllKey = (e)=> (e.ctrlKey||e.metaKey) && !e.altKey && !e.shiftKey && e.key==='Enter';
const isRejectAllKey = (e)=> (e.ctrlKey||e.metaKey) && !e.altKey && e.shiftKey && (e.key==='c'||e.key==='C');
document.addEventListener('keydown', (e)=>{
  if(isApproveAllKey(e)){ if(approvalsPending().length){ e.preventDefault(); approvalsAll('approved'); } return; }
  if(isRejectAllKey(e)){ if(approvalsPending().length){ e.preventDefault(); approvalsAll('rejected'); } }
});
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
  // The card's right edge lines up with the bubbles', which sit left of the pane's scrollbar.
  panes.style.setProperty('--kide-scrollbar', Math.max(0, log.offsetWidth - log.clientWidth)+'px');
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
/* Kiro's task orchestrator announces every status change it writes into tasks.md ([~] queued,
   [-] in progress, [x] done) as a task_status action with no input, no output and no title:
   kiro-cli relays it as a completed tool call named task_status, and the host persists that
   (410 of one spec run's 698 tool rows). The only trace of WHICH task is the action id,
   <tool id>_taskStatus_<the task's line, sanitized to [A-Za-z0-9_-], the whole id capped at
   64 chars>; decode it into the task number and the start of its title, and say in the body
   what the row is instead of "(no output)". */
const TASK_STATUS_NOTE="Kiro's task orchestrator recorded a status change for this task in tasks.md ([~] queued, [-] in progress, [x] done). This bookkeeping event carries no input or output; the tasks.md marks and the Specs view show the current state.";
function taskStatusOf(meta, title){
  const m=/_taskStatus_(.*)$/.exec(String((meta&&meta.tool_call_id)||''));
  if(!m && title!=='task_status') return null;
  const raw=m?m[1]:''; const num=/^(\\d+(?:_\\d+)*)(?=_|$)/.exec(raw);
  const id=num?num[1].replace(/_/g,'.'):''; const text=raw.slice(num?num[0].length:0).replace(/_+/g,' ').trim();
  return { id, text, label:'Task status'+(id?' · '+id:'')+(text?' '+text+'…':'') };
}
function toolRow(st, d, r){
  const meta=r.meta||{}; const content=String(r.content||''); const lines=content.split('\\n'); const first=lines[0];
  const em=/^(\\p{Extended_Pictographic}\\uFE0F?)\\s*/u.exec(first);
  let title=(typeof meta.purpose==='string' && meta.purpose) || (em ? first.slice(em[0].length) : first) || meta.tool_name || 'tool';
  const ts=taskStatusOf(meta, title); if(ts){ title=ts.label; d.classList.add('task'); d.dataset.taskId=ts.id; }
  d.classList.add('call'); d.dataset.tcid=meta.tool_call_id||''; d.dataset.open='false';
  d._tool={ input: meta.input, output: meta.output, done: Boolean(meta.done), extra: lines.length>1 ? lines.slice(1).join('\\n') : '', body:null, note: ts?TASK_STATUS_NOTE:'', kind: meta.kind||'', name: meta.tool_name||(em ? first.slice(em[0].length) : first)||'', raw: ts ? '' : ((em ? first.slice(em[0].length) : first)||'') };
  // the native title stays only on a bookkeeping row (its note); every other row explains
  // itself in the command tip on hover, with the click's effect in the accessible name
  const head=document.createElement('button'); head.type='button'; head.className='tool-head'; head.setAttribute('aria-expanded','false'); head.setAttribute('aria-label', "Show this call's input and output: "+title); if(ts) head.title=TASK_STATUS_NOTE;
  const ic=document.createElement('span'); ic.className='tool-ico'; ic.textContent=ts ? '📋' : (em ? em[1] : '🔧');
  const tt=document.createElement('span'); tt.className='tool-title'; tt.textContent=title;
  const live=document.createElement('span'); live.className='tool-live'; live.title='running';
  const chev=document.createElement('span'); chev.className='tool-chev'; chev.textContent='›';
  head.appendChild(ic); head.appendChild(tt); head.appendChild(live); head.appendChild(chev); d.appendChild(head);
  head.onclick=()=>{ d.dataset.userToggled='true'; toolToggle(d); };
  if(!ts){ head.addEventListener('mouseenter', ()=>tipArm(head)); head.addEventListener('mouseleave', tipHide); head.addEventListener('focus', ()=>{ let fv=true; try{ fv=head.matches(':focus-visible'); }catch{} if(fv) tipShow(head); }); head.addEventListener('blur', tipHide); }
  toolLive(st, d);
  if(toolMode==='alwaysExpanded') toolToggle(d, true);
}
function toolLive(st, d){ const t=d._tool; if(!t) return; d.classList.toggle('live', Boolean(st.running) && !t.done); }
// ---- kirocrew.toolCardDisplayMode: collapseOnComplete (default) folds a row once its call
// returns, alwaysExpanded opens rows on arrival and keeps them open. A row the user toggled
// by hand (data-user-toggled, set on a header click) is never folded by the mode. A change
// at runtime sweeps the finished rows of every tab: alwaysExpanded opens them all (expanding
// hides nothing), collapseOnComplete folds those the user did not toggle; running rows are
// left to their finish.
${toolRowShouldCollapse.toString()}
let toolMode='collapseOnComplete';
function toolUserToggled(d){ return d.dataset.userToggled==='true'; }
function toolFinished(d){
  const t=d._tool; if(!t || !t.done) return; const open=d.dataset.open==='true';
  if(toolRowShouldCollapse(toolMode, t.done, toolUserToggled(d))){ if(open) toolToggle(d, false); }
  else if(toolMode==='alwaysExpanded' && !open && !toolUserToggled(d)) toolToggle(d, true);
}
function toolModeSet(mode){
  toolMode = mode==='alwaysExpanded' ? 'alwaysExpanded' : 'collapseOnComplete';
  for(const st of state.values()) for(const d of st.log.querySelectorAll('.row.tool.call')){
    const t=d._tool; if(!t || !t.done) continue; const open=d.dataset.open==='true';
    if(toolMode==='alwaysExpanded'){ if(!open) toolToggle(d, true); }
    else if(toolRowShouldCollapse(toolMode, t.done, toolUserToggled(d)) && open) toolToggle(d, false);
  }
}
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
  const k=t.outPre.parentElement.querySelector('.tool-k');
  if(out){ linkify(t.outPre, clipText(out, TOOL_PRE_MAX)); k.textContent='Output'; }
  else if(t.note){ t.outPre.textContent=t.note; k.textContent='Note'; }
  else { t.outPre.textContent = t.done ? '(no output)' : 'running…'; k.textContent='Output'; }
  t.outPre.classList.toggle('muted', !out);
}
function toolToggle(d, open){ tipHide(); const body=toolBody(d); const o = open===undefined ? body.hidden : Boolean(open); body.hidden=!o; d.dataset.open=String(o); d.querySelector('.tool-head').setAttribute('aria-expanded', String(o)); pinSchedule(); }
function toolRows(st, tcid){ return tcid ? [...st.log.querySelectorAll('.row.tool.call')].filter(x=>x.dataset.tcid===tcid) : []; }
// tool_result: the call returned; its output lands on the row (an empty output
// still marks it done — the host sends that for tools that print nothing).
function toolResult(st, tcid, output){ for(const d of toolRows(st, tcid)){ const t=d._tool; if(output!==undefined && output!==null && (String(output) || !t.output)) t.output=String(output); t.done=true; toolLive(st, d); toolFill(d); toolFinished(d); } }
// tool_call (is_update): the refined title/arguments of a call already shown.
function toolUpdate(st, m){ for(const d of toolRows(st, m.tcid)){ const t=d._tool; const title=(typeof m.purpose==='string' && m.purpose) || m.title; if(title && !t.note){ const tt=d.querySelector('.tool-title'); if(tt) tt.textContent=String(title).replace(/^\\p{Extended_Pictographic}\\uFE0F?\\s*/u,''); } if(m.input && (t.input===undefined||t.input===null||t.input==='')) t.input=m.input; toolFill(d); } }
// The turn ended: nothing is running any more, whatever rows never got a result.
function toolsSettle(st){ for(const d of st.log.querySelectorAll('.row.tool.call')){ if(d._tool){ const was=d._tool.done; d._tool.done=true; toolLive(st, d); toolFill(d); if(!was) toolFinished(d); } } }
// ---- the command tip: resting the pointer on a collapsed tool row shows what it ran
// (the dashboard's tool-command-tip). A shell call is split into its pipeline segments
// (the top-level &&, ||, |&, | and ; outside quotes, backticks and $(…)), one grid row
// each: \`$\` then the operator in the gutter; a command with newlines is shown verbatim.
// Anything else — a label that is the call's purpose, a title the row cuts — is shown as
// text. 12 segments or lines and 1200 chars at most, then a hint to open the row. Shown
// only while the row is collapsed and the tip would say more than the label does (the
// dashboard's rule: the label is the full command → no tip). 100 ms after the pointer
// rests, at once on focus.
//
// Colours: the editor's own. The page asks the extension to highlight the command
// ('highlight' → 'highlighted'); the engine host tokenizes it with the workbench's
// vscode-textmate, the shellscript grammar and the active theme's rules, and answers
// one list of runs per line ({s, e, c, f}: the range, the theme colour or '' for the
// default foreground, the font-style bits). Until that answer lands — or when no engine
// highlighter is available — the segmenter's own kinds (program, flag, string,
// redirect) colour the pieces from --vscode-* variables. Answers are cached per text;
// a theme change ('highlightReset') drops them.
const TIP_OPS=['&&','||','|&','|',';'], TIP_PIPES=new Set(['|','|&']), TIP_MAX_CHARS=1200, TIP_MAX_LINES=12, TIP_DELAY=100, TIP_CUT_HINT='Open the step to see the rest';
const TIP_ASSIGN=/^[A-Za-z_][A-Za-z0-9_]*=/, TIP_SHELL_NAMES=/^(?:shell|execute_bash|Run Command|Terminal|bash|Bash|execute|terminal)$/;
// A bash-ish tokenizer: words (their quoted parts kept apart, their offset in \`s\`), runs of
// blanks, the pipeline operators and redirections (with an fd prefix and an &N / &- target).
function shTokens(e){
  const t=[]; let n=null, r=0;
  const add=(quoted,text)=>{ n=n||{parts:[],raw:'',s:r}; const last=n.parts[n.parts.length-1]; if(last && last.quoted===quoted) last.text+=text; else n.parts.push({quoted,text}); n.raw+=text; };
  const flush=()=>{ if(n){ t.push({t:'word',w:n,s:n.s,e:n.s+n.raw.length}); n=null; } };
  while(r<e.length){
    const o=e[r];
    if(o===' '||o==='\\t'){ flush(); let k=r; while(k<e.length&&(e[k]===' '||e[k]==='\\t')) k++; t.push({t:'space',text:e.slice(r,k),s:r,e:k}); r=k; continue; }
    if(o==='\\\\'){ add(false,e.slice(r,r+2)); r+=2; continue; }
    if(o==="'"||o==='"'){ let k=r+1; while(k<e.length&&e[k]!==o) k+=(o==='"'&&e[k]==='\\\\')?2:1; add(true,e.slice(r,Math.min(k+1,e.length))); r=k+1; continue; }
    if(o==='\`'||((o==='$'||o==='<'||o==='>')&&e[r+1]==='(')){
      let k;
      if(o==='\`'){ k=e.indexOf('\`',r+1); k=k<0?e.length:k+1; }
      else { let depth=0; for(k=r+1;k<e.length;k++){ const ch=e[k]; if(ch==='\\\\'){ k++; continue; } if(ch==="'"||ch==='"'){ const q=e.indexOf(ch,k+1); k=q<0?e.length:q; continue; } if(ch==='(') depth++; else if(ch===')'&&--depth===0){ k++; break; } } }
      add(false,e.slice(r,k)); r=k; continue;
    }
    const op=TIP_OPS.find(x=>e.startsWith(x,r));
    if(op){ flush(); t.push({t:'op',text:op,s:r,e:r+op.length}); r+=op.length; continue; }
    if(o==='>'||o==='<'||(o==='&'&&e[r+1]==='>')){
      let fd=''; if(n&&/^\\d+$/.test(n.raw)){ fd=n.raw; n=null; } flush();
      const m=/^(&>>?|>\\||>>?|<<<|<)(&(\\d+|-))?/.exec(e.slice(r)); const txt=m?m[0]:o;
      t.push({t:'redir',text:fd+txt,s:r-fd.length,e:r+txt.length}); r+=txt.length; continue;
    }
    add(false,o); r++;
  }
  flush(); return t;
}
// The segments of a one-line command, each {op, opStart, start, end, pieces:[{kind, text,
// start}]} with offsets into the text: the first word that is not a NAME= assignment is
// the program, a -word a flag, a quoted part a string. null for a command with newlines
// (shown verbatim instead).
function shSegments(e){
  if(!e.trim()||/[\\r\\n]/.test(e)) return null;
  const n=[{op:'',opStart:-1,start:-1,end:-1,pieces:[]}]; let r=false;
  const push=(seg,kind,text,s)=>{ seg.pieces.push({kind,text,start:s}); if(seg.start<0) seg.start=s; };
  for(const tok of shTokens(e)){
    const seg=n[n.length-1];
    if(tok.t==='op'){ n.push({op:tok.text,opStart:tok.s,start:-1,end:-1,pieces:[]}); r=false; continue; }
    if(tok.t==='space'){ if(seg.pieces.length) push(seg,'text',tok.text,tok.s); continue; }
    if(tok.t==='redir'){ push(seg,'redirect',tok.text,tok.s); continue; }
    const w=tok.w; let a='text';
    if(!r&&!TIP_ASSIGN.test(w.raw)){ a='program'; r=true; } else if(/^-/.test(w.raw)) a='flag';
    let s=tok.s; for(const p of w.parts){ push(seg,p.quoted?'string':a,p.text,s); s+=p.text.length; }
  }
  for(const seg of n){
    while(seg.pieces.length&&seg.pieces[seg.pieces.length-1].kind==='text'&&!seg.pieces[seg.pieces.length-1].text.trim()) seg.pieces.pop();
    const last=seg.pieces[seg.pieces.length-1]; seg.end = last ? last.start+last.text.length : seg.start;
  }
  return n.filter((seg,i)=>i===0||seg.pieces.length>0);
}
// What the tip says for a row — {text, shell} — or null when the label already says it.
// A shell call's tip is its command; any other row's is its raw title when the label is
// the call's purpose instead, or the label itself when the row cuts it short.
function tipFor(d){
  const t=d._tool; if(!t) return null;
  const tt=d.querySelector('.tool-title'); const label=tt?tt.textContent:''; const cut=Boolean(tt && tt.scrollWidth>tt.clientWidth+1);
  let v=t.input; if(typeof v==='string'){ try{ v=JSON.parse(v); }catch{ v=null; } }
  const cmd = v && typeof v==='object' && !Array.isArray(v) && typeof v.command==='string' ? v.command : '';
  const shell = Boolean(cmd) && (t.kind==='execute' || TIP_SHELL_NAMES.test(t.name) || !t.kind || t.kind==='unknown');
  if(shell){ return cmd!==label || cut ? {text:cmd, shell:true} : null; }
  if(t.raw && t.raw!==label) return {text:t.raw, shell:false};
  return cut && label ? {text:label, shell:false} : null;
}
// The text the tip shows (and the key its colours are cached under): the command, cut at 1200 chars.
function tipText(tip){ return tip.text.length>TIP_MAX_CHARS ? tip.text.slice(0,TIP_MAX_CHARS) : tip.text; }
// ---- the native colours: one request per distinct command, answered by the extension.
const TIP_HL=new Map(), TIP_HL_PENDING=new Map(), TIP_HL_MAX=200; let TIP_HL_REQ=0, TIP_NATIVE=true;
function tipRequest(text){
  if(!TIP_NATIVE || TIP_HL.has(text)) return;
  for(const pending of TIP_HL_PENDING.values()) if(pending===text) return;
  const req=++TIP_HL_REQ; TIP_HL_PENDING.set(req, text); vscode.postMessage({type:'highlight', req, text});
}
function tipHighlighted(m){
  const text=TIP_HL_PENDING.get(m.req); TIP_HL_PENDING.delete(m.req);
  if(!Array.isArray(m.lines)){ TIP_NATIVE=false; return; }
  if(text===undefined) return;
  if(TIP_HL.size>=TIP_HL_MAX) TIP_HL.delete(TIP_HL.keys().next().value);
  TIP_HL.set(text, m.lines);
  if(tipShown && tipShown.shell && tipText(tipShown)===text) tipRepaint();
}
function tipReset(){ TIP_HL.clear(); TIP_HL_PENDING.clear(); TIP_NATIVE=true; if(tipShown){ if(tipShown.shell) tipRequest(tipText(tipShown)); tipRepaint(); } }
// The runs of one line painted into \`el\` for the range [from, to): one span per run, the
// theme colour inline (none for the default foreground), italic / bold / underline /
// strikethrough from the font-style bits.
function paintRuns(el, runs, from, to, lineText){
  for(const r of runs){
    const a=Math.max(from, r.s), b=Math.min(to, r.e); if(a>=b) continue;
    const x=document.createElement('span'); x.textContent=lineText.slice(a,b);
    if(r.c) x.style.color=r.c;
    if(r.f&1) x.style.fontStyle='italic'; if(r.f&2) x.style.fontWeight='600';
    const deco=[]; if(r.f&4) deco.push('underline'); if(r.f&8) deco.push('line-through'); if(deco.length) x.style.textDecoration=deco.join(' ');
    el.appendChild(x);
  }
}
var tipEl=null, tipTimer=0, tipHead=null, tipShown=null;  // var: show()/toolToggle() may run before this line is evaluated
function tipNode(){ if(!tipEl){ tipEl=document.createElement('div'); tipEl.className='ktip'; tipEl.id='ktip'; tipEl.setAttribute('role','tooltip'); tipEl.hidden=true; document.body.appendChild(tipEl); } return tipEl; }
function tipRender(tip){
  const el=tipNode(); el.textContent=''; el.className='ktip '+(tip.shell?'sh':'txt');
  const text=tipText(tip); let cut=tip.text.length>text.length;
  const hl = tip.shell ? (TIP_HL.get(text)||null) : null; el.dataset.native = tip.shell ? String(Boolean(hl)) : 'n/a';
  const sr=document.createElement('span'); sr.className='ktip-sr'; sr.textContent=text; el.appendChild(sr);
  if(tip.shell){
    const segs=shSegments(text);
    const grid=document.createElement('div'); grid.className='ktip-grid'; grid.setAttribute('aria-hidden','true');
    // one grid row: the gutter (\`$\`, or the operator — in its theme colour when the runs give one), then the cell
    const line=(op,opStart,fill)=>{ const g=document.createElement('span'); g.className='ktip-op'+(op&&TIP_PIPES.has(op)?' pipe':''); g.textContent=op||'$'; if(op&&hl){ const run=hl[0].find(r=>r.s<=opStart&&opStart<r.e); if(run&&run.c) g.style.color=run.c; } const s=document.createElement('span'); s.className='ktip-seg'; fill(s); grid.appendChild(g); grid.appendChild(s); };
    if(segs){
      if(segs.length>TIP_MAX_LINES) cut=true;
      segs.slice(0,TIP_MAX_LINES).forEach((seg,i)=>line(i?seg.op:'', seg.opStart, (s)=>{
        if(hl) paintRuns(s, hl[0]||[], seg.start, seg.end, text);
        else for(const p of seg.pieces){ const x=document.createElement('span'); x.className='p-'+p.kind; x.textContent=p.text; s.appendChild(x); }
      }));
    } else {
      const lines=text.split(/\\r?\\n/); if(lines.length>TIP_MAX_LINES) cut=true;
      line('', -1, (s)=>{
        if(hl) lines.slice(0,TIP_MAX_LINES).forEach((ln,i)=>{ if(i) s.appendChild(document.createTextNode('\\n')); paintRuns(s, hl[i]||[], 0, ln.length, ln); });
        else s.textContent=lines.slice(0,TIP_MAX_LINES).join('\\n');
      });
    }
    el.appendChild(grid);
  } else { const p=document.createElement('span'); p.setAttribute('aria-hidden','true'); p.textContent=text; el.appendChild(p); }
  if(cut){ const c=document.createElement('div'); c.className='ktip-cut'; c.textContent='… '+TIP_CUT_HINT; el.appendChild(c); }
  return el;
}
// Above the row's header, left-aligned with it; below when the top has no room; kept 8px
// inside the viewport either way.
function tipPlace(el, head){
  const r=head.getBoundingClientRect(); el.hidden=false; el.style.top='0px'; el.style.left='0px';
  const w=el.offsetWidth, h=el.offsetHeight, vw=window.innerWidth, vh=window.innerHeight;
  let top=r.top-8-h, place='above';
  if(top<8){ place='below'; top=Math.min(r.bottom+8, vh-8-h); if(top<8) top=8; }
  el.style.top=top+'px'; el.style.left=Math.max(8, Math.min(r.left, vw-8-w))+'px'; el.dataset.placement=place;
}
function tipShow(head){
  const d=head.closest('.row.tool.call'); if(!d || d.dataset.open==='true') return;
  const tip=tipFor(d); if(!tip) return;
  tipHide(); if(tip.shell) tipRequest(tipText(tip));
  tipShown=tip; const el=tipRender(tip); tipPlace(el, head); tipHead=head; head.dataset.tip='true'; head.setAttribute('aria-describedby', el.id);
}
function tipRepaint(){ if(!tipShown || !tipHead) return; tipPlace(tipRender(tipShown), tipHead); }
function tipHide(){ if(tipTimer){ clearTimeout(tipTimer); tipTimer=0; } if(tipHead){ delete tipHead.dataset.tip; tipHead.removeAttribute('aria-describedby'); tipHead=null; } tipShown=null; if(tipEl) tipEl.hidden=true; }
// The pointer rested on a header: ask for the colours at once (the answer usually beats the delay), show after it.
function tipArm(head){
  tipHide();
  const d=head.closest('.row.tool.call'); const tip = d && d.dataset.open!=='true' ? tipFor(d) : null; if(tip && tip.shell) tipRequest(tipText(tip));
  tipTimer=setTimeout(()=>{ tipTimer=0; if(head.isConnected && head.matches(':hover')) tipShow(head); }, TIP_DELAY);
}
window.addEventListener('scroll', ()=>tipHide(), {capture:true, passive:true});
window.addEventListener('resize', ()=>tipHide());
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') tipHide(); });
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
function renderMd(node, s){ node.classList.add('md'); node.innerHTML = mdToHtml(s); hydrateImages(node); }
// ---- Images. The page cannot read the disk, so a local image (an upload the host kept
// under ~/.kiro/crew/uploads, a screenshot the agent saved, a markdown image in an answer)
// is a placeholder until the extension answers an 'image' request with a data URL; the
// answer is cached per path for the window. A thumbnail or picture opens the lightbox.
const IMG_EXT = /\\.(?:png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const imgCache = new Map(), imgPending = new Set();
function isImagePath(p){ return IMG_EXT.test(String(p||'')); }
function baseName(p){ return String(p||'').split('/').pop()||String(p||''); }
function imgRequest(path){ if(imgCache.has(path) || imgPending.has(path)) return; imgPending.add(path); vscode.postMessage({type:'image', id:active, path}); }
/* An <img> for \`path\`: shown at once from \`data\` or the cache, else a placeholder that the
   'image' answer swaps for the picture (or an error note naming the file as a link). */
function imageEl(path, name, data){
  const src = data || imgCache.get(path);
  if(src){ const im=document.createElement('img'); im.src=src; im.alt=name||baseName(path); im.title=name||baseName(path); im.dataset.path=path; im.dataset.name=name||baseName(path); return im; }
  const ph=document.createElement('span'); ph.className='imgph'; ph.dataset.path=path; ph.dataset.name=name||baseName(path); ph.textContent='🖼 '+ph.dataset.name+' …'; ph.title='loading '+path; imgRequest(path); return ph;
}
function imgPlace(ph, data, error){
  const path=ph.dataset.path, name=ph.dataset.name||ph.getAttribute('alt')||baseName(path);
  if(data){ const im=document.createElement('img'); im.src=data; im.alt=name; im.title=name; im.dataset.path=path; im.dataset.name=name; if(ph.classList.contains('mdimg')) im.className='mdimg'; ph.replaceWith(im); return; }
  const err=document.createElement('span'); err.className='imgph err'; err.dataset.path=path;
  const a=document.createElement('a'); a.className='path'; a.dataset.path=path; a.textContent=name; a.title='Open '+path; err.appendChild(document.createTextNode('🖼 ')); err.appendChild(a); err.appendChild(document.createTextNode(' — '+(error||'no preview'))); ph.replaceWith(err);
}
/* After a markdown render: every <img data-path> the renderer left is a local image to fetch. */
function hydrateImages(node){ node.querySelectorAll('img.mdimg[data-path]:not([src])').forEach((im)=>{ const p=im.dataset.path; if(imgCache.has(p)){ im.src=imgCache.get(p); im.dataset.name=im.getAttribute('alt')||baseName(p); } else imgRequest(p); }); }
function imgArrived(m){
  imgPending.delete(m.path);
  if(m.data) imgCache.set(m.path, m.data);
  document.querySelectorAll('.imgph[data-path], img.mdimg[data-path]:not([src])').forEach((el)=>{ if(el.dataset.path!==m.path) return; if(el.tagName==='IMG'){ if(m.data){ el.src=m.data; el.dataset.name=el.getAttribute('alt')||baseName(m.path); } else imgPlace(el, null, m.error); } else imgPlace(el, m.data, m.error); });
  pinSchedule();
}
/* The user's attachments, from a live send (objects with name/path/image/data) or a history
   row (the \`[attached_file N] path\` markers in the text plus meta.files, resolved losslessly
   against that list as the dashboard does; a marker with no list falls back to the path text). */
function attachmentsOf(content, files){
  const list = Array.isArray(files) ? files.map((f)=>typeof f==='string'?{path:f}:f).filter((f)=>f&&(f.path||f.name)) : [];
  const items=[]; const seen=new Set();
  const add=(f)=>{ const path=f.path||''; const key=path||f.name; if(seen.has(key)) return; seen.add(key); items.push({ name:f.name||baseName(path), path, image: f.image!=null ? Boolean(f.image) : isImagePath(path||f.name), data:f.data }); };
  // A marker's path is consumed whole when meta.files names it (a path with a space survives);
  // without the list the whitespace-bounded text after the marker is the best guess.
  const src=String(content||''); const re=/\\[attached_file (\\d+)\\][ \\t]*/g; let text='', last=0, mm;
  while((mm=re.exec(src))){
    text+=src.slice(last, mm.index); let end=re.lastIndex; const f=list[Number(mm[1])-1];
    if(f && f.path && src.startsWith(f.path, end)){ end+=f.path.length; add(f); }
    else { const tail=/^\\S*/.exec(src.slice(end))[0]; end+=tail.length; if(f) add(f); else if(tail) add({path:tail}); }
    last=end; re.lastIndex=end;
  }
  text=(text+src.slice(last)).replace(/\\n{3,}/g,'\\n\\n').trim();
  for(const f of list) add(f);
  return { text, items };
}
/* One # context chip, drawn the same in the composer (with its ×) and in the user bubble
   (read-only): the glyph in bold (a provider's own, # for files), the label, and when the
   provider cut the text to the cap a … marker with the note as tooltip (requirement 9.3). */
${contextChipLabel.toString()}
${contextChipTooltip.toString()}
${contextChipEcho.toString()}
function contextChip(entry, onRemove){
  const e = entry && typeof entry==='object' ? entry : { label: entry==null ? '' : String(entry) };
  const ch=document.createElement('span'); ch.className='chip'; if(e.kind) ch.dataset.kind=e.kind;
  const glyph=String(e.glyph||'#'), label=contextChipLabel(e);
  const b=document.createElement('b'); b.textContent=glyph; ch.appendChild(b); ch.appendChild(document.createTextNode(label.slice(glyph.length)));
  const tip=contextChipTooltip(e); if(tip) ch.title=tip;
  if(e.truncated){ ch.dataset.truncated='1'; const cut=document.createElement('span'); cut.className='cut'; cut.textContent='…'; cut.title=tip; ch.appendChild(cut); }
  if(onRemove){ const rm=document.createElement('button'); rm.className='rm'; rm.textContent='×'; rm.title='Remove'; rm.onclick=(ev)=>{ ev.stopPropagation(); onRemove(); }; ch.appendChild(rm); }
  return ch;
}
/* The user's bubble: # context chips, the typed text (markers stripped; the full prompt is kept
   for the pinned card), then the attachment strip. One renderer for a live send and a history row. */
function userBubble(d, content, contexts, files, checkpoint){
  const { text, items } = attachmentsOf(content, files);
  d.dataset.prompt = String(text||'');
  if(contexts && contexts.length){ const c=document.createElement('div'); c.className='ctx'; contexts.forEach((x)=>{ c.appendChild(contextChip(x, null)); }); d.appendChild(c); }
  if(text) d.appendChild(document.createTextNode(text));
  if(items.length) d.appendChild(attachmentStrip(items));
  if(checkpoint) revertAction(d, checkpoint);
}
/* The bubble's Revert changes action (a workspace checkpoint was taken before this turn):
   a click asks the extension, which confirms and restores; the answer lands as a row below. */
function revertAction(d, checkpoint){
  d.dataset.checkpoint = checkpoint;
  let b = d.querySelector('.revert');
  if(!b){ b=document.createElement('button'); b.className='revert'; b.type='button'; d.appendChild(b); }
  b.textContent='↶ Revert changes'; b.title='Restore the workspace files to how they were before this message';
  b.onclick=(e)=>{ e.stopPropagation(); vscode.postMessage({type:'revert', id:active, checkpoint}); };
}
/* The outcome of a revert (or its undo): one row naming the files put back, with Undo while the
   "before revert" checkpoint exists, and Open on each file. */
function revertRow(st, m){
  const d=el(st,'status revert-row');
  const files=Array.isArray(m.files)?m.files:[];
  const head=document.createElement('span');
  head.textContent = m.error ? ('Revert failed: '+m.error) : files.length===0 ? 'Nothing to revert: the files already match that point.' : ((m.undoOf?'Undo: ':'Reverted: ')+describeFiles(files));
  d.appendChild(head);
  if(!m.error && files.length && m.undo){ const u=document.createElement('button'); u.textContent=m.undoOf?'Redo':'Undo'; u.title=(m.undoOf?'Apply the reverted changes again':'Put the changes back'); u.onclick=()=>{ u.disabled=true; vscode.postMessage({type:'revert', id:active, checkpoint:m.undo, undoOf:m.id}); }; d.appendChild(u); }
  for(const f of files.slice(0,12)){ const s=document.createElement('span'); s.className='file'; s.textContent=(f.status==='A'?'− ':f.status==='D'?'+ ':'~ ')+baseName(f.path); s.title=(f.status==='A'?'removed (created after the checkpoint): ':f.status==='D'?'restored (deleted after the checkpoint): ':'restored: ')+f.path; s.style.cursor='pointer'; s.onclick=()=>vscode.postMessage({type:'open', id:active, path:(m.root?m.root+'/':'')+f.path}); d.appendChild(s); }
  if(files.length>12){ const more=document.createElement('span'); more.textContent='… '+(files.length-12)+' more'; d.appendChild(more); }
  scrollLog(st);
}
function describeFiles(files){ const n=files.length; return n+' file'+(n===1?'':'s')+' put back'; }
/* The bubble's attachment strip: a picture per image (thumbnail from its data or fetched), a 📎 chip per other file; each opens the file. */
function attachmentStrip(items){
  const box=document.createElement('div'); box.className='att';
  for(const it of items){
    // An image with its bytes shows at once (a just-sent paste has no path yet); one with only a path is fetched.
    if(it.image && (it.data || it.path)){ box.appendChild(imageEl(it.path||'', it.name, it.data)); continue; }
    const ch=document.createElement('span'); ch.className='file'; ch.textContent='📎 '+it.name; if(it.path){ ch.title='Open '+it.path; ch.dataset.path=it.path; ch.onclick=()=>vscode.postMessage({type:'open', id:active, path:it.path}); }
    box.appendChild(ch);
  }
  return box;
}
// The lightbox: full size, the file name, Open file (an editor tab), Esc or a click outside closes.
const lightbox=$('lightbox'), lbImg=lightbox.querySelector('img'), lbName=lightbox.querySelector('.lb-name'), lbOpen=lightbox.querySelector('.lb-open');
function lightboxShow(src, name, path){ lbImg.src=src; lbImg.alt=name||''; lbName.textContent=name||baseName(path)||''; lbOpen.hidden=!path; lbOpen.dataset.path=path||''; lightbox.classList.add('on'); lightbox.querySelector('.lb-close').focus(); }
function lightboxHide(){ lightbox.classList.remove('on'); lbImg.removeAttribute('src'); }
lightbox.addEventListener('click', (e)=>{ if(e.target===lightbox || e.target.classList.contains('lb-close')) lightboxHide(); });
lbOpen.onclick=()=>{ if(lbOpen.dataset.path) vscode.postMessage({type:'open', id:active, path:lbOpen.dataset.path}); };
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && lightbox.classList.contains('on')){ e.preventDefault(); lightboxHide(); } });
document.addEventListener('click', (e)=>{ const im=e.target.closest && e.target.closest('.user .att img, .md img.mdimg, .chip.img img'); if(!im || !im.src) return; e.preventDefault(); lightboxShow(im.src, im.dataset.name||im.getAttribute('alt')||'', im.dataset.path||''); });
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
/* The host's injected rows (role "inject"): a tool call a safety policy stopped, a turn the
   gateway resumed on its own, a Continue the user asked for, a sub-agent synthesis. The
   dashboard folds each into a collapsed recovery card — a title, a muted detail, the matched
   policy pattern as a mono chip, the whole notice a click away — and the IDE draws the same
   card, with the dashboard's own prefix table and wording. A row with no known prefix gets
   the generic System notice card when its injectKind is recovery or synthesis; an
   automation_notice row is not shown at all; any other inject row (a cron notification, a
   replayed user turn) stays the quiet mono row it was. */
const INJECT_KINDS=[['refusal','[Tool refusal — automatic recovery]'],['tool_blocked','[Tool blocked — reason sent to the agent]'],['stalled','[Stalled turn — automatic recovery]'],['tool_stall','[Tool stall — automatic recovery]'],['connection','[Connection lost — automatic recovery]'],['busy','[Session busy — automatic recovery]'],['posttoken','[Interrupted turn — automatic recovery]'],['empty','[Empty response — automatic recovery]'],['promise_only','[Unfinished action — automatic recovery]'],['compaction','[Context compacted — automatic recovery]'],['manual','[Continue — requested by the user]'],['refusal_fallback','[Content filter — continuing on the fallback model]'],['hook','[Hook continuation — automatic]'],['hook_halted','[Stop-hook nudge cap reached]'],['synthesis','[SYSTEM] Sub-agent synthesis:']];
const INJECT_TEXT={stalled:['Turn stalled','continuation sent automatically'],tool_stall:['Tool stopped responding','stalled tool call cancelled · continuation sent automatically'],connection:['Turn interrupted','backend error · continuation sent automatically'],posttoken:['Turn interrupted','backend error · continuation sent automatically'],busy:['Turn interrupted','session busy · continuation sent automatically'],empty:['No response returned','agent returned no output · continuation sent automatically'],promise_only:['Action not taken','announced but not done · continuation sent automatically'],compaction:['Context compacted','summarized mid-turn · continuation sent automatically'],manual:['Continued at your request','resuming the interrupted turn'],refusal_fallback:['Content filter declined the turn','switched to the fallback model · continuation sent automatically'],hook:['Continued by a hook','requested by a hook · continuing'],hook_halted:['Hook loop halted','nudge cap reached'],synthesis:['Sub-agents finished','consolidated summary requested'],generic:['System notice','injected by the gateway']};
const BLOCK_DETAIL={policy:'safety policy blocked the call · the agent was told why, in this turn',invalid_name:'tool name validation blocked the call · the agent was told why, in this turn',hook_error:'a hook faulted before the call · the agent was told why, in this turn'};
const INJECT_ROUTINE=new Set(['connection','busy','posttoken','empty','promise_only','compaction','manual','refusal_fallback','hook','synthesis','generic']);
const POLICY_RE=/Blocked by security policy:\\s*(.+?)\\s*$/gm;
function parseInject(content, meta){
  const text=String(content||''); const hit=INJECT_KINDS.find(([,p])=>text.startsWith(p));
  const card=(kind,title,detail,chip,body)=>({kind,title,detail,chip:chip||'',body:body||'',severity:INJECT_ROUTINE.has(kind)?'routine':'attention'});
  if(!hit){ const k=meta&&meta.injectKind; if(k!=='recovery'&&k!=='synthesis') return null; const t=INJECT_TEXT.generic; return card('generic',t[0],t[1],'',text); }
  const [kind,prefix]=hit; const rest=text.slice(prefix.length); const after=rest.trim();
  const nl=rest.indexOf('\\n'); const firstLine=(nl===-1?rest:rest.slice(0,nl)).trim(); const tail=nl===-1?'':rest.slice(nl+1).trim();
  if(kind==='hook_halted'){ const m=/#(\\d+)/.exec(firstLine); const t=INJECT_TEXT.hook_halted; return card(kind,t[0],t[1],m?'#'+m[1]:'',tail); }
  if(INJECT_TEXT[kind]){ const t=INJECT_TEXT[kind]; return card(kind,t[0],t[1],'',after); }
  // refusal / tool_blocked: one "- " bullet per blocked call, the policy pattern(s) as the chip;
  // a tool_blocked row's first word (policy | invalid_name | hook_error) picks the detail.
  const calls=after.split('\\n').filter((l)=>/^\\s*-\\s+\\S/.test(l)).length;
  const pats=new Set(); for(const m of after.matchAll(POLICY_RE)) pats.add(m[1]);
  const chip=pats.size===1?[...pats][0]:pats.size>1?pats.size+' patterns':'';
  const title=calls>1?calls+' tool calls blocked':'Tool call blocked';
  if(kind==='tool_blocked') return card(kind,title,BLOCK_DETAIL[firstLine]||BLOCK_DETAIL.policy,chip,tail);
  return card(kind,title,'safety policy blocked the call · continuation sent automatically',chip,after);
}
// The dashboard's lucide icons for the card: triangle-alert (attention), rotate-ccw (a resumed turn), layers (synthesis), info (generic).
const RC_ICONS={alert:'<svg viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',rotate:'<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',layers:'<svg viewBox="0 0 24 24"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>',info:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'};
function injectCard(d, c){
  d.classList.add('recov'); d.dataset.testid='recovery-card'; d.dataset.kind=c.kind; d.dataset.severity=c.severity; d.dataset.open='false';
  const head=document.createElement('button'); head.type='button'; head.className='rc-head'; head.setAttribute('aria-expanded','false'); head.title=c.title+' · '+c.detail;
  const chev=document.createElement('span'); chev.className='rc-chev'; chev.textContent='›'; head.appendChild(chev);
  const ico=document.createElement('span'); ico.className='rc-ico'; ico.innerHTML=RC_ICONS[c.kind==='synthesis'?'layers':c.kind==='generic'?'info':c.severity==='attention'?'alert':'rotate']; head.appendChild(ico);
  const tt=document.createElement('span'); tt.className='rc-title'; tt.textContent=c.title; head.appendChild(tt);
  const dt=document.createElement('span'); dt.className='rc-detail'; dt.textContent=c.detail; head.appendChild(dt);
  if(c.chip){ const ch=document.createElement('code'); ch.className='rc-chip'; ch.dataset.testid='recovery-card-chip'; ch.textContent=c.chip; ch.title=c.chip; head.appendChild(ch); }
  d.appendChild(head);
  const body=document.createElement('div'); body.className='rc-body'; body.dataset.testid='recovery-card-body'; body.hidden=true; linkify(body, c.body); d.appendChild(body);
  head.onclick=()=>{ const open=body.hidden; body.hidden=!open; d.dataset.open=String(open); head.setAttribute('aria-expanded',String(open)); pinSchedule(); };
}
function row(id, r){
  const st=pane(id);
  if(r.meta && r.meta.mid){ if(st.seen.has(r.meta.mid)) return; st.seen.add(r.meta.mid); }
  if(r.role==='assistant' && st.streaming){ st.buf=r.content; finishStream(st); return; }
  if(r.role==='chunk'||r.role==='done'||r.role==='streaming'||r.role==='queued') return;
  if(r.role==='permission'){
    const box = el(st,'permission'); box.dataset.testid='approval-card';
    const m = r.meta||{}; const title = m.tool_title||m.tool_name||'tool'; box.dataset.requestId=String(m.request_id||m.approval_id||'');
    box.textContent = 'Approval needed: '+title+(m.full_command?'\\n$ '+m.full_command:(m.tool_input?'\\n'+String(m.tool_input).slice(0,400):''));
    // One handler per decision; the buttons and approve-all / reject-all (requirement 8.4) all go through it.
    const decide=(action)=>{ vscode.postMessage({type:'approve',id,requestId:m.request_id||m.approval_id||'',action}); box.remove(); };
    const a=document.createElement('button');a.textContent='Approve';a.dataset.action='approved';a.onclick=()=>decide('approved');
    const j=document.createElement('button');j.className='reject';j.textContent='Reject';j.dataset.action='rejected';j.onclick=()=>decide('rejected');
    box.appendChild(document.createElement('br'));box.appendChild(a);box.appendChild(j);scrollLog(st);return;
  }
  if(r.role==='thinking'){ if(r.content){ thinkDelta(st, r.content); thinkClose(st); scrollLog(st); } return; }
  if(r.role==='inject'){
    const meta=r.meta||{}; if(meta.injectKind==='automation_notice') return;
    const c=parseInject(r.content, meta); if(c){ injectCard(el(st,'recov'), c); scrollLog(st); return; }
  }
  // The host's failure rows: the error role (its turn-ceiling card, a refused
  // turn) or a msg-err / ❌ ⏱ assistant row — all the red box.
  const isErr = r.role==='error' || (r.role==='assistant' && (/\\bmsg-err\\b/.test(r.cls||'') || /^\\s*[❌⏱]/.test(r.content||'')));
  const cls = isErr ? 'assistant' : (['user','assistant','tool','status'].includes(r.role)?r.role:'tool');
  if(cls==='user') dropResume(st);
  const d = el(st,cls+(isErr?' err':'')); if(cls==='user'){userBubble(d, r.content, null, (r.meta&&r.meta.files)||[]);} else if(cls==='assistant'){assistant(st, d, r.content);} else if(cls==='tool' && r.role==='tool' && isToolCall(r)){toolRow(st, d, r);} else {linkify(d, r.content);}
  if(isErr && isTurnLimit(r.content)) resumeButton(st, d, id);
  scrollLog(st);
}
/* The extension judged the tab's task run from tasks.md (an interrupted run, a stop, a
   question in the way): a quiet card under the last row, with Resume run when a resume
   would do something. Gone like the Continue button once a later user turn exists. */
function interrupted(id, m){
  const st=pane(id); dropResume(st);
  const d = el(st,'assistant pause'); d.dataset.testid='run-card'; linkify(d, m.text||'');
  if(m.resume) resumeButton(st, d, id, m.label||'Resume run', m.hint||'Re-read tasks.md and send the run\\'s request again from the next unfinished task.');
  scrollLog(st);
}
/* The host's turn-ceiling card ("⏱️ This turn hit the 4-hour limit and was stopped … Send a
   message to continue from where it stopped."): one Continue button does that. A task run
   resumes itself too (the extension re-sends from tasks.md); the button stays for a run past
   its cap and for a plain chat, and goes once a later user turn exists. */
function isTurnLimit(s){ return /hit the \\S+ limit and was stopped/i.test(String(s||'')); }
function dropButtons(st){ st.log.querySelectorAll('button.resume').forEach((b)=>b.remove()); }
function dropResume(st){ dropButtons(st); st.log.querySelectorAll('.row.pause').forEach((p)=>p.remove()); }
/* The "starting…" row a spec action drew at click time: gone the moment the turn's own bubble lands. */
function dropStarting(st){ st.log.querySelectorAll('.row.starting').forEach((p)=>p.remove()); }
function resumeButton(st, d, id, label, title){
  dropButtons(st);
  const b=document.createElement('button'); b.className='resume'; b.textContent=label||'Continue from where it stopped';
  b.title=title||'Send the continuation for this turn. A task run re-reads tasks.md and resumes from the next unfinished task.';
  b.onclick=()=>{ b.disabled=true; b.textContent=(label?label.replace(/run$/,'running'):'Continuing')+'…'; vscode.postMessage({type:'resume', id}); };
  d.appendChild(b);
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
// The strip's order, for the next/previous shortcuts (wraps at both ends; mirrors nextTabIndex on the extension side).
let tabOrder = [];
function stepTab(dir){
  const n=tabOrder.length; if(n<2) return;
  let at=tabOrder.indexOf(active); if(at<0) at=0; else at=((at+(dir<0?-1:1))%n+n)%n;
  vscode.postMessage({type:'select', id:tabOrder[at]});
}
function renderTabs(tabs, act){
  tabsEl.innerHTML='';
  tabOrder = tabs.map((t)=>t.id);
  for(const t of tabs){
    const st=pane(t.id); st.running=Boolean(t.running); st.settings=t.settings||st.settings; st.key=t.key; st.engine=t.engine||''; setWork(st); for(const d of st.log.querySelectorAll('.row.tool.call')) toolLive(st, d);
    const d=document.createElement('div'); d.className='tab'+(t.id===act?' on':''); d.title=(t.key||'new chat')+' — double-click to rename'; d.dataset.id=String(t.id);
    d.ondblclick=(e)=>{ e.preventDefault(); vscode.postMessage({type:'rename', id:t.id}); };
    d.oncontextmenu=(e)=>{ e.preventDefault(); e.stopPropagation(); openMenu(d, null, [{id:'rename', label:'Rename'}, {id:'close', label:'Close tab'}], '', (it)=>vscode.postMessage({type:it.id, id:t.id})); };
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
  chipsEl.innerHTML=''; const items = st ? st.contexts.map((c,i)=>({kind:'ctx', entry:c, i})).concat(st.files.map((f,i)=>({kind:'file', label:f.name, i, file:f}))) : [];
  chipsEl.classList.toggle('has', items.length>0);
  for(const it of items){
    // A # context (file kind or provider) is the shared chip; files and images keep their own.
    if(it.kind==='ctx'){ chipsEl.appendChild(contextChip(it.entry, ()=>{ st.contexts.splice(it.i,1); renderCompose(); })); continue; }
    const ch=document.createElement('span'); ch.className='chip';
    const img = /^image\\//.test(it.file.mime||'') && it.file.data;
    if(img){ ch.classList.add('img'); const im=document.createElement('img'); im.src='data:'+it.file.mime+';base64,'+it.file.data; im.alt=it.label; im.title=it.label+' — click to preview'; im.dataset.name=it.label; ch.appendChild(im); }
    else { const b=document.createElement('b'); b.textContent='📎'; ch.appendChild(b); ch.appendChild(document.createTextNode(it.label)); }
    const rm=document.createElement('button'); rm.className='rm'; rm.textContent='×'; rm.title='Remove'; rm.onclick=(e)=>{ e.stopPropagation(); st.files.splice(it.i,1); renderCompose(); }; ch.appendChild(rm); chipsEl.appendChild(ch); }
  renderHint();
}
function renderHint(){ const st=state.get(active); const kas = st && (st.engine==='kas' || (st.settings&&st.settings.engine==='kas'));
  $('hint').textContent = kas ? (st.key ? 'Kiro-mode session '+st.key.replace(/^kas:/,'')+' — runs in kiro-cli on the gateway host; find it again under History.' : "Kiro's own engine: this tab will run in kiro-cli on the gateway host (KAS permissions and Autopilot apply).")
    : (st&&st.key ? 'session '+st.key+' — runs in the gateway; find it again under History.' : 'Sessions run in the KiroCrew gateway and keep going if this window disconnects.'); }
// In-page popover menu (never window.prompt/confirm: those are no-ops in the desktop app).
function openMenu(anchor, header, items, current, onPick){
  menu.innerHTML=''; if(header){ const h=document.createElement('div'); h.className='h'; h.textContent=header; menu.appendChild(h); }
  let section=null;
  for(const it of items){ if(it.section && it.section!==section){ section=it.section; const h=document.createElement('div'); h.className='h'; h.textContent=section; menu.appendChild(h); }
    const b=document.createElement('button'); b.className='it'+(it.id===current?' on':''); b.textContent=it.label; if(it.glyph) b.dataset.glyph=it.glyph; if(it.description){ const sm=document.createElement('small'); sm.textContent=it.description; b.appendChild(sm);} b.onclick=()=>{ closeMenu(); onPick(it); }; menu.appendChild(b); }
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
function pickId(s){ if(s.engine==='kas') return 'kas:'+(s.mode||'spec'); if(s.mode && s.mode!=='default'){ const kiro=(choices.agents||[]).find(x=>x.kiro && x.id==='agent:'+s.agent); return kiro ? kiro.id : 'workflow:'+s.mode; } return s.agent ? 'agent:'+s.agent : ''; }
/* An empty chat's workflow tile: Kiro's own mode (kiro-cli) when the picker offers it,
   else the mod's prompt-guided workflow on the picked agent. Mirrors the agent menu's
   own derivation so the composer bar updates before the round trip. */
function pickMode(mode){
  const st=state.get(active); if(!st) return;
  const kas=(choices.agents||[]).find((x)=>x.id==='kas:'+mode);
  const id=kas?kas.id:'workflow:'+mode;
  if(kas){ if(!st.key) st.settings.engine='kas'; if(!st.key || st.settings.engine==='kas') st.settings.mode=mode; }
  else { if(!st.key) st.settings.engine=''; st.settings.mode=mode; st.settings.agent=st.settings.baseAgent||''; }
  renderCompose();
  vscode.postMessage({type:'setting', id:active, key:'pick', value:id});
  const box=$('input'); if(box) box.focus();
}
function pickLabel(s){ const id=pickId(s); const it=(choices.agents||[]).find(x=>x.id===id); if(it) return it.label + (s.engine==='kas' ? ' · kiro-cli' : ''); if(s.engine==='kas') return (s.mode||'Kiro mode')+' · kiro-cli'; return s.agent || 'Default'; }
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
    if(kind==='kashint'){ vscode.postMessage({type:'hint', value:'kas'}); return; }
    // Mirror the extension's derivation so the bar updates before the round trip (a live tab's
    // engine cannot change; the extension's tabs push restores the bar if the pick was refused).
    if(kind==='kas'){ if(!st.key) st.settings.engine='kas'; if(!st.key || st.engine==='kas') st.settings.mode=name; }
    else { if(!st.key) st.settings.engine='';
      if(kind==='workflow'){ st.settings.mode=name; st.settings.agent=st.settings.baseAgent||''; } else { st.settings.agent = kind==='agent'?name:''; st.settings.baseAgent=st.settings.agent; st.settings.mode = it.kiro ? it.label.toLowerCase().replace(' ','-') : 'default'; } }
    renderCompose(); vscode.postMessage({type:'setting', id:active, key:'pick', value:it.id}); }); };
$('auto').onclick=()=>{ const st=state.get(active); setting('autopilot', !(st&&st.settings.autopilot)); };
// Message font size: the transcript only (a CSS variable on .log); the tabs, bar and composer keep the workbench size.
let fontSize = 0, chatWidth = 'compact';
function applyFont(px){ fontSize = Number(px)||0; document.documentElement.style.setProperty('--kide-msg-size', fontSize ? fontSize+'px' : 'inherit'); applyWidth(chatWidth); }
/* The dashboard's three presets (ChatSettings): compact = 800px / 816px scaled by the message
   font size over its 14px default; comfortable = 84% / 85%; full = 92% / 93%. */
const WIDTHS = { compact:['800px','816px'], comfortable:['84%','85%'], full:['92%','93%'] };
function applyWidth(preset){
  chatWidth = WIDTHS[preset] ? preset : 'compact';
  let [msgs, input] = WIDTHS[chatWidth];
  if(chatWidth==='compact' && fontSize>0 && fontSize!==14){ const r=fontSize/14; msgs=Math.round(800*r)+'px'; input=Math.round(816*r)+'px'; }
  const rs=document.documentElement.style; rs.setProperty('--kide-content-width', msgs); rs.setProperty('--kide-input-width', input);
}
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
// Insert text at the caret (an unfocused textarea's caret sits at the end): a newline on each side
// where the inserted text would otherwise join a non-empty line, the caret moved past it, then focus.
function composeInsert(s){
  if(!s) { text.focus(); return; }
  const v=text.value, a=Math.min(text.selectionStart||0, v.length), b=Math.min(text.selectionEnd||a, v.length);
  const before=v.slice(0,a), after=v.slice(b);
  const lead = before && !before.endsWith('\\n') ? '\\n' : '';
  const trail = after && !after.startsWith('\\n') ? '\\n' : '';
  const piece = lead + s + trail;
  text.value = before + piece + after;
  const caret = before.length + lead.length + s.length;
  text.setSelectionRange(caret, caret);
  autoGrow(); text.focus();
}
(function(){ const grip=$('grip'); let startY=0, startH=0, moved=false;
  grip.addEventListener('mousedown', (e)=>{ e.preventDefault(); startY=e.clientY; startH=text.getBoundingClientRect().height; moved=false; grip.classList.add('drag');
    const move=(ev)=>{ const h=Math.max(48, Math.min(window.innerHeight*0.8, startH+(startY-ev.clientY))); moved=true; setManualHeight(h); };
    const up=()=>{ window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); grip.classList.remove('drag'); if(moved) vscode.postMessage({type:'composerHeight', px: manualHeight}); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); });
  grip.addEventListener('dblclick', ()=>{ setManualHeight(0); vscode.postMessage({type:'composerHeight', px: 0}); });
})();
renderSteering(); autoGrow();
// The file kinds first, then the context providers (a "Providers" section), each with its glyph and description.
const CONTEXT_KINDS = ${JSON.stringify(CONTEXT_KINDS.map((k) => ({ id: k.kind, label: k.label, glyph: k.glyph, section: k.section, description: k.description })))};
$('ctx').onclick=(e)=>openMenu(e.currentTarget, 'Add context', CONTEXT_KINDS, null, (it)=>vscode.postMessage({type:'pickContext', id:active, kind:it.id}));
$('att').onclick=()=>$('file').click();
// Files reach the composer three ways (the 📎 picker, a paste, a drop on the composer) and
// land in the same list: name, mime, base64 — the bytes travel to the extension on send.
async function takeFile(st, f, name){
  const buf=await f.arrayBuffer(); let bin=''; const bytes=new Uint8Array(buf); for(let i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000));
  st.files.push({name:name||f.name||'attachment', mime:f.type||'', data:btoa(bin)}); renderCompose();
}
function pastedName(type){ return 'pasted-image-'+Date.now()+'.'+((type||'').split('/')[1]||'png').replace(/^jpeg$/,'jpg').replace(/\\+xml$/,''); }
$('file').onchange=async ()=>{ const st=state.get(active); if(!st) return; for(const f of $('file').files) await takeFile(st, f); $('file').value=''; };
text.addEventListener('paste', (e)=>{ const st=state.get(active); if(!st||!e.clipboardData) return; let took=false; for(const item of e.clipboardData.items){ if(item.kind==='file' && /^image\\//.test(item.type)){ const f=item.getAsFile(); if(!f) continue; took=true; takeFile(st, f, pastedName(item.type)); } } if(took) e.preventDefault(); });
const composeEl=$('compose');
composeEl.addEventListener('dragover', (e)=>{ if(e.dataTransfer && [...e.dataTransfer.types].includes('Files')){ e.preventDefault(); e.dataTransfer.dropEffect='copy'; composeEl.classList.add('drop'); } });
composeEl.addEventListener('dragleave', (e)=>{ if(!composeEl.contains(e.relatedTarget)) composeEl.classList.remove('drop'); });
composeEl.addEventListener('drop', (e)=>{ composeEl.classList.remove('drop'); const st=state.get(active); if(!st||!e.dataTransfer||!e.dataTransfer.files||!e.dataTransfer.files.length) return; e.preventDefault(); for(const f of e.dataTransfer.files) takeFile(st, f); });
// Enter sends; Shift+Enter is a newline. Ctrl/Cmd+Enter sends too, except while approval
// cards are pending: then it is approve-all (requirement 8.4) and bubbles to the page handler.
text.addEventListener('keydown',(e)=>{ if(e.key==='Enter' && !e.shiftKey){ if(isApproveAllKey(e) && approvalsPending().length) return; e.preventDefault();send();} if(e.key==='#' && !text.value.trim()){ e.preventDefault(); $('ctx').click(); } });
// Your turn shows the instant you send it. The extension still has to create the session,
// apply the picks, upload the files, scan steering and inject contexts (each a round trip to
// the host) before the message goes out; the bubble used to wait for all of that. The page
// draws it now from what it already holds (text, chip labels, image bytes), tagged with a
// local id, and the extension's own 'user' message for the turn updates that bubble in place
// (the uploaded paths arrive with it) instead of adding a second one.
let localSeq=0;
function sendText(t){
  const st=state.get(active); if(active==null||!st) return;
  const contexts=st.contexts.splice(0), files=st.files.splice(0);
  const local='l'+(++localSeq);
  const shown = t || (files.length ? 'See the attached file(s).' : 'See the context provided.');
  thinkClose(st); dropResume(st);
  const d=el(st,'user'); d.dataset.local=local;
  userBubble(d, shown, contexts.map((c)=>contextChipEcho(c)), files.map((f)=>{ const image=/^image\\//.test(f.mime||''); return { name:f.name, image, data: image&&f.data ? 'data:'+f.mime+';base64,'+f.data : undefined }; }));
  st.running=true; setWork(st); scrollLog(st, true);
  vscode.postMessage({type:'send', id:active, text:t, contexts, files, local});
  renderCompose();
}
function send(){ const st=state.get(active); if(st && st.running){ vscode.postMessage({type:'stop', id:active}); return; } const t=text.value.trim(); if((!t && !(st&&(st.contexts.length||st.files.length)))||active==null) return; text.value=''; autoGrow(); sendText(t); }
$('send').onclick=send;

window.addEventListener('message', (e)=>{
  const m=e.data; const st = m.id!=null ? pane(m.id) : null;
  switch(m.type){
    case 'tabs': renderTabs(m.tabs, m.active); break;
    // Keyboard shortcuts forwarded by the extension (Ctrl/Cmd+Alt+→/←, +W, +T): the same
    // messages the strip's own click, × and ＋ post, so one path owns each change.
    case 'tabs.next': stepTab(1); break;
    case 'tabs.prev': stepTab(-1); break;
    case 'tabs.close': if(active!=null) vscode.postMessage({type:'close', id:active}); break;
    case 'tabs.new': vscode.postMessage({type:'new'}); break;
    case 'find.open': findOpen(); break;
    case 'approvals.approveAll': approvalsAll('approved'); break;
    case 'approvals.rejectAll': approvalsAll('rejected'); break;
    case 'tabs.rename': { const lab=tabsEl.querySelector('.tab[data-id="'+m.id+'"] .t'); if(lab) lab.textContent=m.title; break; }
    case 'choices': choices = { agents:m.agents||[], models:m.models||[], efforts:m.efforts||[] }; renderCompose(); break;
    case 'fontSize': applyFont(m.px); break;
    case 'width': applyWidth(m.preset); pinSchedule(); break;
    case 'toolCardDisplayMode': toolModeSet(m.mode); break;
    case 'composerHeight': setManualHeight(m.px); break;
    case 'steering': steering = Array.isArray(m.items) ? m.items : []; renderSteering(); break;
    case 'closed': { const s=state.get(m.id); if(s){ s.log.remove(); state.delete(m.id);} break; }
    case 'clear': st.log.innerHTML=''; st.log.appendChild(st.work); st.streaming=null; st.buf=''; st.seen=new Set(); st.cards.clear(); st.empty=null; thinkClose(st); st.think=null; setWork(st); st.follow=true; st.unseen=false; jumpUpdate(st); pinSchedule(); break;
    case 'session': st.key=m.key; st.engine=m.engine||''; if(m.id===active) renderHint(); break;
    // A Kiro-mode approval answered elsewhere (another window, Autopilot turned on): its card goes.
    case 'permissionResolved': st.log.querySelectorAll('.row.permission[data-request-id="'+String(m.requestId)+'"]').forEach((b)=>b.remove()); break;
    case 'context': st.contexts.push(m.item); if(m.id===active) renderCompose(); break;
    // The editor's "Ask about this" staged its chip and leaves the question to the user.
    case 'compose.focus': text.focus(); break;
    // "Add code block to chat": text into the composer at the caret, on its own line when the
    // composer already has text around it, then the caret after it and focus (not a send).
    case 'compose.insert': composeInsert(String(m.text||'')); break;
    case 'user': {
      // The turn the page already drew (same local id): fill in what the extension resolved
      // (file paths for the lightbox's Open file), in place. Anything else is a new row; one
      // that carries a local id (a Specs action drawn ahead of its session) is tagged with it
      // so the extension's later message for the same turn completes it instead of adding one.
      const own = m.local ? st.log.querySelector('.row.user[data-local="'+m.local+'"]') : null;
      if(own){ dropStarting(st); own.innerHTML=''; userBubble(own, m.text, m.contexts, m.files, m.checkpoint||own.dataset.checkpoint); break; }
      thinkClose(st); dropResume(st); dropStarting(st); const d=el(st,'user'); if(m.local) d.dataset.local=m.local; userBubble(d, m.text, m.contexts, m.files, m.checkpoint); st.running=true; setWork(st); scrollLog(st, true); break; }
    case 'starting': { // a spec action's "starting…" row: the chat works from the click, not from the send
      thinkClose(st); dropResume(st); dropStarting(st); el(st,'status starting', m.text||'Starting…'); st.running=true; setWork(st); scrollLog(st, true); break; }
    case 'checkpoint': { // the checkpoint of a turn, learned after its bubble was drawn (the snapshot ran meanwhile)
      const rows=st.log.querySelectorAll('.row.user'); const last=m.local ? st.log.querySelector('.row.user[data-local="'+m.local+'"]') : rows[rows.length-1];
      if(last && m.checkpoint) revertAction(last, m.checkpoint); break; }
    case 'reverted': revertRow(st, m); break;
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
    case 'highlighted': tipHighlighted(m); break;
    case 'highlightReset': tipReset(); break;
    case 'error': el(st,'error', m.text); scrollLog(st); break;
    case 'image': imgArrived(m); break;
    case 'interrupted': interrupted(m.id, m); break;
    case 'scroll': scrollLog(st, true); break;
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
  hooks: { dir: "hooks", icon: "zap", leaf: (name, kind) => kind === vscode.FileType.File && HOOK_FILE_RE.test(name), desc: "agent hooks (.json or .kiro.hook)" },
  // The read-only MCP Servers view (spec task 16.1): one file per tier, `settings/mcp.json`.
  mcp: { dir: "settings", icon: "server", leaf: (name, kind) => kind === vscode.FileType.File && name === "mcp.json", desc: "MCP servers (settings/mcp.json, read by kiro-cli)" },
};

// ---- Agent hooks (requirement 12.1, 12.2): the hook files Kiro reads from
// `.kiro/hooks/` and `~/.kiro/hooks/`, parsed for the view and toggled in place.
//
// Two file shapes are accepted. The v2 document (Kiro IDE `toV2HookDocument`,
// the Kiro IDE feature-map notes §4 (kept outside the package); the design's `HookFile`):
//   { name, description?, trigger, matcher?, action: { type: "askAgent", prompt } | { type: "runCommand", command }, timeout?, enabled? }
// and the legacy `.kiro.hook` document (Kiro IDE `extension-resources/hook.json`,
// what HOOK_TEMPLATE writes):
//   { name, description?, version?, enabled?, when: { type, patterns? }, then: { type: "askAgent", prompt } }
// Either way a missing `enabled` means on.

/** Hook files: the v2 `.json` and the legacy `.kiro.hook`. */
const HOOK_FILE_RE = /\.(kiro\.hook|json)$/i;
/**
 * The nine trigger kinds (requirement 12.4), verified against the Kiro IDE's
 * trigger enum (the Kiro IDE feature-map notes §4 (kept outside the package), enum @1561482; the IDE
 * also knows `preTaskExecution`/`postTaskExecution`, which the spec leaves out).
 * Note kiro-cli 3.1.0's own agent-config hooks use a different vocabulary
 * (`agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`,
 * `chat_cli::cli::agent::hook::HookTrigger`); these are hook *files*, not that.
 */
const HOOK_TRIGGERS = ["fileEdited", "fileCreated", "fileDeleted", "userTriggered", "promptSubmit", "agentStop", "preToolUse", "postToolUse", "sessionStart"];
/** Triggers that take a matcher: a file glob for the file triggers, a tool name for the tool ones. */
const HOOK_MATCHER_TRIGGERS = ["fileEdited", "fileCreated", "fileDeleted", "preToolUse", "postToolUse"];
/** Action kinds the view understands (`command` is read as an alias of `runCommand`). */
const HOOK_ACTION_KINDS = ["askAgent", "runCommand"];
const HOOK_ACTION_ALIASES = { command: "runCommand" };

/** The hook's name when the file has none: its base name without the hook extension. */
function hookNameFromPath(path) {
  return String(path || "").split("/").pop().replace(HOOK_FILE_RE, "") || "hook";
}

/**
 * The hook a file describes, tolerant of either shape: `valid: false` with the
 * `error` naming the first problem (not JSON, not an object, missing or unknown
 * trigger, missing or unknown action, action without its text). `enabled`
 * defaults to true. `patterns` is the matcher list (`matcher` or `when.patterns`),
 * `actionText` the prompt or command, so Run (12.3) and the wizard (12.4) reuse it.
 */
function parseHookFile(text, path) {
  const hook = { name: hookNameFromPath(path), description: "", trigger: "", patterns: [], actionKind: "", actionText: "", enabled: true, valid: false };
  let data;
  try { data = JSON.parse(String(text)); } catch (error) { return { ...hook, error: "not valid JSON: " + (error && error.message ? error.message : String(error)) }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ...hook, error: "not a JSON object" };
  if (typeof data.name === "string" && data.name.trim()) hook.name = data.name.trim();
  if (typeof data.description === "string") hook.description = data.description.trim();
  hook.enabled = data.enabled !== false;
  const when = data.when && typeof data.when === "object" && !Array.isArray(data.when) ? data.when : null;
  if (typeof data.trigger === "string") {
    hook.trigger = data.trigger;
    if (typeof data.matcher === "string" && data.matcher) hook.patterns = [data.matcher];
    else if (Array.isArray(data.matcher)) hook.patterns = data.matcher.filter((p) => typeof p === "string" && p);
  } else if (when) {
    if (typeof when.type === "string") hook.trigger = when.type;
    if (Array.isArray(when.patterns)) hook.patterns = when.patterns.filter((p) => typeof p === "string" && p);
  }
  const action = [data.action, data.then].find((a) => a && typeof a === "object" && !Array.isArray(a)) || null;
  if (action && typeof action.type === "string") hook.actionKind = HOOK_ACTION_ALIASES[action.type] || action.type;
  if (hook.actionKind === "askAgent" && typeof action.prompt === "string") hook.actionText = action.prompt;
  if (hook.actionKind === "runCommand" && typeof action.command === "string") hook.actionText = action.command;
  if (!hook.trigger) return { ...hook, error: "missing trigger (`trigger` or `when.type`)" };
  if (!HOOK_TRIGGERS.includes(hook.trigger)) return { ...hook, error: "unknown trigger \"" + hook.trigger + "\"" };
  if (!action) return { ...hook, error: "missing action (`action` or `then`)" };
  if (!hook.actionKind) return { ...hook, error: "action has no `type`" };
  if (!HOOK_ACTION_KINDS.includes(hook.actionKind)) return { ...hook, error: "unknown action type \"" + hook.actionKind + "\"" };
  if (!hook.actionText.trim()) return { ...hook, error: hook.actionKind === "askAgent" ? "askAgent action needs a `prompt`" : "runCommand action needs a `command`" };
  hook.valid = true;
  return hook;
}

/** The row's label: the hook's name. */
function hookRowLabel(hook) { return hook.name; }
/** The row's description: `<trigger> → <action kind>` for a valid hook, the problem otherwise. */
function hookRowDescription(hook) {
  if (!hook.valid) return "invalid · " + (hook.error || "unknown problem");
  return hook.trigger + " → " + hook.actionKind;
}
/** Codicon per state: filled dot on, hollow dot off, warning when the file does not describe a hook. */
function hookRowIcon(hook) { return !hook.valid ? "warning" : hook.enabled ? "circle-filled" : "circle-outline"; }
/**
 * `hook-on` / `hook-off` / `hook-invalid`, with `-manual` appended on a valid
 * `userTriggered` hook (`hook-on-manual`): what the row's inline actions are
 * gated on — Enable/Disable/Toggle match `/^hook-(on|off)/`, Run only
 * `hook-on-manual` (requirement 12.3: the user runs a `userTriggered` hook by hand).
 */
function hookContextValue(hook) {
  if (!hook.valid) return "hook-invalid";
  return (hook.enabled ? "hook-on" : "hook-off") + (hook.trigger === "userTriggered" ? "-manual" : "");
}
/** The row's tooltip: the file's path, the hook's description and (when invalid) the problem. */
function hookRowTooltip(hook, path) {
  const lines = [path];
  if (hook.description) lines.push(hook.description);
  if (hook.valid) lines.push(hook.trigger + (hook.patterns.length ? " (" + hook.patterns.join(", ") + ")" : "") + " → " + hook.actionKind + (hook.enabled ? "" : " · disabled"));
  else lines.push("Not a valid hook: " + (hook.error || "unknown problem"));
  return lines.join("\n");
}

/**
 * The file's text with `enabled` flipped (or set to `enabled` when given) and
 * everything else kept: same keys in the same order, 2-space indent, the
 * trailing newline kept when the file had one. Throws when the text is not a
 * JSON object, so a broken file is never overwritten.
 */
function toggleHookEnabled(text, enabled) {
  const source = String(text);
  const data = JSON.parse(source);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a JSON object");
  data.enabled = typeof enabled === "boolean" ? enabled : !(data.enabled !== false);
  return JSON.stringify(data, null, 2) + (/\n$/.test(source) ? "\n" : "");
}

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
    if (kind === "steering") {
      this._emptyKey = undefined; // the last value of STEERING_EMPTY_CONTEXT_KEY applied
      context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
      this.updateEmptyKey().catch(() => undefined);
    }
  }
  refresh() {
    if (this.kind === "steering") { invalidateSteeringCache(); this.updateEmptyKey().catch(() => undefined); }
    this._change.fire();
  }
  /**
   * The Steering view's `kirocrew.steering.empty` context key (requirement
   * 11.1): true while no workspace folder has a steering `.md`, so the welcome
   * content offers "Generate steering docs". Set only when the value changes.
   */
  async updateEmptyKey() {
    if (this.kind !== "steering") return;
    const folders = vscode.workspace.workspaceFolders || [];
    const empty = folders.length ? steeringIsEmpty(await listSteering(folders[0].uri.path)) : false;
    if (this._emptyKey === empty) return;
    this._emptyKey = empty;
    void vscode.commands.executeCommand("setContext", STEERING_EMPTY_CONTEXT_KEY, empty);
  }
  roots() {
    const out = [];
    for (const folder of vscode.workspace.workspaceFolders || []) out.push({ label: "Workspace", uri: vscode.Uri.joinPath(folder.uri, ".kiro", this.spec.dir), scope: "workspace" });
    const home = homeUri();
    if (home) out.push({ label: "Global (~/.kiro)", uri: vscode.Uri.joinPath(home, ".kiro", this.spec.dir), scope: "global" });
    return out;
  }
  /**
   * The rows under a directory node. Every row carries `parent` (for
   * `getParent`, which `TreeView.reveal` needs) and a stable `id` (the path),
   * so a freshly built row for the same entry resolves to the same tree node.
   */
  async listDir(uri, depth, parent) {
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
        item.id = this.kind + ":" + child.path;
        item.iconPath = new vscode.ThemeIcon(ok ? "tools" : "warning");
        item.description = ok ? "" : "no SKILL.md";
        item.contextValue = "asset";
        item.parent = parent;
        item.command = { command: "kirocrew.openFile", title: "Open", arguments: [ok ? skill : child] };
        items.push(item);
        continue;
      }
      if (kind === vscode.FileType.Directory && depth < STEERING_MAX_DEPTH) {
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = this.kind + ":" + child.path;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = "asset-dir";
        item.dirUri = child;
        item.depth = depth + 1;
        item.parent = parent;
        items.push(item);
      } else if (this.spec.leaf(name, kind) && kind === vscode.FileType.File) {
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
        item.id = this.kind + ":" + child.path;
        item.iconPath = new vscode.ThemeIcon(this.spec.icon);
        item.contextValue = "asset";
        item.parent = parent;
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
      // No steering anywhere: an empty tree, so the view's welcome content ("Generate
      // steering docs", requirement 11.1) renders in place of two empty roots.
      if (this.kind === "steering" && !(await listSteering(roots[0].uri.path)).length) return [];
      const out = [];
      for (const root of roots) {
        const item = new vscode.TreeItem(root.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = this.kind + ":" + root.uri.path;
        item.description = root.uri.path.replace(/^\/local(\/home)/, "$1");
        item.iconPath = new vscode.ThemeIcon(root.scope === "workspace" ? "root-folder" : "home");
        item.contextValue = "asset-root-" + root.scope;
        item.dirUri = root.uri;
        item.depth = 0;
        item.scope = root.scope;
        out.push(item);
      }
      return out;
    }
    if (node.dirUri) {
      const items = await this.listDir(node.dirUri, node.depth || 0, node);
      if (!items.length && node.depth === 0) {
        const empty = new vscode.TreeItem("none yet — " + this.spec.desc);
        empty.iconPath = new vscode.ThemeIcon("info");
        empty.parent = node;
        return [empty];
      }
      return items;
    }
    return [];
  }
  getTreeItem(item) { return item; }
  /** The row's directory node (a root for the top level, undefined for a root): what `TreeView.reveal` walks. */
  getParent(item) { return item && item.parent ? item.parent : undefined; }
  /**
   * The row for `<scope root>/<name>` after a fresh read, or null: the root
   * whose directory is `rootUri` (any root of that scope when no Uri is given),
   * then its child named `name`. Used to reveal a just-imported skill.
   */
  async findRow(scope, name, rootUri) {
    const roots = await this.getChildren();
    const root = (roots || []).find((r) => r.dirUri && (rootUri ? r.dirUri.path === rootUri.path : r.scope === scope));
    if (!root) return null;
    const rows = await this.getChildren(root);
    return (rows || []).find((r) => r.label === name && r.id) || null;
  }
}

/**
 * The Agent Hooks view (requirement 12.1): AssetTree's two tiers, with each
 * hook file read and parsed into a row — label the hook's name, description
 * `<trigger> → <action kind>`, a filled or hollow dot for on/off (a warning
 * when the file is not a hook), the path and description in the tooltip. The
 * row carries `hookUri` and `hook` for the Toggle (12.2) and Run (12.3) actions.
 * Besides the workspace watcher the base class sets up, the global
 * `~/.kiro/hooks/` is watched too.
 */
class HooksTree extends AssetTree {
  constructor(context) {
    super(context, "hooks");
    const home = homeUri();
    if (home) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(home, ".kiro", "hooks"), "*"));
      context.subscriptions.push(watcher, watcher.onDidChange(() => this.refresh()), watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()));
    }
  }
  /** The hook row for one file: parsed from its text (an unreadable file is an invalid row). */
  async hookRow(uri, parent) {
    let hook;
    try { hook = parseHookFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), uri.path); } catch (error) { hook = { ...parseHookFile("", uri.path), error: "cannot read file: " + (error && error.message ? error.message : String(error)) }; }
    const item = new vscode.TreeItem(hookRowLabel(hook), vscode.TreeItemCollapsibleState.None);
    item.id = this.kind + ":" + uri.path;
    item.description = hookRowDescription(hook);
    item.iconPath = new vscode.ThemeIcon(hookRowIcon(hook));
    item.contextValue = hookContextValue(hook);
    item.tooltip = hookRowTooltip(hook, uri.path.replace(/^\/local(\/home)/, "$1"));
    item.resourceUri = uri;
    item.hookUri = uri;
    item.hook = hook;
    item.parent = parent;
    item.command = { command: "kirocrew.openFile", title: "Open", arguments: [uri] };
    return item;
  }
  async listDir(uri, depth, parent) {
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(uri); } catch { return []; }
    const files = entries.filter(([name, kind]) => !name.startsWith(".") && kind === vscode.FileType.File && HOOK_FILE_RE.test(name)).sort((a, b) => a[0].localeCompare(b[0]));
    return Promise.all(files.map(([name]) => this.hookRow(vscode.Uri.joinPath(uri, name), parent)));
  }
  /** Whether a tier holds at least one hook file (the welcome content shows while none does). */
  async hasHooks(uri) {
    try { return (await vscode.workspace.fs.readDirectory(uri)).some(([name, kind]) => !name.startsWith(".") && kind === vscode.FileType.File && HOOK_FILE_RE.test(name)); } catch { return false; }
  }
  /**
   * The top level: an empty tree while no tier has a hook file, so the view's
   * welcome content (the kiro-cli note, the documentation link and "Create a
   * hook", requirements 12.4–12.5) renders in place of two empty roots.
   */
  async getChildren(node) {
    if (!node) {
      const roots = this.roots();
      if (roots.length) {
        const found = await Promise.all(roots.map((r) => this.hasHooks(r.uri)));
        if (!found.some(Boolean)) return [];
      }
    }
    return super.getChildren(node);
  }
}

/**
 * The Toggle row action (requirement 12.2): flips `enabled` in the hook's file
 * (or sets it to `enabled` when the Enable/Disable inline action says which),
 * keeping the rest of the document, then refreshes the view (the watcher would
 * too; this makes the dot change at once). A file that no longer parses is left
 * alone and the error shown.
 */
async function toggleHook(tree, item, enabled) {
  const uri = item && (item.hookUri || item.resourceUri);
  if (!uri) return vscode.window.showErrorMessage("Pick a hook in the Agent Hooks view to toggle it.");
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(toggleHookEnabled(text, enabled)));
  } catch (error) {
    return vscode.window.showErrorMessage("Cannot toggle " + uri.path.split("/").pop() + ": " + (error && error.message ? error.message : String(error)));
  }
  if (tree) tree.refresh();
}

// ---- Run (requirement 12.3): the user runs a `userTriggered` hook by hand —
// an `askAgent` hook sends its prompt through the Send_Path, a `runCommand`
// hook runs its command in a terminal once the user has confirmed it.

/** The Run row action's command id. */
const HOOK_RUN_COMMAND = "kirocrew.hooks.run";
/** The transcript bubble for an `askAgent` hook's turn, in place of its prompt. */
function hookRunDisplay(hook) { return "Run hook: " + hook.name; }
/** The modal's question before a `runCommand` hook's command is sent to a terminal. */
const HOOK_RUN_CONFIRM = "Run the hook command in a terminal?";
/** The modal's confirming button. */
const HOOK_RUN_BUTTON = "Run";
/** The terminal a hook's command runs in, one per hook name. */
function hookTerminalName(hook) { return "KiroCrew hook: " + hook.name; }

/**
 * Whether a hook can be run by hand, pure: `{ok: true, kind}` with the action
 * kind for a valid, enabled `userTriggered` hook; `{ok: false, reason}` with
 * the sentence to show otherwise.
 */
function hookRunDecision(hook) {
  if (!hook || typeof hook !== "object") return { ok: false, reason: "Pick a hook in the Agent Hooks view to run it." };
  if (!hook.valid) return { ok: false, reason: "\"" + hook.name + "\" is not a valid hook" + (hook.error ? ": " + hook.error : "") + "." };
  if (hook.trigger !== "userTriggered") return { ok: false, reason: "\"" + hook.name + "\" fires on " + hook.trigger + "; only userTriggered hooks can be run by hand." };
  if (!hook.enabled) return { ok: false, reason: "\"" + hook.name + "\" is disabled. Enable it to run it." };
  return { ok: true, kind: hook.actionKind };
}

/**
 * The live terminal per hook name (`hookTerminalName`), reused while it is
 * open and dropped when the user closes it (`onDidCloseTerminal`, wired once
 * from `runHook`).
 */
const hookTerminals = new Map();
let hookTerminalWatcher = null;

/** The hook's terminal: the still-open one for its name, else a new one in `cwd`. */
function hookTerminal(hook, cwd) {
  const name = hookTerminalName(hook);
  const live = hookTerminals.get(name);
  if (live && !(live.exitStatus)) return live;
  if (!hookTerminalWatcher) hookTerminalWatcher = vscode.window.onDidCloseTerminal((t) => { for (const [k, v] of hookTerminals) if (v === t) hookTerminals.delete(k); });
  const terminal = vscode.window.createTerminal({ name, cwd: cwd || undefined });
  hookTerminals.set(name, terminal);
  return terminal;
}

/**
 * The Run row action (requirement 12.3). Refuses, with an information message,
 * a hook that is invalid, disabled or not `userTriggered`. An `askAgent` hook
 * sends its prompt through `chat.sendWithContexts` (chat revealed, idle tab,
 * no context chips) with the bubble "Run hook: <name>"; a `runCommand` hook
 * shows its command in a modal and, on "Run", sends it to a terminal named
 * after the hook (reused while open), opened in the hook's workspace folder
 * when the file is workspace-scoped. Returns the session key for `askAgent`,
 * the terminal for `runCommand`, undefined when nothing ran.
 */
async function runHook(chat, item) {
  const hook = item && item.hook;
  const decision = hookRunDecision(hook);
  if (!decision.ok) { vscode.window.showInformationMessage(decision.reason); return undefined; }
  if (decision.kind === "askAgent") return chat.sendWithContexts(hook.actionText, [], { displayText: hookRunDisplay(hook) });
  const choice = await vscode.window.showWarningMessage(HOOK_RUN_CONFIRM, { modal: true, detail: hook.actionText }, HOOK_RUN_BUTTON);
  if (choice !== HOOK_RUN_BUTTON) return undefined;
  const uri = item.hookUri || item.resourceUri;
  const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  const terminal = hookTerminal(hook, folder ? folder.uri : undefined);
  terminal.show();
  terminal.sendText(hook.actionText);
  return terminal;
}

/**
 * The legacy `.kiro.hook` document (`when`/`then`), kept for callers that want
 * a ready-made example; the ＋ wizard writes the design's `HookFile` shape
 * through `buildHookFile` instead.
 */
const HOOK_TEMPLATE = (name) => JSON.stringify({
  enabled: true,
  name,
  description: "Describe when this hook fires and what the agent should do.",
  version: "1",
  when: { type: "fileEdited", patterns: ["src/**/*.py"] },
  then: { type: "askAgent", prompt: "A source file was saved. Review the change and update the matching tests if needed." },
}, null, 2) + "\n";

// ---- ＋ wizard (requirement 12.4): name, trigger, matcher where the trigger
// takes one, action kind and its text, written as the design's `HookFile`.
// The view's message (12.5) says who runs the result: kiro-cli, not us.

/** One-line meaning per trigger, the quick pick's `description` column. */
const HOOK_TRIGGER_DESCRIPTIONS = {
  fileEdited: "a matching file is saved",
  fileCreated: "a matching file is created",
  fileDeleted: "a matching file is deleted",
  userTriggered: "the user runs the hook by hand (Run action)",
  promptSubmit: "the user submits a prompt, before the agent sees it",
  agentStop: "the agent finishes its turn",
  preToolUse: "the agent is about to run a matching tool",
  postToolUse: "the agent has run a matching tool",
  sessionStart: "a session starts",
};
/** The file triggers (`fileEdited`, `fileCreated`, `fileDeleted`): their matcher is a file glob, defaulting to everything. */
const HOOK_FILE_TRIGGERS = ["fileEdited", "fileCreated", "fileDeleted"];
const HOOK_DEFAULT_FILE_MATCHER = "**/*";
/** The extension the wizard writes (the legacy name Kiro also reads `.json` under; HOOK_FILE_RE lists both). */
const HOOK_FILE_EXT = ".kiro.hook";
/** Where hooks are documented, linked from the view's message and welcome content. */
const HOOK_DOCS_URL = "https://kiro.dev/docs/hooks/";
/** The Agent Hooks view's standing message (requirement 12.5), markdown with the documentation link. */
const HOOK_VIEW_MESSAGE = "Hooks are executed by kiro-cli, not by this extension. [Documentation](" + HOOK_DOCS_URL + ")";
/** The same note as plain text, for a host whose `TreeView.message` renders strings only. */
const HOOK_VIEW_MESSAGE_PLAIN = "Hooks are executed by kiro-cli, not by this extension. Documentation: " + HOOK_DOCS_URL;
/** The "Documentation" title-bar action's command id: opens HOOK_DOCS_URL in the browser. */
const HOOK_DOCS_COMMAND = "kirocrew.hooks.docs";

/**
 * Sets the Agent Hooks view's message (requirement 12.5): the markdown form
 * with its link where the host accepts a `MarkdownString` message
 * (`treeViewMarkdownMessage` is still a proposed API in VS Code 1.109, whose
 * setter throws for an extension that has not enabled it), else the plain
 * sentence with the URL spelled out. Returns which form took: "markdown" or "plain".
 */
function setHookViewMessage(treeView) {
  if (!treeView) return "plain";
  try {
    const md = new vscode.MarkdownString(HOOK_VIEW_MESSAGE);
    md.isTrusted = true;
    treeView.message = md;
    return "markdown";
  } catch {
    treeView.message = HOOK_VIEW_MESSAGE_PLAIN;
    return "plain";
  }
}

/**
 * Pure: the design's `HookFile` for the wizard's answers —
 * `{name, description?, trigger, matcher?, action: {type: "askAgent", prompt} |
 * {type: "runCommand", command}, enabled}` — or throws naming the first problem:
 * empty name, unknown trigger, action kind not in HOOK_ACTION_KINDS, empty
 * action text. `matcher` is kept only for a trigger in HOOK_MATCHER_TRIGGERS
 * (anything else is dropped, not an error); a file trigger with no matcher gets
 * `**\/*`. Strings are trimmed; `enabled` defaults to true; `description` is
 * written only when given.
 */
function buildHookFile(input) {
  const o = input && typeof input === "object" ? input : {};
  const name = String(o.name || "").trim();
  if (!name) throw new Error("a hook needs a name");
  const trigger = String(o.trigger || "").trim();
  if (!HOOK_TRIGGERS.includes(trigger)) throw new Error("unknown trigger \"" + trigger + "\"; one of " + HOOK_TRIGGERS.join(", "));
  const actionKind = HOOK_ACTION_ALIASES[o.actionKind] || String(o.actionKind || "").trim();
  if (!HOOK_ACTION_KINDS.includes(actionKind)) throw new Error("unknown action kind \"" + actionKind + "\"; one of " + HOOK_ACTION_KINDS.join(", "));
  const actionText = String(o.actionText || "").trim();
  if (!actionText) throw new Error(actionKind === "askAgent" ? "an askAgent hook needs its prompt" : "a runCommand hook needs its command");
  const hook = { name };
  const description = String(o.description || "").trim();
  if (description) hook.description = description;
  hook.trigger = trigger;
  if (HOOK_MATCHER_TRIGGERS.includes(trigger)) {
    const matcher = String(o.matcher || "").trim() || (HOOK_FILE_TRIGGERS.includes(trigger) ? HOOK_DEFAULT_FILE_MATCHER : "");
    if (matcher) hook.matcher = matcher;
  }
  hook.action = actionKind === "askAgent" ? { type: "askAgent", prompt: actionText } : { type: "runCommand", command: actionText };
  hook.enabled = o.enabled !== false;
  return hook;
}

/** Pure: the hook file's text — 2-space JSON with a trailing newline (what `toggleHookEnabled` keeps). */
function serializeHookFile(hook) { return JSON.stringify(hook, null, 2) + "\n"; }

/**
 * Pure: the file name for a hook name — lower-cased, anything but letters,
 * digits, `_` and `-` folded to one dash, edge dashes dropped (`hook` when
 * nothing is left), then `.kiro.hook`. "Lint on save" → `lint-on-save.kiro.hook`.
 */
function hookFileName(name) {
  const stem = String(name || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return (stem || "hook") + HOOK_FILE_EXT;
}

/** The scopes a hook can be written into: one per workspace folder, then `~/.kiro/hooks`. */
function hookScopePicks(folders, home) {
  const out = [];
  for (const folder of folders || []) out.push({ label: "$(root-folder) Workspace", description: folder.uri.path, scope: "workspace", uri: vscode.Uri.joinPath(folder.uri, ".kiro", ASSET_KINDS.hooks.dir) });
  if (home) out.push({ label: "$(home) Global", description: "~/.kiro/" + ASSET_KINDS.hooks.dir, scope: "global", uri: vscode.Uri.joinPath(home, ".kiro", ASSET_KINDS.hooks.dir) });
  return out;
}

/**
 * The ＋ wizard (requirement 12.4). Steps, each cancellable: scope (skipped
 * when there is one), name (live-validated: non-empty, and `hookFileName(name)`
 * not already in the scope), trigger (the nine, each with its one-line
 * meaning), matcher only for a trigger that takes one (file glob prefilled
 * `**\/*` for the file triggers, a tool-name glob hint for pre/postToolUse),
 * action kind, action text. The file is `buildHookFile` serialized, written
 * through `workspace.fs`; the view refreshes, the row is revealed and the file
 * opened. Returns `{uri, hook}` or null when the user backed out. `opts`
 * (tests) may give `folders` and `home`.
 */
async function createHookWizard(tree, treeView, opts) {
  const o = opts || {};
  const folders = o.folders || vscode.workspace.workspaceFolders || [];
  const home = o.home !== undefined ? o.home : homeUri();
  const picks = hookScopePicks(folders, home);
  if (!picks.length) { vscode.window.showErrorMessage("Open a folder first: hooks live in its .kiro/hooks/ or your ~/.kiro/hooks/."); return null; }
  const title = "New agent hook";
  let scope = picks[0];
  if (picks.length > 1) {
    scope = await vscode.window.showQuickPick(picks, { title, placeHolder: "Write the hook for this workspace or for every workspace (global)?" });
    if (!scope) return null;
  }
  let existing = [];
  try { existing = (await vscode.workspace.fs.readDirectory(scope.uri)).map(([n]) => n.toLowerCase()); } catch { /* no hooks dir yet */ }
  const name = await vscode.window.showInputBox({
    title,
    prompt: "Hook name",
    placeHolder: "Lint on save",
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!String(v || "").trim()) return "Give the hook a name.";
      if (existing.includes(hookFileName(v))) return hookFileName(v) + " already exists in " + scope.description;
      return null;
    },
  });
  if (!name || !name.trim()) return null;
  const triggerPick = await vscode.window.showQuickPick(
    HOOK_TRIGGERS.map((t) => ({ label: t, description: HOOK_TRIGGER_DESCRIPTIONS[t], trigger: t })),
    { title, placeHolder: "When does the hook fire?" },
  );
  if (!triggerPick) return null;
  const trigger = triggerPick.trigger;
  let matcher;
  if (HOOK_MATCHER_TRIGGERS.includes(trigger)) {
    const isFile = HOOK_FILE_TRIGGERS.includes(trigger);
    matcher = await vscode.window.showInputBox({
      title,
      prompt: isFile ? "File pattern the hook watches (glob, relative to the workspace)" : "Tool name the hook matches (a glob; `*` for every tool)",
      value: isFile ? HOOK_DEFAULT_FILE_MATCHER : "",
      placeHolder: isFile ? "src/**/*.ts" : "write_file or execute_bash or *",
      ignoreFocusOut: true,
      validateInput: (v) => (isFile || String(v || "").trim() ? null : "Name the tool (or `*` for every tool)."),
    });
    if (matcher === undefined) return null;
  }
  const kindPick = await vscode.window.showQuickPick([
    { label: "askAgent", description: "send a prompt to the agent", actionKind: "askAgent" },
    { label: "runCommand", description: "run a shell command", actionKind: "runCommand" },
  ], { title, placeHolder: "What does the hook do?" });
  if (!kindPick) return null;
  const actionKind = kindPick.actionKind;
  const actionText = await vscode.window.showInputBox({
    title,
    prompt: actionKind === "askAgent" ? "Prompt for the agent (one line here; edit the file for a longer one)" : "Shell command to run",
    placeHolder: actionKind === "askAgent" ? "A source file was saved. Review the change and update the matching tests." : "npm run lint",
    ignoreFocusOut: true,
    validateInput: (v) => (String(v || "").trim() ? null : (actionKind === "askAgent" ? "Give the agent its prompt." : "Give the command to run.")),
  });
  if (!actionText || !actionText.trim()) return null;
  let hook;
  try { hook = buildHookFile({ name, trigger, matcher, actionKind, actionText }); } catch (error) { vscode.window.showErrorMessage("KiroCrew: " + (error && error.message ? error.message : String(error)) + "."); return null; }
  const file = vscode.Uri.joinPath(scope.uri, hookFileName(name));
  try {
    await vscode.workspace.fs.createDirectory(scope.uri);
    if (await uriExists(file)) { vscode.window.showWarningMessage(file.path + " already exists."); return null; }
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(serializeHookFile(hook)));
  } catch (error) {
    vscode.window.showErrorMessage("Cannot write " + file.path + ": " + (error && error.message ? error.message : String(error)));
    return null;
  }
  if (tree && typeof tree.refresh === "function") tree.refresh();
  let revealed = false;
  if (tree && treeView && typeof treeView.reveal === "function" && typeof tree.findRow === "function") {
    try {
      const row = await tree.findRow(scope.scope, hook.name, scope.uri);
      if (row) { await treeView.reveal(row, { select: true, focus: true, expand: false }); revealed = true; }
    } catch { /* the view shows it on the next refresh */ }
  }
  try {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: revealed });
  } catch { /* the file is there; the view shows it */ }
  return { uri: file, hook, scope: scope.scope, revealed };
}

// ---- MCP servers (spec task 16.1, a deferred nicety with no requirement): a
// read-only list of the servers kiro-cli reads from the workspace's
// `.kiro/settings/mcp.json` and the user's `~/.kiro/settings/mcp.json`.
// kiro-cli owns MCP (design.md "Out of scope"), so the view lists and opens
// the files and nothing more: no enable/disable, no edit, no connect.
//
// The file's shape (checked against a real ~/.kiro/settings/mcp.json):
//   { "mcpServers": { "<name>": { command, args?, env?, url?, disabled?, autoApprove?, timeout? } } }
// A missing `disabled` means enabled. `env` is never read into a row: it holds
// tokens, and the view shows only what names and routes a server.

/** The config file's name under each tier's `.kiro/settings/`. */
const MCP_CONFIG_FILE = "mcp.json";
/** The welcome content's documentation link (resolves with 200 as of this task). */
const MCP_DOCS_URL = "https://kiro.dev/docs/mcp/";
/** The title-bar "Open config file" command id: the workspace file, or an information message when it is absent. */
const MCP_OPEN_CONFIG_COMMAND = "kirocrew.mcp.openConfig";
/** The message when the workspace has no `.kiro/settings/mcp.json` (nothing is created). */
const MCP_CONFIG_ABSENT_MESSAGE = "No .kiro/settings/mcp.json in this workspace. kiro-cli reads MCP servers from it and from ~/.kiro/settings/mcp.json; this view is read-only.";

/**
 * The servers an mcp.json describes: `{ servers, error? }`. Text that is not a
 * JSON object, or whose `mcpServers` is not an object, yields no servers and
 * an `error`; a missing `mcpServers` is an empty list. Each server carries
 * `name`, `transport` (`http` when it has a `url` and no `command`, else
 * `stdio`), `command` / `url` when present, `disabled` (true only when the
 * file says so), `autoApproveCount` and `timeout` when numeric. `env` and
 * `args` are left out on purpose.
 */
function parseMcpConfig(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch (error) { return { servers: [], error: "not valid JSON: " + (error && error.message ? error.message : String(error)) }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { servers: [], error: "not a JSON object" };
  const table = data.mcpServers;
  if (table === undefined || table === null) return { servers: [] };
  if (typeof table !== "object" || Array.isArray(table)) return { servers: [], error: "`mcpServers` is not an object" };
  const servers = [];
  for (const [name, raw] of Object.entries(table)) {
    const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    const server = { name, transport: url && !command ? "http" : "stdio", disabled: entry.disabled === true, autoApproveCount: Array.isArray(entry.autoApprove) ? entry.autoApprove.length : 0 };
    if (command) server.command = command;
    if (url) server.url = url;
    if (typeof entry.timeout === "number" && Number.isFinite(entry.timeout)) server.timeout = entry.timeout;
    servers.push(server);
  }
  return { servers };
}

/** The host of an http server's URL (the whole string when it does not parse as a URL). */
function mcpUrlHost(url) {
  try { return new URL(url).host || url; } catch { return url; }
}
/** The row's description: `stdio · <command>` or `http · <host>`, with ` · disabled` appended when the file disables the server. */
function mcpRowDescription(server) {
  const route = server.transport === "http" ? mcpUrlHost(server.url || "") : (server.command || "");
  return [server.transport, route].filter(Boolean).join(" · ") + (server.disabled ? " · disabled" : "");
}
/** Codicon per state: `server` on, `server-environment` (dimmed by the tree) disabled, `warning` for the row that stands in for a file that does not parse. */
function mcpRowIcon(server) {
  if (!server || server.error) return "warning";
  return server.disabled ? "server-environment" : "server";
}
/** The row's tooltip: the file's path, the route, the auto-approve count and timeout when set, and whether the server is disabled. */
function mcpRowTooltip(server, path) {
  const lines = [path, server.transport === "http" ? "http · " + (server.url || "") : "stdio · " + (server.command || "(no command)")];
  if (server.autoApproveCount) lines.push(server.autoApproveCount + " auto-approved tool" + (server.autoApproveCount === 1 ? "" : "s"));
  if (typeof server.timeout === "number") lines.push("timeout " + server.timeout);
  if (server.disabled) lines.push("disabled");
  return lines.join("\n");
}
/**
 * The 0-based line where `"<name>":` first appears as a key, or -1: cheap
 * enough to run per row, and right for every mcp.json written one key per
 * line (the shape kiro-cli and the IDE write).
 */
function mcpServerLine(text, name) {
  const key = JSON.stringify(String(name));
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith(key) && /^\s*:/.test(trimmed.slice(key.length))) return i;
  }
  return -1;
}

/**
 * The MCP Servers view: AssetTree's two tiers, each resolving to its
 * `settings/mcp.json`, with one row per server (label the server's name,
 * description its route, a dimmed icon when disabled) and a single warning
 * row for a file that does not parse. A row opens the file at the server's
 * key. Besides the workspace watcher the base class sets up, the global
 * `~/.kiro/settings/` is watched too. Read-only by design.
 */
class McpServersTree extends AssetTree {
  constructor(context) {
    super(context, "mcp");
    const home = homeUri();
    if (home) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(home, ".kiro", ASSET_KINDS.mcp.dir), MCP_CONFIG_FILE));
      context.subscriptions.push(watcher, watcher.onDidChange(() => this.refresh()), watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()));
    }
  }
  /** The tier's config file. */
  configUri(dirUri) { return vscode.Uri.joinPath(dirUri, MCP_CONFIG_FILE); }
  /** Whether a tier has a config file at all (the welcome content shows while neither does). */
  async hasConfig(dirUri) {
    try { await vscode.workspace.fs.stat(this.configUri(dirUri)); return true; } catch { return false; }
  }
  /** The row for one server; clicking it opens the file at the server's key (or just the file when the key is not found). */
  serverRow(file, text, server, parent) {
    const item = new vscode.TreeItem(server.name, vscode.TreeItemCollapsibleState.None);
    item.id = this.kind + ":" + file.path + "#" + server.name;
    item.description = mcpRowDescription(server);
    item.iconPath = server.disabled ? new vscode.ThemeIcon(mcpRowIcon(server), new vscode.ThemeColor("disabledForeground")) : new vscode.ThemeIcon(mcpRowIcon(server));
    item.contextValue = "mcp-server";
    item.tooltip = mcpRowTooltip(server, file.path.replace(/^\/local(\/home)/, "$1"));
    item.server = server;
    item.parent = parent;
    const line = mcpServerLine(text, server.name);
    item.command = { command: MCP_OPEN_CONFIG_COMMAND, title: "Open config file", arguments: line >= 0 ? [file, line] : [file] };
    return item;
  }
  /** The one row shown for a file that does not parse: the problem, opening the file on click. */
  warningRow(file, error, parent) {
    const item = new vscode.TreeItem(MCP_CONFIG_FILE, vscode.TreeItemCollapsibleState.None);
    item.id = this.kind + ":" + file.path + "#!";
    item.description = "invalid · " + error;
    item.iconPath = new vscode.ThemeIcon(mcpRowIcon({ error }));
    item.contextValue = "mcp-invalid";
    item.tooltip = file.path.replace(/^\/local(\/home)/, "$1") + "\nNot a valid MCP config: " + error;
    item.parent = parent;
    item.command = { command: MCP_OPEN_CONFIG_COMMAND, title: "Open config file", arguments: [file] };
    return item;
  }
  /** The tier's rows: its servers in file order, a warning row for a file that does not parse, nothing when the file is absent. */
  async listDir(uri, depth, parent) {
    const file = this.configUri(uri);
    let text;
    try { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file)); } catch { return []; }
    const parsed = parseMcpConfig(text);
    if (parsed.error) return [this.warningRow(file, parsed.error, parent)];
    return parsed.servers.map((server) => this.serverRow(file, text, server, parent));
  }
  /**
   * The top level: an empty tree while neither tier has a config file, so the
   * view's welcome content renders in place of two empty roots; otherwise the
   * roots, each described by its config file's path.
   */
  async getChildren(node) {
    if (!node) {
      const roots = this.roots();
      if (roots.length) {
        const found = await Promise.all(roots.map((r) => this.hasConfig(r.uri)));
        if (!found.some(Boolean)) return [];
      }
      const items = await super.getChildren(node);
      for (const item of items || []) if (item.dirUri) item.description = this.configUri(item.dirUri).path.replace(/^\/local(\/home)/, "$1");
      return items;
    }
    return super.getChildren(node);
  }
}

/**
 * "Open config file": from a row, the given file at the given line; from the
 * title bar (no arguments), the workspace's `.kiro/settings/mcp.json`, or an
 * information message when there is none. Nothing is ever created.
 */
async function openMcpConfig(uri, line) {
  let file = uri && typeof uri.path === "string" ? uri : null;
  if (!file) {
    const folder = (vscode.workspace.workspaceFolders || [])[0];
    if (!folder) return vscode.window.showInformationMessage("Open a folder to see its .kiro/settings/mcp.json.");
    file = vscode.Uri.joinPath(folder.uri, ".kiro", ASSET_KINDS.mcp.dir, MCP_CONFIG_FILE);
    try { await vscode.workspace.fs.stat(file); } catch { return vscode.window.showInformationMessage(MCP_CONFIG_ABSENT_MESSAGE); }
  }
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (typeof line === "number" && line >= 0) {
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

const STEERING_TEMPLATE = (title) => "---\ninclusion: always\n---\n# " + title + "\n\nGuidance the agent follows in every session of this workspace. Keep it short and specific:\n\n- Convention one\n- Convention two\n";
const SKILL_TEMPLATE = (name) => "---\nname: " + name + "\ndescription: One line on when this skill applies (the agent picks skills by this description).\nversion: 1.0.0\n---\n\n# " + name + "\n\nStep-by-step instructions the agent follows when this skill is active.\n";

/** The Steering and Skills ＋: scope, kebab-case name, a template file opened in the editor. Hooks go through `createHookWizard`. */
async function newAsset(kind, scopeFolders) {
  const spec = ASSET_KINDS[kind];
  const roots = [];
  for (const folder of scopeFolders) roots.push({ label: "$(root-folder) Workspace  " + folder.uri.path, uri: vscode.Uri.joinPath(folder.uri, ".kiro", spec.dir) });
  const home = homeUri();
  if (home) roots.push({ label: "$(home) Global  ~/.kiro/" + spec.dir, uri: vscode.Uri.joinPath(home, ".kiro", spec.dir) });
  if (!roots.length) return vscode.window.showErrorMessage("Open a folder first.");
  const where = roots.length === 1 ? roots[0] : await vscode.window.showQuickPick(roots, { placeHolder: "Where should it live?" });
  if (!where) return;
  const name = await vscode.window.showInputBox({ prompt: kind === "skills" ? "Skill name (kebab-case folder)" : "Steering file name (kebab-case)", validateInput: (v) => /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "lowercase letters, digits and dashes" });
  if (!name) return;
  await vscode.workspace.fs.createDirectory(where.uri);
  let file;
  let body;
  if (kind === "skills") {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(where.uri, name));
    file = vscode.Uri.joinPath(where.uri, name, "SKILL.md");
    body = SKILL_TEMPLATE(name);
  } else {
    file = vscode.Uri.joinPath(where.uri, name + ".md");
    body = STEERING_TEMPLATE(name.replace(/-/g, " "));
  }
  try { await vscode.workspace.fs.stat(file); return vscode.window.showWarningMessage(file.path + " already exists."); } catch { /* new */ }
  await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(body));
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ---- "Generate steering docs" (requirement 11.1): the Steering view's welcome
// content when the workspace has no steering yet (and a title-bar action once it
// has). Creates `.kiro/steering/`, then sends our own instruction — not Kiro's
// text — through the Send_Path into the idle tab of the chat, shown in the
// transcript as the short STEERING_GENERATE_DISPLAY.

/** Context key the welcome content is gated on: true while no workspace folder has a steering `.md`. */
const STEERING_EMPTY_CONTEXT_KEY = "kirocrew.steering.empty";
const STEERING_GENERATE_COMMAND = "kirocrew.steering.generate";
const STEERING_GENERATE_DISPLAY = "Generate steering documents";
/** The standard Kiro steering documents the instruction asks for, in the order they are listed. */
const STEERING_GENERATE_FILES = ["product.md", "tech.md", "structure.md"];
const STEERING_GENERATE_PROMPT = [
  "Analyse this workspace — its directory structure, languages, build, test and run commands, and the conventions the code follows — and write the standard Kiro steering documents into `.kiro/steering/`:",
  "",
  "- `product.md`: what the product is, what it does and who it is for.",
  "- `tech.md`: the stack and its versions, how to build, test and run the project, the tools it depends on.",
  "- `structure.md`: the directory layout and where each kind of thing goes (source, tests, configuration, generated files).",
  "",
  "Rules:",
  "- Start every file with a front matter block containing `inclusion: always`.",
  "- Be concise and factual: say only what the files of this workspace show. Do not invent commands, versions, dependencies or conventions you did not find.",
  "- Write for an agent that will read these documents before every session: short sections, concrete paths and commands, no filler.",
  "- Create the directory if it is missing; do not overwrite other files in it.",
  "",
  "When done, list the files you wrote.",
].join("\n");

/** Pure: whether a steering inventory (listSteering's rows) has nothing in the workspace tier — the view's welcome content shows then. */
function steeringIsEmpty(docs) {
  return !(docs || []).some((d) => d && d.scope === "workspace");
}

/** Creates `<folder>/.kiro/steering/` (a no-op when it exists) and returns its Uri. */
async function ensureSteeringDir(folder) {
  const base = folder && folder.uri ? folder.uri : folder;
  const dir = vscode.Uri.joinPath(base, ".kiro", ASSET_KINDS.steering.dir);
  await vscode.workspace.fs.createDirectory(dir);
  return dir;
}

/**
 * The command: pick the workspace folder when there is more than one, make
 * sure its steering directory exists, send STEERING_GENERATE_PROMPT through
 * `chat.sendWithContexts` (chat revealed, idle tab, no context chips) with
 * STEERING_GENERATE_DISPLAY as the transcript's bubble. Returns the session
 * key, or null when nothing was sent (no folder, pick dismissed).
 */
async function generateSteeringDocs(chat, folders) {
  const list = folders || vscode.workspace.workspaceFolders || [];
  if (!list.length) { vscode.window.showErrorMessage("Open a folder first: steering documents are written into its .kiro/steering/."); return null; }
  let folder = list[0];
  if (list.length > 1) {
    const picked = await vscode.window.showQuickPick(list.map((f) => ({ label: "$(root-folder) " + f.name, description: f.uri.path, folder: f })), { placeHolder: "Which workspace folder gets the steering documents?" });
    if (!picked) return null;
    folder = picked.folder;
  }
  const dir = await ensureSteeringDir(folder);
  invalidateSteeringCache();
  const key = await chat.sendWithContexts(STEERING_GENERATE_PROMPT, [], { displayText: STEERING_GENERATE_DISPLAY });
  vscode.window.setStatusBarMessage("KiroCrew: " + STEERING_GENERATE_DISPLAY + " → " + dir.path.replace(/^\/local(\/home)/, "$1"), 5000);
  return key;
}

// ---- "Refine this steering document" (requirement 11.2): the title-bar sparkle
// on a `.kiro/steering/**/*.md` editor (workspace or ~/.kiro tier) and the row
// action in the Steering view. Sends the file as a `#file` context entry — the
// same entry the `#` picker builds — with our own refine instruction, shown in
// the transcript as the short "Refine <name>.md".

const STEERING_REFINE_COMMAND = "kirocrew.steering.refine";
const STEERING_REFINE_PROMPT = [
  "Refine the attached steering document. It is a `.kiro/steering` file an agent reads before working in this workspace, so every statement in it must be true of the workspace as it is now.",
  "",
  "- Check each statement against the current files — paths, commands, versions, dependencies and conventions — and correct or remove anything stale or invented.",
  "- Tighten the wording: short sections, concrete paths and commands, no filler. Keep what is accurate and useful.",
  "- Keep the front matter block and its `inclusion` mode (and `fileMatchPattern` / `description` when present) unless they are plainly wrong.",
  "- Keep the document concise and on its own subject; do not fold other documents into it.",
  "",
  "Write the refined document back to the same file, then summarise what you changed and why in a few lines.",
].join("\n");

// Pure: the file's path (a Uri or a string) is a steering document — `.kiro/steering/**/*.md` in either tier.
function isSteeringDocument(uri) {
  const p = uri && uri.path !== undefined ? uri.path : uri;
  return /[\\/]\.kiro[\\/]steering[\\/].+\.md$/i.test(String(p || ""));
}

/** Pure: the steering name of a document — what follows `.kiro/steering/`, without `.md` (`tech`, `backend/api`). */
function steeringNameOf(uri) {
  const p = String(uri && uri.path !== undefined ? uri.path : uri || "");
  const m = p.match(/[\\/]\.kiro[\\/]steering[\\/](.+)\.md$/i);
  return m ? m[1].replace(/\\/g, "/") : p.replace(/^.*[\\/]/, "").replace(/\.md$/i, "");
}

/** Pure: the transcript bubble, "Refine <name>.md". */
function steeringRefineDisplay(name) {
  return "Refine " + String(name || "steering").replace(/\.md$/i, "") + ".md";
}

/**
 * Pure: the `#file` label of a steering document — relative to its workspace
 * folder (`.kiro/steering/tech.md`), `~/.kiro/steering/<name>.md` for the global
 * tier, the absolute path otherwise. `folders` are workspace folders (or their
 * paths); `home` is the user home's path.
 */
function steeringDocLabel(uriPath, folders, home) {
  const p = String(uriPath || "");
  for (const f of folders || []) {
    const root = f && f.uri ? f.uri.path : f && f.path !== undefined ? f.path : String(f || "");
    if (root && p.startsWith(root + "/")) return p.slice(root.length + 1);
  }
  const globalDir = home ? home + "/.kiro/steering/" : "";
  if (globalDir && p.startsWith(globalDir)) return "~/.kiro/steering/" + p.slice(globalDir.length);
  return p;
}

/**
 * The command: the given document (a Uri from the title bar or the palette, a
 * Steering view row whose command carries the Uri) or the active editor's;
 * anything that is not a steering document is refused with a message. Saves a
 * dirty editor first so the agent refines what the user sees, builds the `#file`
 * entry through `fileContext`, and sends STEERING_REFINE_PROMPT with
 * `displayText: "Refine <name>.md"`. Returns the session key, or null when
 * nothing was sent.
 */
async function refineSteeringDoc(chat, uri) {
  let target = uri;
  if (target && target.path === undefined && target.command && Array.isArray(target.command.arguments)) target = target.command.arguments[0];
  if (!target || target.path === undefined) { const active = vscode.window.activeTextEditor; target = active && active.document.uri; }
  if (!target || !isSteeringDocument(target)) {
    vscode.window.showInformationMessage("KiroCrew: open a steering document (.kiro/steering/*.md) to refine it.");
    return null;
  }
  const open = (vscode.workspace.textDocuments || []).find((d) => d.uri.toString() === target.toString());
  if (open && open.isDirty) await open.save();
  const home = homeUri();
  const label = steeringDocLabel(target.path, vscode.workspace.workspaceFolders || [], home ? home.path : "");
  let entry;
  try { entry = await fileContext(target, () => label); } catch { vscode.window.showErrorMessage("KiroCrew: could not read " + label + "."); return null; }
  return chat.sendWithContexts(STEERING_REFINE_PROMPT, [entry], { displayText: steeringRefineDisplay(steeringNameOf(target)) });
}

// ---- "Import from other assistants" (requirement 11.3): the Steering view's
// title-bar action (and a welcome-content link). Scans the workspace folder for
// the instruction files other coding assistants read, offers them as a
// multi-pick, and copies each into `.kiro/steering/<name>.md` with an
// `inclusion: always` front matter, leaving targets that already exist alone.

const STEERING_IMPORT_COMMAND = "kirocrew.steering.import";
/** The other assistants' instruction files, as globs relative to the workspace folder. */
const IMPORT_SOURCES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules/**", ".clinerules", ".continue/**", ".github/copilot-instructions.md"];
const IMPORT_FIND_EXCLUDE = "{**/node_modules/**,**/.git/**}";
/** Cap per source pattern on `findFiles`; `.continue/**` can hold more than rules. */
const IMPORT_FIND_MAX = 200;
/** Per-source target prefixes: the directory sources keep their origin in the steering name. */
const IMPORT_TARGET_RULES = [
  [/^\.github\/copilot-instructions\.md$/i, () => "copilot-instructions"],
  [/^\.cursor\/rules\/(.+)$/i, (m) => "cursor-" + importStem(m[1])],
  [/^\.clinerules\/(.+)$/i, (m) => "clinerules-" + importStem(m[1])],
  [/^\.continue\/(?:rules\/)?(.+)$/i, (m) => "continue-" + importStem(m[1])],
];

/** Pure: a relative path without its leading dot and final extension, slashes as dashes (`a/b.mdc` → `a-b`, `.cursorrules` → `cursorrules`). */
function importStem(rel) {
  return String(rel || "").replace(/^\.+/, "").replace(/\.[^./]+$/, "").replace(/\//g, "-");
}

/**
 * Pure: the steering file stem a source file is imported as — `AGENTS.md` →
 * `agents`, `CLAUDE.md` → `claude`, `.cursorrules` → `cursorrules`,
 * `.cursor/rules/foo.mdc` → `cursor-foo`, `.clinerules` → `clinerules`,
 * `.clinerules/x.md` → `clinerules-x`, `.continue/rules/x.md` → `continue-x`,
 * `.github/copilot-instructions.md` → `copilot-instructions`. Lower-case,
 * anything outside `[a-z0-9_-]` becomes a dash, runs collapsed, ends trimmed.
 */
function importTargetName(relPath) {
  const p = String(relPath || "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  let stem = "";
  for (const [re, make] of IMPORT_TARGET_RULES) {
    const m = re.exec(p);
    if (m) { stem = make(m); break; }
  }
  if (!stem) stem = importStem(p);
  const slug = stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return slug || "imported";
}

/**
 * Pure: the text as a steering document. A file that already starts with a
 * front matter block keeps it, gaining `inclusion: always` when no `inclusion:`
 * field is present (an existing value is left alone); otherwise
 * `---\ninclusion: always\n---` is prepended. In both cases a line
 * `<!-- imported from <source> -->` follows the front matter (omitted when no
 * source is given), then the body.
 */
function withSteeringFrontMatter(text, opts) {
  const s = String(text || "").replace(/^\uFEFF/, "");
  const source = opts && opts.source ? String(opts.source) : "";
  const note = source ? "<!-- imported from " + source.replace(/--/g, "- -") + " -->\n" : "";
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  let fm = "inclusion: always";
  let body = s;
  if (m) {
    fm = m[1];
    if (!/^inclusion\s*:/im.test(fm)) fm = (fm.trim() ? fm.replace(/\s+$/, "") + "\n" : "") + "inclusion: always";
    body = s.slice(m[0].length);
  }
  body = body.replace(/^(\r?\n)+/, "");
  return "---\n" + fm + "\n---\n\n" + note + (note && body ? "\n" : "") + body;
}

/**
 * Finds the importable files of a workspace folder (a folder or its Uri):
 * `[{uri, relPath, target}]` sorted by relative path, `target` the steering
 * stem (made unique within the batch with a `-2`, `-3` suffix when two sources
 * map to the same name). `node_modules` and `.git` are never searched.
 */
async function scanImportSources(folder) {
  const base = folder && folder.uri ? folder.uri : folder;
  const root = String(base.path || "").replace(/\/+$/, "");
  const seen = new Set();
  const out = [];
  // `.clinerules` is a file in older Cline setups and a directory of rule files in newer ones.
  const patterns = IMPORT_SOURCES.flatMap((p) => (p === ".clinerules" ? [p, p + "/**"] : [p]));
  for (const pattern of patterns) {
    const glob = typeof vscode.RelativePattern === "function" ? new vscode.RelativePattern(base, pattern) : pattern;
    let found = [];
    try { found = await vscode.workspace.findFiles(glob, IMPORT_FIND_EXCLUDE, IMPORT_FIND_MAX); } catch { found = []; }
    for (const uri of found || []) {
      const key = uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const p = String(uri.path || "");
      const relPath = root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p.replace(/^.*[\\/]/, "");
      out.push({ uri, relPath, target: importTargetName(relPath) });
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const used = new Map();
  for (const item of out) {
    const n = (used.get(item.target) || 0) + 1;
    used.set(item.target, n);
    if (n > 1) item.target = item.target + "-" + n;
  }
  return out;
}

/**
 * The command: pick the workspace folder when there is more than one, scan it,
 * and offer what was found as a multi-pick (everything pre-picked; the
 * description is the target `<name>.md`, the detail warns when that target
 * already exists). Each picked source whose target does not exist is copied,
 * through `withSteeringFrontMatter`, to `.kiro/steering/<target>.md`; existing
 * targets are skipped. Refreshes the Steering view and reports
 * "Imported N, skipped M (existing)". Returns `{imported, skipped, failed}`,
 * or null when nothing was done (no folder, nothing found, pick dismissed).
 */
async function importSteeringFromAssistants(assetTree, folders) {
  const list = folders || vscode.workspace.workspaceFolders || [];
  if (!list.length) { vscode.window.showErrorMessage("Open a folder first: steering documents are written into its .kiro/steering/."); return null; }
  let folder = list[0];
  if (list.length > 1) {
    const picked = await vscode.window.showQuickPick(list.map((f) => ({ label: "$(root-folder) " + f.name, description: f.uri.path, folder: f })), { placeHolder: "Which workspace folder should be scanned for other assistants' instruction files?" });
    if (!picked) return null;
    folder = picked.folder;
  }
  const found = await scanImportSources(folder);
  if (!found.length) {
    vscode.window.showInformationMessage("KiroCrew: no instruction files from other assistants in " + (folder.name || folder.uri.path) + " (looked for AGENTS.md, CLAUDE.md, .cursorrules, .cursor/rules, .clinerules, .continue and .github/copilot-instructions.md).");
    return null;
  }
  const dir = vscode.Uri.joinPath(folder.uri, ".kiro", ASSET_KINDS.steering.dir);
  const items = [];
  for (const source of found) {
    const targetUri = vscode.Uri.joinPath(dir, source.target + ".md");
    let exists = false;
    try { await vscode.workspace.fs.stat(targetUri); exists = true; } catch { exists = false; }
    items.push({ label: source.relPath, description: source.target + ".md", detail: exists ? "already exists, will be skipped" : undefined, picked: true, source, targetUri, exists });
  }
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: "Import from other assistants", placeHolder: "Copy these into .kiro/steering/ as always-included steering documents" });
  if (!picked || !picked.length) return null;
  await ensureSteeringDir(folder);
  let imported = 0;
  let skipped = 0;
  const failed = [];
  for (const item of picked) {
    if (item.exists) { skipped++; continue; }
    const text = await readWholeText(item.source.uri);
    if (text === null) { failed.push(item.source.relPath); continue; }
    try {
      await vscode.workspace.fs.writeFile(item.targetUri, new TextEncoder().encode(withSteeringFrontMatter(text, { source: item.source.relPath })));
      imported++;
    } catch { failed.push(item.source.relPath); }
  }
  invalidateSteeringCache();
  if (assetTree && typeof assetTree.refresh === "function") assetTree.refresh();
  const summary = "Imported " + imported + ", skipped " + skipped + " (existing)" + (failed.length ? "; could not import " + failed.join(", ") : "");
  vscode.window.showInformationMessage("KiroCrew: " + summary + ".");
  return { imported, skipped, failed };
}

// ---- "Import skill" (requirements 11.4, 11.5): a local folder holding
// SKILL.md is copied into the chosen scope's `.kiro/skills/<name>`; a GitHub
// URL goes to the hook's `POST skills/import`, which downloads the tarball
// (the extension host in the browser cannot reach GitHub), extracts the folder
// holding SKILL.md and moves it into place. Either way an existing name is
// refused, the Skills view refreshes and the new skill is revealed.

const SKILL_IMPORT_COMMAND = "kirocrew.skills.import";
const SKILL_FILE = "SKILL.md";
const SKILL_IMPORT_ROUTE = "/apps/floofycrew/mods/" + IDE_TAG + "/api/skills/import";
/** A skill folder name as written to disk: one safe path segment (mirrors the hook's SKILL_NAME_RE). */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SKILL_GITHUB_HOSTS = ["github.com", "www.github.com"];
const SKILL_IMPORT_URL_HINT = "a GitHub URL (https://github.com/<owner>/<repo>[/tree/<ref>/<path>]) or <owner>/<repo>";
const SKILL_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Pure twin of the hook's `parse_github_url`: `{owner, repo, ref, path}` or
 * null. Accepts `https://github.com/<owner>/<repo>` (trailing `.git`, slash,
 * query or fragment allowed), `.../tree/<ref>[/<path>]`,
 * `.../blob/<ref>/<path>/SKILL.md` and the shorthand `<owner>/<repo>[/tree/...]`.
 * `ref` and `path` are null when not given. Another host, a non-http scheme,
 * an ssh form or a `..` segment is null.
 */
function parseGithubSkillUrl(url) {
  if (typeof url !== "string") return null;
  let text = url.trim();
  if (!text) return null;
  let route;
  const lower = text.toLowerCase();
  if (text.includes("://") || SKILL_GITHUB_HOSTS.some((h) => lower.startsWith(h + "/") || lower === h)) {
    if (!text.includes("://")) text = "https://" + text;
    const m = /^(https?):\/\/([^/?#]+)([^?#]*)/i.exec(text);
    if (!m || !SKILL_GITHUB_HOSTS.includes(m[2].toLowerCase())) return null;
    route = m[3];
  } else {
    if (text.includes(":") || text.startsWith("/") || text.includes("?") || text.includes("#")) return null;
    route = text;
  }
  const segments = route.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  let repo = segments[1];
  if (/\.git$/i.test(repo)) repo = repo.slice(0, -4);
  const bad = (s) => !SKILL_SEGMENT_RE.test(s) || s === "." || s === "..";
  if (bad(owner) || bad(repo)) return null;
  let ref = null;
  let path = null;
  const rest = segments.slice(2);
  if (rest.length) {
    const kind = rest[0];
    if ((kind !== "tree" && kind !== "blob") || rest.length < 2 || bad(rest[1])) return null;
    ref = rest[1];
    let tail = rest.slice(2);
    if (kind === "blob") {
      if (!tail.length || tail[tail.length - 1] !== SKILL_FILE) return null;
      tail = tail.slice(0, -1);
    }
    if (tail.some(bad)) return null;
    path = tail.join("/") || null;
  }
  return { owner, repo, ref, path };
}

/** Pure: `name:` from a SKILL.md's front matter when it is a safe folder name, else `fallback`. */
function skillNameFromText(text, fallback) {
  const s = String(text || "").replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  if (m) {
    const found = /^name[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(m[1]);
    if (found) {
      const name = found[1].trim().replace(/^["']|["']$/g, "").trim();
      if (SKILL_NAME_RE.test(name) && name !== "." && name !== "..") return name;
    }
  }
  return fallback;
}

/** The scopes a skill can be installed into: one per workspace folder, then the user's `~/.kiro/skills`. */
function skillScopePicks(folders, home) {
  const out = [];
  for (const folder of folders || []) out.push({ label: "$(root-folder) Workspace", description: folder.uri.path, scope: "workspace", workspace: folder.uri.path, uri: vscode.Uri.joinPath(folder.uri, ".kiro", ASSET_KINDS.skills.dir) });
  if (home) out.push({ label: "$(home) Global", description: "~/.kiro/" + ASSET_KINDS.skills.dir, scope: "global", workspace: null, uri: vscode.Uri.joinPath(home, ".kiro", ASSET_KINDS.skills.dir) });
  return out;
}

async function uriExists(uri) {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

/**
 * Copies a local skill folder (holding SKILL.md) into `scope.uri/<name>`,
 * `name` from the front matter else the folder's basename. Returns
 * `{name, path}`, or `{error}` when the folder has no SKILL.md, the name is
 * unusable or the target already exists ("skill <name> already exists").
 */
async function importSkillFolder(folderUri, scope) {
  const skillFile = vscode.Uri.joinPath(folderUri, SKILL_FILE);
  if (!(await uriExists(skillFile))) return { error: folderUri.path + " has no " + SKILL_FILE };
  const base = String(folderUri.path || "").replace(/\/+$/, "").split("/").pop() || "";
  const name = skillNameFromText(await readWholeText(skillFile), base);
  if (!SKILL_NAME_RE.test(name) || name === "." || name === "..") return { error: "the skill folder name \"" + name + "\" cannot be used on disk" };
  const target = vscode.Uri.joinPath(scope.uri, name);
  if (await uriExists(target)) return { error: "skill " + name + " already exists", name, path: target.path };
  await vscode.workspace.fs.createDirectory(scope.uri);
  await vscode.workspace.fs.copy(folderUri, target, { overwrite: false });
  return { name, path: target.path };
}

/** Asks the hook to download and place the skill: `{name, path}` or `{error}` (the route's own message). */
async function importSkillFromGithub(url, scope) {
  try {
    const doc = await api(SKILL_IMPORT_ROUTE, { method: "POST", json: { url, scope: scope.scope, workspace: scope.workspace } });
    if (!doc || !doc.name) return { error: (doc && doc.error) || "the import route answered without a skill name" };
    return doc;
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

/**
 * Refreshes the Skills view and selects the new skill (requirement 11.5):
 * the row is re-read from disk through `findRow`, then `treeView.reveal`
 * (which needs `AssetTree.getParent`). Returns true when the row was revealed.
 */
async function revealSkill(assetTree, treeView, scope, name) {
  if (assetTree && typeof assetTree.refresh === "function") assetTree.refresh();
  if (!assetTree || !treeView || typeof treeView.reveal !== "function" || typeof assetTree.findRow !== "function") return false;
  try {
    const row = await assetTree.findRow(scope.scope, name, scope.uri);
    if (!row) return false;
    await treeView.reveal(row, { select: true, focus: true, expand: false });
    return true;
  } catch { return false; }
}

/**
 * The command: source pick (local folder / GitHub URL), scope pick (one per
 * workspace folder, Global when the home is known; skipped when there is only
 * one), then the import. A local folder is copied through `importSkillFolder`;
 * a URL (validated live with `parseGithubSkillUrl`) goes to the hook through
 * `importSkillFromGithub`. `{error}` becomes an error message; on success the
 * Skills view refreshes, the new skill is revealed and its SKILL.md opened.
 * Returns `{name, path, scope}` or null when nothing was imported.
 */
async function importSkill(assetTree, treeView, opts) {
  const o = opts || {};
  const folders = o.folders || vscode.workspace.workspaceFolders || [];
  const home = o.home !== undefined ? o.home : homeUri();
  const picks = skillScopePicks(folders, home);
  if (!picks.length) { vscode.window.showErrorMessage("Open a folder first: skills are installed into its .kiro/skills/ or your ~/.kiro/skills/."); return null; }
  let source = o.source;
  if (!source) {
    const picked = await vscode.window.showQuickPick([
      { label: "$(folder) From a local folder", description: "a folder holding " + SKILL_FILE, source: "folder" },
      { label: "$(github) From a GitHub URL", description: "a public repository, subfolder or tree link", source: "github" },
    ], { title: "Import skill", placeHolder: "Where is the skill?" });
    if (!picked) return null;
    source = picked.source;
  }
  let scope = o.scope ? picks.find((p) => p.scope === o.scope && (!o.workspace || p.workspace === o.workspace)) : null;
  if (!scope) {
    if (picks.length === 1) scope = picks[0];
    else {
      scope = await vscode.window.showQuickPick(picks, { title: "Import skill", placeHolder: "Install the skill for this workspace or for every workspace (global)?" });
      if (!scope) return null;
    }
  }
  let result;
  if (source === "folder") {
    let folderUri = o.folderUri;
    if (!folderUri) {
      const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Import skill", title: "Pick the folder holding " + SKILL_FILE });
      if (!chosen || !chosen.length) return null;
      folderUri = chosen[0];
    }
    try { result = await importSkillFolder(folderUri, scope); } catch (err) { result = { error: (err && err.message) || String(err) }; }
  } else {
    let url = o.url;
    if (!url) {
      url = await vscode.window.showInputBox({
        title: "Import skill from GitHub",
        prompt: "Repository, subfolder or tree URL of a public skill",
        placeHolder: "https://github.com/owner/repo/tree/main/skills/my-skill",
        ignoreFocusOut: true,
        validateInput: (v) => (!String(v || "").trim() || parseGithubSkillUrl(v) ? null : "Give " + SKILL_IMPORT_URL_HINT),
      });
      if (!url || !url.trim()) return null;
    }
    if (!parseGithubSkillUrl(url)) { vscode.window.showErrorMessage("KiroCrew: give " + SKILL_IMPORT_URL_HINT + "."); return null; }
    const run = () => importSkillFromGithub(url.trim(), scope);
    result = typeof vscode.window.withProgress === "function"
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation ? vscode.ProgressLocation.Notification : 15, title: "KiroCrew: importing skill from GitHub…" }, run)
      : await run();
  }
  if (!result || result.error) {
    vscode.window.showErrorMessage("KiroCrew: " + ((result && result.error) || "the skill could not be imported") + ".");
    if (assetTree && typeof assetTree.refresh === "function") assetTree.refresh();
    return null;
  }
  const revealed = await revealSkill(assetTree, treeView, scope, result.name);
  const skillFile = vscode.Uri.joinPath(scope.uri, result.name, SKILL_FILE);
  if (!o.quiet) {
    try {
      const doc = await vscode.workspace.openTextDocument(skillFile);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: revealed });
    } catch { /* the folder is there; the view shows it */ }
    vscode.window.showInformationMessage("KiroCrew: imported skill " + result.name + " into " + (result.path || skillFile.path.replace(/\/SKILL\.md$/, "")) + ".");
  }
  return { name: result.name, path: result.path || vscode.Uri.joinPath(scope.uri, result.name).path, scope: scope.scope, revealed };
}

// ------------------------------------------------------------ spec model

/** The whole file as text, or null when it cannot be read. Not `readText`: that
 *  one (above) clips to a context budget, and a second function of the same
 *  name hoisted over it, so every `#File` / `#Spec` / steering pick went to
 *  the host unclipped — a 51 KB requirements.md came back as
 *  "content exceeds 40000 char limit". */
async function readWholeText(uri) {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return null; }
}

// ---- .config.kiro: the per-spec settings Kiro writes next to the documents,
// `{specId, workflowType, specType}`. The workflow type decides which document
// comes first (and which ones a fast-task spec merely generates); the spec type
// swaps requirements.md for bugfix.md. A missing or unreadable file means the
// defaults, so specs written before this file existed keep working.

const SPEC_CONFIG_FILE = ".config.kiro";
const WORKFLOW_TYPES = ["requirements-first", "design-first", "fast-task"];
const SPEC_TYPES = ["feature", "bugfix"];
const DEFAULT_WORKFLOW_TYPE = "requirements-first";
const DEFAULT_SPEC_TYPE = "feature";

/** Document file names per workflow type; `bugfix` overrides them all (see `documentOrder`). */
const DOCUMENT_ORDER = {
  "requirements-first": ["requirements.md", "design.md", "tasks.md"],
  "design-first": ["design.md", "requirements.md", "tasks.md"],
  "fast-task": ["tasks.md", "requirements.md", "design.md"],
  bugfix: ["bugfix.md", "design.md", "tasks.md"],
};

/** A v4 UUID: the worker's `crypto.randomUUID` when it has one, else from random bytes. */
function uuid() {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

/**
 * The text of a `.config.kiro` as `{specId, workflowType, specType}`; `null`
 * text (no file) and anything malformed fall back to the defaults. When the
 * file was there but wrong, `problem` says what (the diagnostic uses it);
 * a field with an unknown value is defaulted on its own, the rest is kept.
 */
function parseSpecConfig(text) {
  const out = { specId: null, workflowType: DEFAULT_WORKFLOW_TYPE, specType: DEFAULT_SPEC_TYPE };
  if (text === null || text === undefined) return out;
  let raw;
  try { raw = JSON.parse(String(text)); } catch (e) { out.problem = ".config.kiro is not valid JSON: " + (e && e.message ? e.message : String(e)); return out; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { out.problem = ".config.kiro must be a JSON object"; return out; }
  const problems = [];
  if (typeof raw.specId === "string" && raw.specId.trim()) out.specId = raw.specId.trim();
  else if (raw.specId !== undefined) problems.push("specId must be a non-empty string");
  if (raw.workflowType === undefined) { /* default */ }
  else if (WORKFLOW_TYPES.includes(raw.workflowType)) out.workflowType = raw.workflowType;
  else problems.push("workflowType must be one of " + WORKFLOW_TYPES.join(", ") + " (got " + JSON.stringify(raw.workflowType) + ")");
  if (raw.specType === undefined) { /* default */ }
  else if (SPEC_TYPES.includes(raw.specType)) out.specType = raw.specType;
  else problems.push("specType must be one of " + SPEC_TYPES.join(", ") + " (got " + JSON.stringify(raw.specType) + ")");
  if (problems.length) out.problem = problems.join("; ");
  return out;
}

/** The spec directory's `.config.kiro`, parsed with defaults (see `parseSpecConfig`). */
async function readSpecConfig(dir) {
  return parseSpecConfig(await readWholeText(vscode.Uri.joinPath(dir, SPEC_CONFIG_FILE)));
}

/** A config for a spec being created: a fresh `specId`, unknown choices replaced by the defaults. */
function newSpecConfig(choice) {
  const c = choice || {};
  return {
    specId: uuid(),
    workflowType: WORKFLOW_TYPES.includes(c.workflowType) ? c.workflowType : DEFAULT_WORKFLOW_TYPE,
    specType: SPEC_TYPES.includes(c.specType) ? c.specType : DEFAULT_SPEC_TYPE,
  };
}

/** The file body for a config: the three fields, nothing else, pretty-printed. */
function serializeSpecConfig(cfg) {
  const c = cfg || {};
  return JSON.stringify({
    specId: typeof c.specId === "string" && c.specId ? c.specId : uuid(),
    workflowType: WORKFLOW_TYPES.includes(c.workflowType) ? c.workflowType : DEFAULT_WORKFLOW_TYPE,
    specType: SPEC_TYPES.includes(c.specType) ? c.specType : DEFAULT_SPEC_TYPE,
  }, null, 2) + "\n";
}

/** Write `.config.kiro` into the spec directory (creating the directory); returns the config written. */
async function writeSpecConfig(dir, cfg) {
  const body = serializeSpecConfig(cfg);
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, SPEC_CONFIG_FILE), new TextEncoder().encode(body));
  return JSON.parse(body);
}

/**
 * The spec's documents in workflow order (file names): requirements-first →
 * requirements, design, tasks; design-first → design, requirements, tasks;
 * fast-task → tasks, requirements, design; a bugfix spec → bugfix, design,
 * tasks whatever its workflow type. Unknown input gets the default order.
 */
function documentOrder(config) {
  const c = config || {};
  if (c.specType === "bugfix") return DOCUMENT_ORDER.bugfix.slice();
  return (DOCUMENT_ORDER[c.workflowType] || DOCUMENT_ORDER[DEFAULT_WORKFLOW_TYPE]).slice();
}

/** The file that plays "requirements" for this spec: bugfix.md for a bugfix spec, requirements.md otherwise. */
function requirementsFileOf(config) {
  return config && config.specType === "bugfix" ? "bugfix.md" : "requirements.md";
}

/**
 * The document rows of a spec in the Specs view (pure): one per file of
 * `documentOrder(config)`, in that order, as `{ file, stem, exists, generated }`.
 * `exists` comes from `present[file]`; a missing document still gets a row so
 * it can be written from the view. `generated` marks the secondary rows of a
 * fast-task spec — requirements and design, written alongside the leading
 * tasks.md (requirement 1.3); it is never set when tasks.md does not lead
 * (a bugfix spec keeps bugfix → design → tasks whatever its workflow type,
 * requirement 1.4). The first row that is missing and not generated is the
 * document the spec "needs" next.
 */
function specDocumentRows(config, present) {
  const order = documentOrder(config);
  const fast = Boolean(config && config.workflowType === "fast-task") && order[0] === "tasks.md";
  const has = present || {};
  return order.map((file) => ({ file, stem: file.replace(/\.md$/, ""), exists: Boolean(has[file]), generated: fast && file !== "tasks.md" }));
}

// ---- Creating a spec from an idea (the Specs view's ＋, requirement 2.1/2.2):
// the idea names the directory and titles the tab; the two picks below choose
// the config the directory gets; the create turn goes through sendSpecTurn.

/** A spec directory name: letters, digits, `_` and `-`, nothing else (Kiro's rule; rename checks it too). */
const SPEC_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SPEC_NAME_MAX = 48;
const SPEC_NAME_FALLBACK = "new-spec";

/** The workflow-type pick, default first; `label`/`description` are our wording, `value` the config field. */
const WORKFLOW_TYPE_PICKS = [
  { value: "requirements-first", label: "Requirements first", description: "default · requirements → design → tasks, one document at a time", picked: true },
  { value: "design-first", label: "Design first", description: "design → requirements → tasks, for work that starts from an architecture" },
  { value: "fast-task", label: "Fast task", description: "one pass: tasks first, requirements and design generated alongside" },
];

/** The spec-type pick, default first. */
const SPEC_TYPE_PICKS = [
  { value: "feature", label: "Feature", description: "default · a new capability or change, specified in requirements.md", picked: true },
  { value: "bugfix", label: "Bugfix", description: "a defect: bugfix.md (symptoms, reproduction, root cause) stands in for requirements" },
];

/**
 * A directory name for a spec from the feature idea (pure): lower-case, words
 * joined by `-`, anything outside `[A-Za-z0-9_-]` dropped, at most
 * SPEC_NAME_MAX characters cut at a word boundary, `new-spec` when nothing
 * usable is left. "Add dark mode to the settings page!" → "add-dark-mode-to-the-settings-page".
 */
function specNameFromIdea(idea) {
  const words = String(idea || "").toLowerCase().replace(/[^a-z0-9_-]+/g, " ").trim().split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/^-+|-+$/g, "")).filter(Boolean);
  let name = "";
  for (const w of words) {
    const next = name ? name + "-" + w : w;
    if (next.length > SPEC_NAME_MAX) break;
    name = next;
  }
  if (!name && words.length) name = words[0].slice(0, SPEC_NAME_MAX);
  name = name.replace(/^-+|-+$/g, "");
  return SPEC_NAME_PATTERN.test(name) ? name : SPEC_NAME_FALLBACK;
}

/**
 * Why `name` cannot be a spec directory (pure): empty, outside
 * SPEC_NAME_PATTERN, or already in `taken` (an array or Set of existing names,
 * compared as given). Null when it can. `current`, when given, is the spec's
 * own name and is refused as "unchanged" (the rename case).
 */
function validateSpecName(name, taken, current) {
  const v = String(name === undefined || name === null ? "" : name).trim();
  if (!v) return "Give the spec a name.";
  if (!SPEC_NAME_PATTERN.test(v)) return "Letters, digits, `_` and `-` only (no spaces or dots).";
  if (current !== undefined && current !== null && v === String(current)) return "That is the spec's current name.";
  const set = taken instanceof Set ? taken : new Set(Array.isArray(taken) ? taken : []);
  if (set.has(v)) return "A spec named " + v + " already exists.";
  return null;
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

const TASK_STATUS_BOXES = { not_started: " ", queued: "~", in_progress: "-", completed: "x" };

/**
 * The last line of a task's block (inclusive): its own details and every
 * sub-task's block, i.e. the line before the next task at the same or a
 * shallower level. The parser's exclusive `endLine` already stops there for
 * a leaf; a parent reaches to its deepest sub-task. With the document's
 * `lines`, trailing blank lines are left out so a border never covers the gap
 * between two tasks.
 */
function taskBlockEnd(task, lines) {
  let end = Math.max(task.startLine, (task.endLine || task.startLine + 1) - 1);
  for (const sub of task.subTasks || []) end = Math.max(end, taskBlockEnd(sub, lines));
  if (lines) { if (end >= lines.length) end = lines.length - 1; while (end > task.startLine && String(lines[end] || "").trim() === "") end -= 1; }
  return end;
}

/**
 * The flat, document-ordered view the Specs tree and the editor rows use:
 * `{ id, number, title, level, box, line, endLine, indent, status, done, partial, queued, optional, leaf }`.
 * `title` is the text without its number; `partial` is Kiro's in-progress mark;
 * `endLine` is the block's last line (see `taskBlockEnd`), trimmed of trailing
 * blanks when the document `text` is given.
 */
function flattenTasks(tree, text) {
  const lines = text === undefined || text === null ? null : String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  walkTasks(tree, (t) => {
    const title = t.number ? t.text.replace(/^\d+(?:\.\d+)*\.?\s*/, "") : t.text;
    out.push({ id: t.id, number: t.number || "", title: title.trim(), level: t.level || 1, box: TASK_STATUS_BOXES[t.status] || " ", line: t.startLine, endLine: taskBlockEnd(t, lines), indent: t.indent, status: t.status, done: t.status === "completed", partial: t.status === "in_progress", queued: t.status === "queued", optional: t.optional, leaf: t.subTasks.length === 0 });
  });
  return out.sort((a, b) => a.line - b.line);
}

/** Parse tasks.md into the flat view (see `flattenTasks`). */
function parseTasks(text) {
  return flattenTasks(parseTaskTree(text), text);
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

// ------------------------------------------------- requirements.md / design.md
//
// The two other documents Kiro's spec workflow writes, read for the hovers and
// the Specs view. requirements.md (bugfix.md for a bugfix spec) is a list of
// `### Requirement N` sections, each with a `**User Story:**` paragraph and a
// numbered acceptance-criteria list; design.md may carry a `## Correctness
// Properties` section listing `Property N: title` entries, each followed by a
// `Validates: Requirements …` line. Both parsers tolerate missing parts: a
// requirement without a story or criteria is still a requirement, a design
// without the section has no properties.

const MD_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const REQUIREMENT_HEADING = /^Requirement\s+(\d+(?:\.\d+)*)\b\s*(.*)$/i;
const USER_STORY_LINE = /^\s*(?:\*\*|__)?\s*User Story\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i;
const CRITERION_LINE = /^\s*(\d+)\.\s+(.+)$/;
const PROPERTY_REF = /\bProperty\s+(\d+(?:\.\d+)*)\b\s*[:.\-—–]?\s*(?:\*\*|__)?\s*(.*)$/i;
const VALIDATES_LINE = /^\s*(?:[-*+]\s+)?(?:[*_]{1,2})?\s*Validates\s*:?\s*(?:[*_]{1,2})?\s*(.*)$/i;
const REQUIREMENT_REF = /\d+(?:\.\d+)*/g;

const mdLines = (text) => String(text || "").replace(/\r\n?/g, "\n").split("\n");
/** `**bold**`, `_em_` and backticks stripped from a heading or title. */
const plainMd = (s) => String(s || "").replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:])/g, "$1$2").replace(/`([^`]*)`/g, "$1").trim();

/**
 * requirements.md (or bugfix.md) → `[{number, heading, title, story, userStory,
 * criteria: [{number, ref, text, line}], line, endLine}]` in document order.
 * `heading` is the heading text as written ("Requirement 1 — Spec configuration"),
 * `title` the part after the number. A criterion's `number` is the list number
 * as written ("3") and `ref` the hover form ("1.3"). Wrapped story and
 * criterion lines are joined with a space. `story` and `userStory` are the same
 * value (design.md names the field `userStory`).
 */
function parseRequirements(text) {
  const lines = mdLines(text);
  const out = [];
  let cur = null, level = 0, criterion = null, storyOpen = false;
  const close = (i) => { if (cur) { cur.endLine = i - 1; while (cur.endLine > cur.line && lines[cur.endLine].trim() === "") cur.endLine -= 1; } cur = null; criterion = null; storyOpen = false; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(MD_HEADING);
    if (h) {
      const r = plainMd(h[2]).match(REQUIREMENT_HEADING);
      if (r) {
        close(i);
        level = h[1].length;
        cur = { number: r[1], heading: plainMd(h[2]), title: r[2].replace(/^[\s:—–\-]+/, "").trim(), story: "", userStory: "", criteria: [], line: i, endLine: i };
        out.push(cur);
        continue;
      }
      if (cur && h[1].length <= level) { close(i); continue; }
      criterion = null; storyOpen = false; // a sub-heading (Acceptance Criteria) ends the story / list
      continue;
    }
    if (!cur) continue;
    const trimmed = line.trim();
    if (trimmed === "") { criterion = null; storyOpen = false; continue; }
    const story = line.match(USER_STORY_LINE);
    if (story) { cur.story = cur.userStory = story[1].trim(); criterion = null; storyOpen = true; continue; }
    const c = line.match(CRITERION_LINE);
    if (c) { criterion = { number: c[1], ref: cur.number + "." + c[1], text: c[2].trim(), line: i }; cur.criteria.push(criterion); storyOpen = false; continue; }
    if (/^\s*[-*+]\s+/.test(line)) { criterion = null; storyOpen = false; continue; } // a bullet is neither
    if (criterion) criterion.text = (criterion.text + " " + trimmed).trim();
    else if (storyOpen) cur.story = cur.userStory = (cur.story + " " + trimmed).trim();
  }
  close(lines.length);
  return out;
}

/** The requirement `N` and the criterion `N.M` a reference like "1.3" or "2" points at (either may be `null`). */
function findRequirement(requirements, ref) {
  const m = String(ref || "").match(/^(\d+)(?:\.(\d+(?:\.\d+)*))?$/);
  if (!m) return { requirement: null, criterion: null };
  const requirement = (requirements || []).find((r) => r.number === m[1]) || null;
  const criterion = requirement && m[2] ? requirement.criteria.find((c) => c.number === m[2]) || null : null;
  return { requirement, criterion };
}

/** The `## Correctness Properties` section of design.md as `{start, end}` line indexes (exclusive end), or null. */
function correctnessSection(lines) {
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(MD_HEADING);
    if (!h) continue;
    if (start === -1) { if (/^correctness\s+properties\b/i.test(plainMd(h[2]))) { start = i + 1; level = h[1].length; } }
    else if (h[1].length <= level) return { start, end: i };
  }
  return start === -1 ? null : { start, end: lines.length };
}

/**
 * design.md → `[{number, title, validates: ["1.2", …], description, line}]` from
 * its "Correctness Properties" section: `Property N: title` as a heading
 * (`### Property 1: …`), a bold line (`**Property 1: …**`) or a bullet, then a
 * `Validates: Requirements 1.2, 3.4` line (bold, italic or plain) whose
 * requirement references become `validates`. Lines between the two are the
 * description. No section → `[]`.
 */
function parseProperties(text) {
  const lines = mdLines(text);
  const section = correctnessSection(lines);
  if (!section) return [];
  const out = [];
  let cur = null;
  for (let i = section.start; i < section.end; i++) {
    const line = lines[i];
    const h = line.match(MD_HEADING);
    const head = h ? plainMd(h[2]) : plainMd(line.replace(/^\s*[-*+]\s+/, ""));
    const p = head.match(/^Property\s+\d/i) ? head.match(PROPERTY_REF) : null;
    if (p) { cur = { number: p[1], title: plainMd(p[2]).replace(/[*_]+$/, "").trim(), validates: [], description: "", line: i }; out.push(cur); continue; }
    if (!cur) continue;
    const v = line.match(VALIDATES_LINE);
    if (v) { cur.validates.push(...(v[1].replace(/Requirements?/i, "").match(REQUIREMENT_REF) || [])); continue; }
    if (h) { cur = null; continue; }
    const trimmed = line.trim();
    if (trimmed) cur.description = (cur.description + " " + plainMd(trimmed)).trim();
  }
  return out;
}

/** The property numbered `N` (a `_Property N_` / `**Property N**` reference), or null. */
function findProperty(properties, number) {
  return (properties || []).find((p) => p.number === String(number)) || null;
}

// ------------------------------------------------------------------ SpecModel
//
// One model per spec directory — the config, the documents, the task tree with
// block ends, the requirements and the design's correctness properties — built
// once and kept until a file under `.kiro/specs/**` changes. Every consumer
// (title-bar actions, lenses and decorations, diagnostics, hovers, the Specs
// view) reads the same object instead of re-parsing the three documents on
// each call; `SpecModelStore.onDidChange` tells them when to re-read.

const SPEC_MODEL_DEBOUNCE_MS = 250;
const SPEC_MODEL_FILES = ["requirements.md", "bugfix.md", "design.md", "tasks.md"];

/** `/…/.kiro/specs/<name>` for any path inside a spec directory (or the directory itself); null outside. */
function specDirOf(fsPath) {
  const m = String(fsPath || "").replace(/\\/g, "/").match(/^(.*\/\.kiro\/specs\/[^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/** The file name a spec path points at inside its directory ("tasks.md"), or "" for the directory itself. */
function specFileOf(fsPath) {
  const dir = specDirOf(fsPath);
  if (!dir) return "";
  return String(fsPath).replace(/\\/g, "/").slice(dir.length).replace(/^\//, "");
}

/**
 * The model for one spec from its texts (pure; `texts[file]` is the document
 * body or null when the file is absent):
 * `{ name, dir, config, requirementsFile, order, documents: {file: {exists, text}},
 *    tasks, taskTree, requirements, properties, builtAt }`.
 * `tasks` is the flat view with `endLine` (see `flattenTasks`); `requirements`
 * come from bugfix.md when the spec type is bugfix, requirements.md otherwise.
 */
function buildSpecModel({ name, dir, config, texts }) {
  const cfg = config || parseSpecConfig(null);
  const t = texts || {};
  const documents = {};
  for (const file of SPEC_MODEL_FILES) documents[file] = { exists: t[file] !== null && t[file] !== undefined, text: t[file] || "" };
  const requirementsFile = requirementsFileOf(cfg);
  const taskTree = parseTaskTree(documents["tasks.md"].text);
  return {
    name: name || "", dir: dir || null, config: cfg, requirementsFile, order: documentOrder(cfg), documents, taskTree,
    tasks: flattenTasks(taskTree, documents["tasks.md"].text),
    requirements: parseRequirements(documents[requirementsFile].text),
    properties: parseProperties(documents["design.md"].text),
    builtAt: Date.now(),
  };
}

/** Read the documents of a spec directory and build its model (`dir` is a Uri). */
async function loadSpecModel(dir, name) {
  const texts = {};
  for (const file of SPEC_MODEL_FILES) texts[file] = await readWholeText(vscode.Uri.joinPath(dir, file));
  const config = await readSpecConfig(dir);
  return buildSpecModel({ name: name || String(dir.path).split("/").pop(), dir, config, texts });
}

/**
 * The cache. `get(dirUri)` returns the model (building it once);
 * `forDocument(uri)` resolves a document to its spec; `invalidate(path)` drops
 * one spec (or all with no path). A `FileSystemWatcher` on `.kiro/specs/**`
 * collects events for SPEC_MODEL_DEBOUNCE_MS, then drops the touched models
 * and fires `onDidChange({dirs, files, configChanged, structural})`: `dirs` are
 * the spec directories touched, `files` the file names changed in them,
 * `configChanged` when a `.config.kiro` was among them, `structural` when a
 * spec directory itself (or `.kiro/specs`) appeared or disappeared.
 */
class SpecModelStore {
  constructor(context, options) {
    this._models = new Map(); // dir path → { promise, model (once resolved) }
    this._change = new vscode.EventEmitter();
    this.onDidChange = this._change.event;
    this._pending = null; // { timer, paths: Map<path, kind> }
    this._debounceMs = options && options.debounceMs !== undefined ? options.debounceMs : SPEC_MODEL_DEBOUNCE_MS;
    if (context && vscode.workspace && typeof vscode.workspace.createFileSystemWatcher === "function") {
      const watcher = vscode.workspace.createFileSystemWatcher("**/.kiro/specs/**");
      context.subscriptions.push(watcher, this._change,
        watcher.onDidChange((uri) => this.noteChange(uri, "change")),
        watcher.onDidCreate((uri) => this.noteChange(uri, "create")),
        watcher.onDidDelete((uri) => this.noteChange(uri, "delete")),
        { dispose: () => { if (this._pending) clearTimeout(this._pending.timer); this._pending = null; } });
    }
  }
  /** The key a Uri or path is cached under. */
  static key(dirOrPath) { return String(dirOrPath && dirOrPath.path !== undefined ? dirOrPath.path : dirOrPath || "").replace(/\\/g, "/").replace(/\/+$/, ""); }
  /** The model of the spec directory `dir` (Uri), built on first use. */
  get(dir, name) {
    const key = SpecModelStore.key(dir);
    let entry = this._models.get(key);
    if (!entry) {
      entry = { promise: null, model: null };
      entry.promise = loadSpecModel(dir, name).then(
        (model) => { entry.model = model; return model; },
        (error) => { if (this._models.get(key) === entry) this._models.delete(key); throw error; });
      this._models.set(key, entry);
    }
    return entry.promise;
  }
  /** The model of the spec a document (Uri or path) belongs to, or null outside `.kiro/specs/<name>/`. */
  forDocument(uriOrPath) {
    const path = uriOrPath && uriOrPath.path !== undefined ? uriOrPath.path : uriOrPath;
    const dir = specDirOf(path);
    if (!dir) return Promise.resolve(null);
    const uri = uriOrPath && uriOrPath.path !== undefined && uriOrPath.with ? uriOrPath.with({ path: dir }) : vscode.Uri.file(dir);
    return this.get(uri, dir.split("/").pop());
  }
  /** The cached model when one is built (sync, no load); undefined otherwise. */
  peek(dir) { const entry = this._models.get(SpecModelStore.key(dir)); return entry ? entry.model || undefined : undefined; }
  /** Drop the model of the spec containing `path`, or every model with no argument. */
  invalidate(path) {
    if (path === undefined || path === null) { this._models.clear(); return; }
    const dir = specDirOf(SpecModelStore.key(path));
    if (dir) this._models.delete(dir); else this._models.clear();
  }
  /** Record one watcher event; the batch is applied after the debounce. */
  noteChange(uri, kind) {
    const path = SpecModelStore.key(uri);
    if (!this._pending) this._pending = { timer: null, paths: new Map() };
    this._pending.paths.set(path, kind);
    if (this._pending.timer) clearTimeout(this._pending.timer);
    this._pending.timer = setTimeout(() => this.flush(), this._debounceMs);
  }
  /** Apply the pending events now: invalidate the touched specs and fire `onDidChange`. */
  flush() {
    const pending = this._pending;
    this._pending = null;
    if (!pending) return null;
    if (pending.timer) clearTimeout(pending.timer);
    const dirs = new Set(), files = new Set();
    let configChanged = false, structural = false;
    for (const [path, kind] of pending.paths) {
      const dir = specDirOf(path);
      if (!dir) { structural = true; this._models.clear(); continue; }
      dirs.add(dir);
      this._models.delete(dir);
      const file = specFileOf(path);
      if (!file) { if (kind !== "change") structural = true; continue; }
      files.add(file);
      if (file === SPEC_CONFIG_FILE) configChanged = true;
    }
    const event = { dirs: Array.from(dirs), files: Array.from(files), configChanged, structural };
    this._change.fire(event);
    return event;
  }
}

let specModels = null; // the store `activate` builds; providers registered later read it
/** The activation's SpecModelStore (null in unit tests that never activate). */
function specModelStore() { return specModels; }

// ------------------------------------------------------- TaskSessionLinks
//
// Which session worked on which task. `runTask` / `runAll` record one link
// per run — `{ id, feature, dir, taskIds, sessionId, startedAt, outcome? }` —
// in the workspace state array `kirocrew.taskSessionLinks`; the session id is
// filled in once the gateway has created the session, and the outcome (`ok`,
// `error`, `stopped`) when that tab's turn ends. The lenses and the Specs view
// read the latest link of a task (falling back to the feature's latest) for
// "View session" and the failed / aborted states; `onDidChange` tells them
// when to re-read. The array is pruned to the 200 most recent on every write.

const TASK_SESSION_LINKS_KEY = "kirocrew.taskSessionLinks";
const TASK_SESSION_LINKS_MAX = 200;
const LINK_OUTCOMES = ["ok", "error", "stopped"];

/** One stored link made safe: strings where strings belong, a string array of task ids, a number for `startedAt`; null for anything unusable. */
function normalizeLink(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.feature !== "string" || !raw.feature) return null;
  const ids = Array.isArray(raw.taskIds) ? raw.taskIds.filter((x) => typeof x === "string" && x) : [];
  const link = {
    id: typeof raw.id === "string" && raw.id ? raw.id : uuid(),
    feature: raw.feature,
    dir: typeof raw.dir === "string" && raw.dir ? raw.dir : null,
    taskIds: ids,
    sessionId: typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null,
    startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : 0,
  };
  if (LINK_OUTCOMES.includes(raw.outcome)) link.outcome = raw.outcome;
  // The engine the run went to: "kas" for Kiro's spec engine in kiro-cli (its session id is a
  // KAS session, opened as a Kiro-mode tab; the mod's resume logic leaves it alone); else the gateway.
  if (raw.engine === "kas") link.engine = "kas";
  return link;
}

/** The stored array read back: every usable record, in the order it was kept. */
function readLinks(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeLink).filter(Boolean);
}

/**
 * The `max` most recent links (by `startedAt`; between equal times the later
 * entry of the array is the newer), returned oldest first. Never mutates.
 */
function pruneLinks(links, max) {
  const cap = max === undefined ? TASK_SESSION_LINKS_MAX : Math.max(0, Math.floor(Number(max)) || 0);
  const ordered = (links || []).map((link, i) => ({ link, i })).sort((a, b) => (a.link.startedAt - b.link.startedAt) || (a.i - b.i)).map((x) => x.link);
  return cap ? ordered.slice(-cap) : [];
}

/** The newest link satisfying `where` (by `startedAt`, then array position), or null. */
function latestLink(links, where) {
  let hit = null, at = -1;
  (links || []).forEach((link, i) => {
    if (!link || (where && !where(link))) return;
    if (!hit || link.startedAt > hit.startedAt || (link.startedAt === hit.startedAt && i > at)) { hit = link; at = i; }
  });
  return hit;
}

/** Does a link belong to spec `feature` (in directory `dir`, when both sides know one)? */
function linkMatchesFeature(link, feature, dir) {
  return Boolean(link) && link.feature === feature && (!dir || !link.dir || sameDir(link.dir, dir));
}

/** The latest link whose run included task `taskId` of `feature`; null when none did. */
function latestLinkForTask(links, feature, taskId, dir) {
  return latestLink(links, (l) => linkMatchesFeature(l, feature, dir) && l.taskIds.includes(taskId));
}

/** The latest link of `feature` (any task, a run-all included); null when the spec never ran. */
function latestLinkForFeature(links, feature, dir) {
  return latestLink(links, (l) => linkMatchesFeature(l, feature, dir));
}

/** The link `ref` names: by record id first, else the latest link of the session with that id. */
function findLink(links, ref) {
  if (!ref) return null;
  return (links || []).find((l) => l.id === ref) || latestLink(links, (l) => l.sessionId === ref);
}

/**
 * What `kirocrew.spec.viewSession` was invoked on, as `{ feature, dir, taskId }`:
 * a Specs view node (`node.spec`, with `node.task` on a task row), or the
 * plain `{ feature, dir?, taskId? }` a code lens or the spec editor passes.
 * `dir` is a path (a Uri's `.path` is taken). Null when nothing names a spec.
 */
function viewSessionTarget(arg) {
  if (!arg || typeof arg !== "object") return null;
  const pathOf = (d) => (typeof d === "string" && d ? d : d && typeof d.path === "string" && d.path ? d.path : null);
  if (arg.spec && typeof arg.spec.name === "string" && arg.spec.name) {
    const taskId = arg.task && typeof arg.task.id === "string" && arg.task.id ? arg.task.id : null;
    return { feature: arg.spec.name, dir: pathOf(arg.spec.dir), taskId };
  }
  if (typeof arg.feature === "string" && arg.feature) {
    return { feature: arg.feature, dir: pathOf(arg.dir), taskId: typeof arg.taskId === "string" && arg.taskId ? arg.taskId : null };
  }
  return null;
}

/**
 * The link "View session" opens for `target` (requirement 13.2): the latest
 * link whose run included `taskId`, else the latest link of the feature (a
 * run-all, or the last run of another task). Only links that know their
 * session count — a run whose session the gateway never named has nothing to
 * show. `links` is the array or the store. Null when the spec never ran.
 */
function resolveViewSessionLink(links, target) {
  if (!target || typeof target.feature !== "string" || !target.feature) return null;
  const all = Array.isArray(links) ? links : links && typeof links.all === "function" ? links.all() : [];
  const ofFeature = (l) => Boolean(l.sessionId) && linkMatchesFeature(l, target.feature, target.dir);
  const byTask = target.taskId ? latestLink(all, (l) => ofFeature(l) && l.taskIds.includes(target.taskId)) : null;
  return byTask || latestLink(all, ofFeature);
}

/** The six Task_States of a task line (requirement 4.7): the four boxes' statuses plus the two the run record adds. */
const TASK_STATES = ["not_started", "queued", "in_progress", "completed", "failed", "aborted"];

/**
 * The run record that decides a task's state: the latest link whose run
 * included the task, else the feature's latest link when that run named no
 * tasks at all (a spec-wide run recorded without its task set). A sibling's
 * own run never counts — task 2 failing says nothing about task 3. `links` is
 * the array or the store. Null when nothing ran the task.
 */
function taskStateLink(links, feature, taskId, dir) {
  if (typeof feature !== "string" || !feature) return null;
  const all = Array.isArray(links) ? readLinks(links) : links && typeof links.all === "function" ? links.all() : [];
  const byTask = taskId ? latestLinkForTask(all, feature, taskId, dir) : null;
  if (byTask) return byTask;
  const ofFeature = latestLinkForFeature(all, feature, dir);
  return ofFeature && ofFeature.taskIds.length === 0 ? ofFeature : null;
}

/**
 * The Task_State of one task (requirement 4.7), one of TASK_STATES. The box
 * on the line decides first — `[x]` completed, `[~]` queued, `[-]` in progress
 * (the orchestrator writes those) — and for a `[ ]` task the latest run record
 * (see `taskStateLink`) decides: outcome `error` → failed; outcome `stopped` →
 * aborted once the session is no longer running; no record, outcome `ok`, a
 * turn still going, or a stop whose session still runs → not started.
 *
 * `task` is a `parseTasks` row (`box` or `status`, `id`); `opts` gives
 * `feature` / `dir` (read from the task when it carries them) and
 * `isRunning(sessionId)`, the host's "is that session's turn still going"
 * (`sessions.slot(key).running`); without it no session counts as running.
 */
function taskState(task, links, opts) {
  const o = opts || {};
  const t = task || {};
  const box = typeof t.box === "string" && t.box ? t.box.toLowerCase() : TASK_STATUS_BOXES[t.status] || " ";
  const fromBox = TASK_STATUS_MARKS[box] || "not_started";
  if (fromBox !== "not_started") return fromBox;
  const feature = typeof o.feature === "string" && o.feature ? o.feature : typeof t.feature === "string" ? t.feature : "";
  const dir = o.dir !== undefined ? o.dir : t.dir;
  const taskId = typeof t.id === "string" ? t.id : t.id === undefined || t.id === null ? "" : String(t.id);
  // A run on Kiro's engine reports the live execution status before the box changes.
  if (typeof o.kasExec === "function") {
    const live = mergeKasTaskState("not_started", o.kasExec(feature, dir, taskId));
    if (live !== "not_started") return live;
  }
  const link = taskStateLink(links, feature, taskId, dir);
  if (!link) return "not_started";
  if (link.outcome === "error") return "failed";
  if (link.outcome === "stopped") {
    const running = typeof o.isRunning === "function" && link.sessionId ? Boolean(o.isRunning(link.sessionId)) : false;
    return running ? "not_started" : "aborted";
  }
  return "not_started";
}

// ------------------------------------------- task state from Kiro's engine (requirement 5.4, 5.5)
//
// A spec run on Kiro's engine (kirocrew.specEngine = kas) writes its task states to
// `~/.kiro/tasks/<wsHash>/<feature>.meta.json` and announces them as
// `_kiro/spec/taskStatusChanged`; the box in tasks.md follows a step later (KAS ticks it
// through fs/write_text_file when a task succeeds). The hook relays the events over the
// Kas_Link (`specEvent`) and serves the file through `GET kas/tasks?folder&feature`; the
// store below keeps both per feature, the lenses, borders and Specs view merge them with
// the box, and "View session" opens the task's `lastSessionId` (or the feature's spec
// session) as a Kiro-mode tab.

const KAS_TASKS_ROUTE = "/apps/floofycrew/mods/" + IDE_TAG + "/api/kas/tasks";
/** Poll period of the task metadata while a Kiro-mode spec run is live (the web host cannot watch ~/.kiro). */
const KAS_TASK_POLL_MS = 2000;
/** KAS execution statuses → Task_States for a task whose box is still `[ ]`. */
const KAS_EXEC_STATES = { queued: "queued", running: "in_progress", in_progress: "in_progress", failed: "failed", error: "failed", aborted: "aborted", cancelled: "aborted", stopped: "aborted" };
/**
 * The merge table (box × executionStatus), pure: the box on the line wins whenever it says
 * anything (`[x]` completed, `[~]` queued, `[-]` in progress); a `[ ]` task shows KAS's live
 * execution status (queued, running → in progress, failed, cancelled/aborted → stopped);
 * `succeed` on a `[ ]` box stays not started — the file is the truth, and KAS ticks the box
 * itself when a task succeeds. Unknown statuses change nothing.
 */
function mergeKasTaskState(boxState, executionStatus) {
  if (boxState && boxState !== "not_started") return boxState;
  return KAS_EXEC_STATES[String(executionStatus || "").toLowerCase()] || "not_started";
}
/** The feature a `taskStatusChanged.tasksFilePath` names (`…/.kiro/specs/<feature>/tasks.md`), or null. */
function kasFeatureOfPath(tasksFilePath) {
  const m = /[\\/]\.kiro[\\/]specs[\\/]([^\\/]+)[\\/]tasks\.md$/.exec(String(tasksFilePath || ""));
  return m ? m[1] : null;
}
/**
 * The session "View session" opens for `target` ({ feature, dir, taskId }) when the spec ran
 * on Kiro's engine, pure: the task's `lastSessionId` from the KAS task state, else the
 * feature's spec session (`~/.kiro/spec-sessions/<wsHash>.json`), else a kas task link's
 * session. `{ sessionId, engine: "kas" }` or null. `store` is a KasTaskStore (or anything
 * with `statusOf`-shaped `entry(feature, dir)`), `links` the TaskSessionLinks (or array).
 */
function resolveKasViewSession(target, store, links) {
  if (!target || !target.feature) return null;
  const entry = store && typeof store.entry === "function" ? store.entry(target.feature, target.dir) : null;
  if (entry) {
    const row = target.taskId && entry.tasks ? entry.tasks[target.taskId] : null;
    if (row && row.lastSessionId) return { sessionId: row.lastSessionId, engine: "kas" };
    if (entry.specSessionId) return { sessionId: entry.specSessionId, engine: "kas" };
  }
  const all = Array.isArray(links) ? links : links && typeof links.all === "function" ? links.all() : [];
  const kasLink = resolveViewSessionLink(all.filter((l) => l.engine === "kas"), target);
  return kasLink ? { sessionId: kasLink.sessionId, engine: "kas" } : null;
}
/**
 * The KAS task states of this workspace's specs: `{ tasks: { <taskId>: { executionStatus,
 * lastSessionId, lastExecutionId, updatedAt } }, specSessionId }` per feature, from the
 * `taskStatusChanged` events (applied at once) and the hook's `kas/tasks` route (fetched on
 * each event and every KAS_TASK_POLL_MS while a run is live). `onDidChange` fires on every
 * update; the activation refreshes the lenses and the Specs view from it.
 */
class KasTaskStore {
  constructor(folder, options) {
    const o = options || {};
    this.folder = folder || "";
    this.fetchImpl = typeof o.fetch === "function" ? o.fetch : (feature) => api(KAS_TASKS_ROUTE + "?folder=" + encodeURIComponent(this.folder) + "&feature=" + encodeURIComponent(feature));
    this.byFeature = new Map();
    this.polling = new Map();     // feature -> timer
    this._change = new vscode.EventEmitter();
    this.onDidChange = this._change.event;
  }
  entry(feature) { return this.byFeature.get(String(feature || "")) || null; }
  statusOf(feature, dir, taskId) {
    const e = this.entry(feature);
    const row = e && e.tasks ? e.tasks[taskId] : null;
    return row ? row.executionStatus : undefined;
  }
  sessionOf(feature, dir, taskId) {
    return (resolveKasViewSession({ feature, dir, taskId }, this, []) || {}).sessionId || null;
  }
  /** A `specEvent` frame from the Kas_Link: `taskStatusChanged` changes are applied at once, then the file is read. */
  applyEvent(frame) {
    if (!frame || frame.kind !== "specEvent" || frame.method !== "_kiro/spec/taskStatusChanged") return false;
    const params = frame.params || {};
    const feature = kasFeatureOfPath(params.tasksFilePath);
    if (!feature) return false;
    const e = this.byFeature.get(feature) || { tasks: {}, specSessionId: null };
    for (const c of Array.isArray(params.changes) ? params.changes : []) {
      if (!c || typeof c.taskId !== "string") continue;
      e.tasks[c.taskId] = Object.assign({}, e.tasks[c.taskId] || {}, { executionStatus: c.executionStatus, lastSessionId: c.lastSessionId || params.sessionId || null, lastExecutionId: c.lastExecutionId || null, updatedAt: Date.now() });
    }
    if (params.sessionId && !e.specSessionId) e.specSessionId = params.sessionId;
    this.byFeature.set(feature, e);
    this._change.fire({ feature });
    this.fetch(feature).catch(() => undefined);
    return true;
  }
  /** Read the hook's `kas/tasks` for `feature` and replace the entry (the file is the authority once written). */
  async fetch(feature) {
    const doc = await this.fetchImpl(feature);
    if (!doc || typeof doc !== "object") return null;
    const prev = this.byFeature.get(feature) || { tasks: {}, specSessionId: null };
    const tasks = doc.exists && doc.tasks && typeof doc.tasks === "object" ? doc.tasks : prev.tasks;
    const e = { tasks, specSessionId: doc.specSessionId || prev.specSessionId || null, fetchedAt: Date.now() };
    const changed = JSON.stringify(e.tasks) !== JSON.stringify(prev.tasks) || e.specSessionId !== prev.specSessionId;
    this.byFeature.set(feature, e);
    if (changed) this._change.fire({ feature });
    return e;
  }
  /** Poll `feature` every KAS_TASK_POLL_MS while `isLive()` holds, then once more. */
  track(feature, isLive) {
    if (!feature || this.polling.has(feature)) return;
    const tick = async () => {
      await this.fetch(feature).catch(() => undefined);
      if (isLive()) this.polling.set(feature, setTimeout(tick, KAS_TASK_POLL_MS));
      else { this.polling.delete(feature); await this.fetch(feature).catch(() => undefined); }
    };
    this.polling.set(feature, setTimeout(tick, 0));
  }
  dispose() {
    for (const timer of this.polling.values()) clearTimeout(timer);
    this.polling.clear();
    this._change.dispose();
  }
}
let kasTaskStore = null; // the activation's store; the Specs view and the lenses read it
function kasTasks() { return kasTaskStore; }

/**
 * The store. `record(link)` adds a run (returns the stored record, with its
 * `id`); `setSession(ref, sessionId)` fills the session once the gateway has
 * created it; `setOutcome(ref, outcome)` marks how the turn ended. `ref` is a
 * record id or a session id. `latestForTask` / `latestForFeature` answer
 * "View session" and the task states; `all()` is a copy of the array. Every
 * write prunes to the cap, persists to `context.workspaceState` (when there is
 * one) and fires `onDidChange({ kind, link })`.
 */
class TaskSessionLinks {
  constructor(context, options) {
    const o = options || {};
    this.context = context || null;
    this._key = o.key || TASK_SESSION_LINKS_KEY;
    this._max = o.max === undefined ? TASK_SESSION_LINKS_MAX : o.max;
    const stored = context && context.workspaceState ? context.workspaceState.get(this._key) : o.initial;
    this._links = pruneLinks(readLinks(stored), this._max);
    this._change = new vscode.EventEmitter();
    this.onDidChange = this._change.event;
    if (context && Array.isArray(context.subscriptions)) context.subscriptions.push(this._change);
  }
  /** Every link, oldest first (a copy). */
  all() { return this._links.slice(); }
  /** Add a run: `{ feature, dir?, taskIds, sessionId?, startedAt? }`; returns the stored record. */
  record(link) {
    const rec = normalizeLink(Object.assign({ id: uuid(), startedAt: Date.now() }, link || {}));
    if (!rec) throw new Error("a task session link needs a feature");
    this._links.push(rec);
    this._write("record", rec);
    return rec;
  }
  /** The gateway named the session of the run `ref` (a record id). */
  setSession(ref, sessionId) {
    const rec = findLink(this._links, ref);
    if (!rec || typeof sessionId !== "string" || !sessionId || rec.sessionId === sessionId) return rec || null;
    rec.sessionId = sessionId;
    this._write("session", rec);
    return rec;
  }
  /** The turn of the run `ref` (record id or session id) ended: `ok`, `error` or `stopped`. */
  setOutcome(ref, outcome) {
    if (!LINK_OUTCOMES.includes(outcome)) throw new Error("unknown task run outcome: " + outcome);
    const rec = findLink(this._links, ref);
    if (!rec || rec.outcome === outcome) return rec || null;
    rec.outcome = outcome;
    this._write("outcome", rec);
    return rec;
  }
  latestForTask(feature, taskId, dir) { return latestLinkForTask(this._links, feature, taskId, dir); }
  latestForFeature(feature, dir) { return latestLinkForFeature(this._links, feature, dir); }
  /** Every link of one session, oldest first. */
  forSession(sessionId) { return this._links.filter((l) => l.sessionId === sessionId); }
  /** The link a record id or session id names, or null. */
  get(ref) { return findLink(this._links, ref); }
  _write(kind, link) {
    this._links = pruneLinks(this._links, this._max);
    if (this.context && this.context.workspaceState) {
      const p = this.context.workspaceState.update(this._key, this._links.map((l) => Object.assign({}, l)));
      if (p && typeof p.then === "function") p.then(undefined, (e) => log("task session links: " + (e && e.message ? e.message : e)));
    }
    this._change.fire({ kind, link });
  }
}

let taskLinks = null; // the store `activate` builds; ChatView and the providers read it
/** The activation's TaskSessionLinks (null in unit tests that never activate). */
function taskSessionLinks() { return taskLinks; }

// ------------------------------------------------------- task code lenses
//
// One lens row above every task line of a spec's tasks.md (requirement 4.1),
// its titles following the Task_State: `Start task` for a task not started,
// `Queued` / `In progress` / `Done` as plain labels, `Failed · Retry · Ask the
// agent to fix`, `Stopped · Retry`; `View session` (requirement 4.3) whenever a
// TaskSessionLinks record names the session that ran the task; and `Make
// required` on an optional task (requirement 4.4). Start and Retry run the
// single-task flow (`kirocrew.spec.runTask`, requirement 4.2); "Ask the agent
// to fix" sends the `fix` spec turn; "Make required" drops the `*` of that
// one line. `taskLensSpecs` is the pure layout, `SpecTaskCodeLensProvider`
// turns it into vscode.CodeLens objects from the document's text (unsaved
// edits included) so the row keeps up with what the editor shows.

const TASK_LENS_PATTERN = "**/.kiro/specs/*/tasks.md";
/** The one title of each state's label lens, codicon included (`sync~spin` turns while a task runs). */
const TASK_STATE_LENS_TITLES = {
  not_started: "$(zap) Start task",
  queued: "$(clock) Queued",
  in_progress: "$(sync~spin) In progress",
  completed: "$(check) Done",
  failed: "$(error) Failed",
  aborted: "$(warning) Stopped",
};
const TASK_LENS_RETRY = "$(redo) Retry";
const TASK_LENS_FIX = "$(comment) Ask the agent to fix";
const TASK_LENS_VIEW_SESSION = "$(output) View session";
const TASK_LENS_MAKE_REQUIRED = "$(tasklist) Make required";

/**
 * The lens row of one task (pure): `[{ title, command, args }]` in display
 * order, `command` null for a label with nothing to run. `task` is a
 * `parseTasks` row (`id`, `line`, `optional`); `state` one of TASK_STATES;
 * `opts.hasLink` adds "View session", `opts.optional` (default: the task's
 * flag) adds "Make required"; `opts.spec` is the `{ name, dir }` the run
 * command needs and `opts.uri` the document the line is in. The arguments are
 * the shapes the commands take: `kirocrew.spec.runTask` the Specs view's
 * `{ spec, task }` node, `kirocrew.spec.viewSession` `{ feature, dir, taskId }`,
 * `kirocrew.spec.fixTask` `{ feature, dir, task }`, `kirocrew.spec.makeRequired`
 * `{ uri, line }`.
 */
function taskLensSpecs(task, state, opts) {
  const t = task || {};
  const o = opts || {};
  const s = TASK_STATES.includes(state) ? state : "not_started";
  const spec = o.spec || null;
  const feature = spec && spec.name ? spec.name : "";
  const dir = spec ? (spec.dir && spec.dir.path !== undefined ? spec.dir.path : spec.dir) || null : null;
  const run = { title: TASK_STATE_LENS_TITLES.not_started, command: "kirocrew.spec.runTask", args: [{ spec, task: t, contextValue: "task-open" }] };
  const retry = Object.assign({}, run, { title: TASK_LENS_RETRY });
  const out = [];
  if (s === "not_started") out.push(run);
  else {
    out.push({ title: TASK_STATE_LENS_TITLES[s], command: null, args: [] });
    if (s === "failed" || s === "aborted") out.push(retry);
    if (s === "failed") out.push({ title: TASK_LENS_FIX, command: "kirocrew.spec.fixTask", args: [{ feature, dir, task: t }] });
  }
  if (o.hasLink) out.push({ title: TASK_LENS_VIEW_SESSION, command: "kirocrew.spec.viewSession", args: [{ feature, dir, taskId: typeof t.id === "string" ? t.id : "" }] });
  const optional = o.optional === undefined ? Boolean(t.optional) : Boolean(o.optional);
  if (optional) out.push({ title: TASK_LENS_MAKE_REQUIRED, command: "kirocrew.spec.makeRequired", args: [{ uri: o.uri || null, line: t.line }] });
  return out;
}

/**
 * Where the optional mark of one task line sits (pure): `{ start, end }`
 * character offsets of the `*` (or `\*`) right after the box, so an edit can
 * delete exactly that and nothing else on the line; null when the line is not
 * an optional task.
 */
function optionalMarkRange(lineText) {
  const m = String(lineText || "").match(/^(\s*[-*+]\s+\[[ xX\-~]\])(\\?\*)/);
  if (!m) return null;
  return { start: m[1].length, end: m[1].length + m[2].length };
}

/**
 * The provider. `options.links()` returns the TaskSessionLinks (store or
 * array) the states and "View session" read, `options.isRunning(sessionId)`
 * the host's "is that session's turn still going"; both default to the
 * activation's store and "nothing runs". `refresh()` fires
 * `onDidChangeCodeLenses` so every open tasks.md re-asks (the SpecModel and
 * TaskSessionLinks changes call it).
 */
class SpecTaskCodeLensProvider {
  constructor(options) {
    const o = options || {};
    this._links = typeof o.links === "function" ? o.links : () => taskSessionLinks();
    this._isRunning = typeof o.isRunning === "function" ? o.isRunning : () => false;
    this._kas = typeof o.kas === "function" ? o.kas : () => kasTasks();   // the KasTaskStore (requirement 5.4)
    this._change = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._change.event;
  }
  refresh() { this._change.fire(); }
  dispose() { this._change.dispose(); }
  /** The spec `{ name, dir }` a tasks.md belongs to (dir a Uri), or null outside `.kiro/specs/<name>/`. */
  static specOf(uri) {
    const dirPath = specDirOf(uri && uri.path);
    if (!dirPath) return null;
    return { name: dirPath.split("/").pop(), dir: uri.with ? uri.with({ path: dirPath }) : { path: dirPath } };
  }
  /**
   * The lens rows of a document's text (pure apart from the links): one
   * `{ line, endLine, state, optional, lenses }` per task, `lenses` from
   * `taskLensSpecs`. `endLine` is the task block's last line (the parser's
   * `taskBlockEnd`), what the decorations (`SpecTaskDecorations`) border, so
   * lenses and borders read the same states.
   */
  rows(text, uri) {
    const spec = SpecTaskCodeLensProvider.specOf(uri);
    if (!spec) return [];
    const links = this._links() || [];
    const all = Array.isArray(links) ? readLinks(links) : typeof links.all === "function" ? links.all() : [];
    const dir = spec.dir.path;
    const kas = this._kas();
    const opts = { feature: spec.name, dir, isRunning: this._isRunning, kasExec: kas ? (f, d, id) => kas.statusOf(f, d, id) : undefined };
    // "View session" needs a run that included the task AND knows its session (requirement 4.3);
    // a run on Kiro's engine knows it from the task's metadata (requirement 5.5).
    const known = all.filter((l) => l.sessionId);
    return parseTasks(text).map((task) => {
      const state = taskState(task, all, opts);
      const hasLink = Boolean(latestLinkForTask(known, spec.name, task.id, dir)) || Boolean(kas && kas.sessionOf(spec.name, dir, task.id));
      return { line: task.line, endLine: task.endLine, state, optional: Boolean(task.optional), lenses: taskLensSpecs(task, state, { hasLink, spec, uri }) };
    });
  }
  provideCodeLenses(document) {
    const out = [];
    for (const row of this.rows(document.getText(), document.uri)) {
      const range = new vscode.Range(row.line, 0, row.line, 0);
      for (const lens of row.lenses) {
        // A command with an empty id renders as a plain label (what the queued / in progress / done states want).
        out.push(new vscode.CodeLens(range, { title: lens.title, command: lens.command || "", arguments: lens.args }));
      }
    }
    return out;
  }
}

// ---- Task decorations (requirement 4.5)
//
// Every task block of a visible tasks.md (its line through the last line of
// its sub-tasks, `taskBlockEnd`) carries a 2 px left border whose colour is a
// theme colour per Task_State; an optional task's block is dimmed. One
// `TextEditorDecorationType` per state plus one for "optional"; the ranges
// come from the lens provider's `rows`, so the border and the lens above a
// task never disagree about its state.

/** Theme colour id of the border per Task_State (design.md). */
const TASK_DECORATION_COLORS = {
  not_started: "editorCodeLens.foreground",
  queued: "editorInfo.foreground",
  in_progress: "list.highlightForeground",
  completed: "gitDecoration.untrackedResourceForeground",
  failed: "list.errorForeground",
  aborted: "list.warningForeground",
};
const TASK_DECORATION_OPTIONAL_OPACITY = "0.6";
/** Typing in tasks.md re-applies the borders after this pause (one second is the requirement's ceiling). */
const TASK_DECORATION_DEBOUNCE_MS = 150;
/**
 * Trailing debounce of the lens + decoration refresh that the SpecModel
 * watcher and the links store trigger (requirement 4.6): a run that records a
 * link and whose tasks.md write lands in the same moment refreshes once. With
 * the watcher's own SPEC_MODEL_DEBOUNCE_MS the change-to-refresh latency stays
 * around 350 ms, well inside the requirement's one second.
 */
const TASK_UI_REFRESH_DEBOUNCE_MS = 100;

/**
 * Sorted, merged line ranges (pure): `[{startLine, endLine}]` with
 * overlapping and adjacent ranges joined, so two touching task blocks of the
 * same state read as one border rather than a seam of two.
 */
function mergeLineRanges(ranges) {
  const sorted = (ranges || [])
    .filter((r) => r && Number.isInteger(r.startLine) && r.startLine >= 0)
    .map((r) => ({ startLine: r.startLine, endLine: Math.max(r.startLine, Number.isInteger(r.endLine) ? r.endLine : r.startLine) }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, r.endLine);
    else out.push({ startLine: r.startLine, endLine: r.endLine });
  }
  return out;
}

/**
 * The decoration ranges of a document's lens rows (pure): `{ <state>:
 * [{startLine, endLine}], optional: [...] }` with a key for every
 * TASK_STATES entry (an empty array clears that type). Each row contributes
 * its block `line..endLine` to its state; a parent's block covers its
 * sub-tasks' blocks, so per state the overlapping and touching ranges are
 * merged (`mergeLineRanges`). `optional` holds the merged blocks of the
 * optional tasks, whatever their state.
 */
function taskDecorationRanges(rows) {
  const byState = {};
  for (const s of TASK_STATES) byState[s] = [];
  const optional = [];
  for (const row of rows || []) {
    if (!row || !Number.isInteger(row.line)) continue;
    const range = { startLine: row.line, endLine: Number.isInteger(row.endLine) ? row.endLine : row.line };
    const state = TASK_STATES.includes(row.state) ? row.state : "not_started";
    byState[state].push(range);
    if (row.optional) optional.push(range);
  }
  const out = {};
  for (const s of TASK_STATES) out[s] = mergeLineRanges(byState[s]);
  out.optional = mergeLineRanges(optional);
  return out;
}

/**
 * The editor decorations. `lenses` is the `SpecTaskCodeLensProvider` whose
 * `rows` decide each task's block and state. `apply(editor)` paints (or
 * clears) one editor, `applyAll()` every visible one; both are no-ops for a
 * document that is not a spec's tasks.md. This class reacts to editors
 * appearing and the document being typed in; `activate` calls `applyAll` from
 * the SpecModel watcher and TaskSessionLinks changes too (requirement 4.6,
 * `scheduleTaskUiRefresh`). Without `createTextEditorDecorationType` / `ThemeColor` (the
 * tests' stub) the types are inert and `apply` still computes the ranges.
 */
class SpecTaskDecorations {
  constructor(lenses) {
    this._lenses = lenses;
    this._timers = new Map();
    const make = typeof vscode.window.createTextEditorDecorationType === "function" ? (o) => vscode.window.createTextEditorDecorationType(o) : () => ({ dispose() {} });
    const color = (id) => (typeof vscode.ThemeColor === "function" ? new vscode.ThemeColor(id) : id);
    // Created in TASK_STATES order: where a parent's block and a sub-task's overlap on a
    // line, the editor lets the later-created type's border win, so a sub-task's progress
    // shows over its not-started parent.
    this.types = {};
    for (const s of TASK_STATES) this.types[s] = make({ isWholeLine: true, borderWidth: "0 0 0 2px", borderStyle: "solid", borderColor: color(TASK_DECORATION_COLORS[s]) });
    this.types.optional = make({ isWholeLine: true, opacity: TASK_DECORATION_OPTIONAL_OPACITY });
  }
  /** Whether a document is the tasks.md of a spec (what the lens pattern matches). */
  static decorates(uri) {
    return Boolean(uri && SpecTaskCodeLensProvider.specOf(uri)) && specFileOf(uri.path) === "tasks.md";
  }
  /** The ranges for an editor's document (`taskDecorationRanges` of the lens rows), null when it is not a tasks.md. */
  rangesFor(document) {
    if (!document || !SpecTaskDecorations.decorates(document.uri)) return null;
    return taskDecorationRanges(this._lenses.rows(document.getText(), document.uri));
  }
  apply(editor) {
    const ranges = editor && editor.document ? this.rangesFor(editor.document) : null;
    if (!ranges || typeof editor.setDecorations !== "function") return false;
    const toRange = (r) => (typeof vscode.Range === "function" ? new vscode.Range(r.startLine, 0, r.endLine, 0) : { start: { line: r.startLine, character: 0 }, end: { line: r.endLine, character: 0 } });
    for (const key of Object.keys(this.types)) editor.setDecorations(this.types[key], (ranges[key] || []).map(toRange));
    return true;
  }
  applyAll() {
    for (const editor of vscode.window.visibleTextEditors || []) this.apply(editor);
  }
  /** A document edit: re-apply to its editors after the debounce (several keystrokes collapse into one pass). */
  onDocument(document) {
    if (!document || !SpecTaskDecorations.decorates(document.uri)) return;
    const key = document.uri.toString();
    clearTimeout(this._timers.get(key));
    this._timers.set(key, setTimeout(() => {
      this._timers.delete(key);
      for (const editor of vscode.window.visibleTextEditors || []) if (editor.document && editor.document.uri.toString() === key) this.apply(editor);
    }, TASK_DECORATION_DEBOUNCE_MS));
  }
  dispose() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    for (const key of Object.keys(this.types)) { try { this.types[key].dispose(); } catch { /* already gone */ } }
  }
}

// ---- Spec context keys and the .config.kiro diagnostic
//
// `kirocrew.spec.workflowType` / `kirocrew.spec.specType` carry the active
// spec's configuration into `when` clauses (the title-bar navigation of a
// fast-task or bugfix spec differs from the default). They follow the active
// text editor and are re-read when the spec's `.config.kiro` changes. An
// invalid `.config.kiro` is defaulted silently by `parseSpecConfig`; the one
// place the user learns about it is a warning diagnostic on that file.

const SPEC_CONTEXT_KEYS = { workflowType: "kirocrew.spec.workflowType", specType: "kirocrew.spec.specType" };
const SPEC_CONFIG_DIAGNOSTICS = "kirocrew-spec-config";
const SPEC_CONFIG_KEYS = ["specId", "workflowType", "specType"];

/**
 * The context-key values for an active editor (pure): `{"kirocrew.spec.workflowType":
 * v, "kirocrew.spec.specType": v}` with the config's values when `fsPath` is inside
 * a spec directory (defaults when `config` is null), both `undefined` (unset) outside.
 */
function specContextKeyValues(fsPath, config) {
  const inside = Boolean(specDirOf(fsPath));
  const cfg = inside ? (config || parseSpecConfig(null)) : null;
  return {
    [SPEC_CONTEXT_KEYS.workflowType]: cfg ? cfg.workflowType : undefined,
    [SPEC_CONTEXT_KEYS.specType]: cfg ? cfg.specType : undefined,
  };
}

/** Line/character of a character offset in `text` (clamped to the text). */
function positionAt(text, offset) {
  const s = String(text || "");
  const o = Math.max(0, Math.min(Number(offset) || 0, s.length));
  const before = s.slice(0, o);
  const line = (before.match(/\n/g) || []).length;
  return { line, character: o - (before.lastIndexOf("\n") + 1) };
}

/**
 * The warning for a `.config.kiro` body (pure; `null` when the file is absent
 * or valid): `{message, severity: "warning", source, code, range}` with a
 * plain `{line, character, endLine, endCharacter}` range. A JSON error that
 * names a position is underlined there; a bad field underlines its line; the
 * rest covers the whole document.
 */
function specConfigDiagnostic(text) {
  if (text === null || text === undefined) return null;
  const cfg = parseSpecConfig(text);
  if (!cfg.problem) return null;
  const body = String(text);
  const lines = body.split("\n");
  const last = lines.length - 1;
  let range = { line: 0, character: 0, endLine: last, endCharacter: lines[last].length };
  const pos = /\bposition (\d+)/.exec(cfg.problem);
  if (pos) {
    const at = positionAt(body, Number(pos[1]));
    const lineText = lines[at.line] || "";
    range = { line: at.line, character: at.character, endLine: at.line, endCharacter: Math.max(at.character + 1, lineText.length) };
  } else {
    for (const key of SPEC_CONFIG_KEYS) {
      if (!cfg.problem.includes(key)) continue;
      const i = lines.findIndex((l) => l.includes('"' + key + '"'));
      if (i < 0) continue;
      const start = Math.max(0, lines[i].search(/\S/));
      range = { line: i, character: start, endLine: i, endCharacter: lines[i].replace(/\s+$/, "").length };
      break;
    }
  }
  return { message: cfg.problem, severity: "warning", source: "kirocrew-spec", code: "spec-config", range };
}

/** A `vscode.Diagnostic` from `specConfigDiagnostic`'s plain description. */
function toVscodeDiagnostic(d) {
  const r = d.range;
  const diag = new vscode.Diagnostic(new vscode.Range(r.line, r.character, r.endLine, r.endCharacter), d.message, vscode.DiagnosticSeverity.Warning);
  diag.source = d.source;
  diag.code = d.code;
  return diag;
}

/** A Uri for a spec directory path, in the scheme of the workspace folder containing it (file: when none does). */
function specDirUri(dirPath) {
  const p = String(dirPath || "");
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const root = String(folder.uri.path).replace(/\/+$/, "");
    if (p === root || p.startsWith(root + "/")) return folder.uri.with({ path: p });
  }
  return vscode.Uri.file(p);
}

/**
 * Keeps the two context keys in step with the active text editor and the
 * SpecModel. A refresh reads the spec's model (which re-reads `.config.kiro`
 * after the watcher dropped it); a newer refresh wins over a slower older one.
 * No text editor (a webview is active) leaves the keys as they are, the rule
 * `markSpecEditor` follows, so the spec custom editor keeps its title bar.
 */
class SpecContextKeys {
  constructor(context, store) {
    this._store = store;
    this._applied = {};
    this._activeDir = null;
    this._seq = 0;
    if (context) {
      context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => this.refresh(editor)),
        store.onDidChange((event) => this.onModelChange(event)));
    }
    void this.refresh(vscode.window.activeTextEditor);
  }
  /** A SpecModel change touching the active spec's directory (or every spec) re-reads the keys. */
  onModelChange(event) {
    if (!this._activeDir) return;
    const touched = event.structural || (event.dirs || []).includes(this._activeDir);
    if (touched) void this.refresh(vscode.window.activeTextEditor);
  }
  async refresh(editor) {
    if (!editor || !editor.document) return;
    const path = editor.document.uri.path;
    const dir = specDirOf(path);
    this._activeDir = dir;
    const seq = ++this._seq;
    let config = null;
    if (dir) {
      try { const model = await this._store.forDocument(editor.document.uri); config = model ? model.config : null; } catch { config = null; }
      if (seq !== this._seq) return;
    }
    this.apply(specContextKeyValues(path, config));
  }
  /** Set each key whose value differs from the last one applied. */
  apply(values) {
    for (const [key, value] of Object.entries(values)) {
      if (Object.prototype.hasOwnProperty.call(this._applied, key) && this._applied[key] === value) continue;
      this._applied[key] = value;
      void vscode.commands.executeCommand("setContext", key, value);
    }
  }
}

/**
 * Publishes the `.config.kiro` warning: every spec is checked at activation,
 * the touched ones again on each SpecModel change (a removed spec drops its
 * entry since its file reads as absent); a structural change rescans.
 */
class SpecConfigDiagnostics {
  constructor(context, store) {
    this.collection = vscode.languages.createDiagnosticCollection(SPEC_CONFIG_DIAGNOSTICS);
    if (context) context.subscriptions.push(this.collection, store.onDidChange((event) => this.onModelChange(event)));
    void this.scanAll();
  }
  async onModelChange(event) {
    if (event.structural) { this.collection.clear(); return this.scanAll(); }
    for (const dir of event.dirs || []) await this.check(specDirUri(dir));
  }
  async scanAll() {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const root = vscode.Uri.joinPath(folder.uri, ".kiro", "specs");
      let entries = [];
      try { entries = await vscode.workspace.fs.readDirectory(root); } catch { continue; }
      for (const [name, kind] of entries) if (kind === vscode.FileType.Directory) await this.check(vscode.Uri.joinPath(root, name));
    }
  }
  /** Set or clear the warning on one spec directory's `.config.kiro`. */
  async check(dir) {
    const uri = vscode.Uri.joinPath(dir, SPEC_CONFIG_FILE);
    let d = null;
    try { d = specConfigDiagnostic(await readWholeText(uri)); } catch { d = null; }
    if (d) this.collection.set(uri, [toVscodeDiagnostic(d)]); else this.collection.delete(uri);
  }
}

// ---- Task format diagnostics (requirement 5.1, 5.3)
//
// Kiro's Task Orchestrator reads tasks.md with the grammar `parseTaskLine`
// ports, and silently drops what does not fit: a `- [o]` box is not a task, an
// unnumbered task hangs off whatever indent it has, a repeated number makes two
// tasks one. The warnings below flag those lines while the file is open so the
// plan is fixed before a run mis-parses it. They scan the buffer line by line
// with a looser shape than the parser's (any box content, any title), so a
// line the parser would skip still gets its warning. The nesting rule reads a
// task's level from its number (`1.2` is level 2, the hierarchy the parser
// builds from numbers) and, for an unnumbered line, from its indent at the two
// spaces per level Kiro writes. Each issue carries the line's pieces (indent,
// box, number, title, level, parent) so the "Fix task line" action can rewrite
// the line without re-parsing it.

const SPEC_TASK_DIAGNOSTICS = "kirocrew-spec";
/** The rule ids, each the `code` of its diagnostic. */
const TASK_FORMAT_RULES = ["box", "number-missing", "number-format", "nesting", "duplicate"];
/** Box characters the parser accepts (`X` reads as `x`, as in `parseTaskLine`). */
const TASK_FORMAT_BOXES = [" ", "~", "-", "x", "X"];
const TASK_FORMAT_INDENT = 2;
const TASK_NUMBER_SHAPE = /^\d+(\.\d+)*$/;
/** Typing in tasks.md re-checks the lines after this pause. */
const TASK_DIAGNOSTICS_DEBOUNCE_MS = 150;
/**
 * A task-shaped line: bullet, `[box]` with any content, an optional `*`, then
 * the title after whitespace (or nothing). Wider than `parseTaskLine` on
 * purpose; a `- [text](url)` link does not match because `(` follows the `]`.
 */
const TASK_FORMAT_LINE = /^(\s*)[-*+]\s+\[([^\]\n]*)\](\\?\*?)(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * The format issues of a tasks.md body (pure): `[{ line, startCol, endCol,
 * rule, message, indent, box, optional, number, title, level, parent, text }]`
 * in line order, one entry per rule a line breaks. `rule` is one of
 * TASK_FORMAT_RULES: `box` (content not in TASK_FORMAT_BOXES), `number-missing`
 * (the title does not start with a number), `number-format` (it starts with a
 * digit but not `^\d+(\.\d+)*$`), `nesting` (the level is more than one deeper
 * than the previous task line's; the first task line counts from level 0) and
 * `duplicate` (a number already used). `number` is the normalised number
 * ("1." → "1") or null; `title` the text after it (the whole text when there
 * is no number); `level` the line's level; `parent` the number this line hangs
 * under (the number minus its last segment, or the last number seen one level
 * up), null at the top. A file without task lines yields `[]` (requirement 5.3).
 */
function taskFormatIssues(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const seen = new Map(); // number → first line
  const lastAtLevel = new Map(); // level → last valid number seen there
  let prevLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(TASK_FORMAT_LINE);
    if (!m) continue;
    const indent = m[1].length;
    const box = m[2];
    const optional = m[3] === "*" || m[3] === "\\*";
    const boxStart = line.indexOf("[", indent);
    const boxEnd = boxStart + box.length + 2;
    const afterMark = boxEnd + m[3].length;
    const titleStart = afterMark + (line.slice(afterMark).match(/^[ \t]*/) || [""])[0].length;
    const body = m[4] || "";
    const lineEnd = line.replace(/[ \t]+$/, "").length;

    // The number, read as the parser reads it (`1.2 Title`, `1. Title`, `1.Title`).
    let number = null;
    let numberToken = "";
    let title = body;
    let numberRule = null;
    const parsed = body ? taskNumberOf(body) : null;
    if (parsed) {
      number = parsed;
      numberToken = (body.match(/^\d+(?:\.\d+)*\.?/) || [parsed])[0];
      title = body.slice(numberToken.length).trim();
    } else {
      const first = (body.match(/^\S+/) || [""])[0];
      if (/^\d/.test(first)) { numberRule = "number-format"; numberToken = first; title = body.slice(first.length).trim(); }
      else numberRule = "number-missing";
    }
    const level = number ? number.split(".").length : Math.floor(indent / TASK_FORMAT_INDENT) + 1;
    const parent = number
      ? (level > 1 ? number.slice(0, number.lastIndexOf(".")) : null)
      : (level > 1 ? lastAtLevel.get(level - 1) || null : null);
    const base = { line: i, indent, box, optional, number, title, level, parent, text: line };
    const issue = (rule, startCol, endCol, message) => out.push({ ...base, rule, message, startCol, endCol: Math.max(endCol, startCol + 1) });

    if (!TASK_FORMAT_BOXES.includes(box)) issue("box", boxStart, boxEnd, "Task box \"[" + box + "]\" is not one of [ ], [~], [-], [x]");
    if (numberRule === "number-missing") issue("number-missing", body ? titleStart : boxStart, body ? lineEnd : boxEnd, "Task line has no number (expected N or N.M before the title)");
    else if (numberRule === "number-format") issue("number-format", titleStart, titleStart + numberToken.length, "Task number \"" + numberToken + "\" is not of the form N or N.M");
    if (level > prevLevel + 1) issue("nesting", indent, lineEnd, "Task nesting jumps from level " + prevLevel + " to level " + level + " (one level at a time)");
    if (number) {
      if (seen.has(number)) issue("duplicate", titleStart, titleStart + numberToken.length, "Task number \"" + number + "\" is already used (line " + (seen.get(number) + 1) + ")");
      else { seen.set(number, i); lastAtLevel.set(level, number); }
    }
    prevLevel = level;
  }
  return out;
}

/** A `vscode.Diagnostic` (Warning, `code` the rule, `source` kirocrew-spec) for one issue; a plain object without the host's classes. */
function toTaskDiagnostic(issue) {
  const range = typeof vscode.Range === "function"
    ? new vscode.Range(issue.line, issue.startCol, issue.line, issue.endCol)
    : { start: { line: issue.line, character: issue.startCol }, end: { line: issue.line, character: issue.endCol } };
  const severity = vscode.DiagnosticSeverity ? vscode.DiagnosticSeverity.Warning : 1;
  const diag = typeof vscode.Diagnostic === "function" ? new vscode.Diagnostic(range, issue.message, severity) : { range, message: issue.message, severity };
  diag.source = SPEC_TASK_DIAGNOSTICS;
  diag.code = issue.rule;
  return diag;
}

/** The host's DiagnosticCollection, or a Map-backed stand-in with the same surface when the host (the tests' stub) has none. */
function createDiagnosticCollection(name) {
  if (vscode.languages && typeof vscode.languages.createDiagnosticCollection === "function") return vscode.languages.createDiagnosticCollection(name);
  const map = new Map();
  const key = (uri) => String(uri && uri.toString ? uri.toString() : uri);
  return {
    name,
    set(uri, list) { if (list && list.length) map.set(key(uri), list.slice()); else map.delete(key(uri)); },
    delete(uri) { map.delete(key(uri)); },
    get(uri) { return map.get(key(uri)); },
    has(uri) { return map.has(key(uri)); },
    clear() { map.clear(); },
    forEach(fn) { for (const [k, v] of map) fn(k, v, this); },
    dispose() { map.clear(); },
  };
}

/**
 * Publishes `taskFormatIssues` on every open spec tasks.md as warnings in the
 * `kirocrew-spec` collection (separate from the `.config.kiro` one). It reads
 * the editor buffer, not the disk: the documents open at construction are
 * checked at once, an opened document on open, a typed-in one after
 * TASK_DIAGNOSTICS_DEBOUNCE_MS, and a closed one drops its entry. A document
 * without issues (no task lines included) has no entry at all.
 */
class SpecTaskDiagnostics {
  constructor(context) {
    this.collection = createDiagnosticCollection(SPEC_TASK_DIAGNOSTICS);
    this._timers = new Map();
    if (context) {
      context.subscriptions.push(
        this,
        vscode.workspace.onDidOpenTextDocument((document) => this.update(document)),
        vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument((document) => this.clear(document.uri)));
    }
    for (const document of vscode.workspace.textDocuments || []) this.update(document);
  }
  /** Whether a document is a spec's tasks.md (the lens pattern's match). */
  static checks(uri) { return SpecTaskDecorations.decorates(uri); }
  /** Check one document now; `false` when it is not a spec tasks.md. */
  update(document) {
    if (!document || !SpecTaskDiagnostics.checks(document.uri)) return false;
    const key = document.uri.toString();
    clearTimeout(this._timers.get(key));
    this._timers.delete(key);
    const issues = taskFormatIssues(document.getText());
    if (issues.length) this.collection.set(document.uri, issues.map(toTaskDiagnostic)); else this.collection.delete(document.uri);
    return true;
  }
  /** A document edit: re-check after the debounce (keystrokes collapse into one pass). */
  schedule(document) {
    if (!document || !SpecTaskDiagnostics.checks(document.uri)) return;
    const key = document.uri.toString();
    clearTimeout(this._timers.get(key));
    this._timers.set(key, setTimeout(() => { this._timers.delete(key); this.update(document); }, TASK_DIAGNOSTICS_DEBOUNCE_MS));
  }
  /** Drop a document's warnings (and any pending check). */
  clear(uri) {
    if (!uri) return;
    const key = uri.toString();
    clearTimeout(this._timers.get(key));
    this._timers.delete(key);
    this.collection.delete(uri);
  }
  dispose() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    try { this.collection.dispose(); } catch { /* already gone */ }
  }
}

// ---- "Fix task line" (requirement 5.2)
//
// The quick fix for the warnings above rewrites one line to the nearest valid
// form and leaves its title alone: a box the parser does not read becomes
// `[ ]` (the `*` optional marker stays), and a missing, malformed or repeated
// number becomes the parent's number plus the next free index — the parent
// `taskFormatIssues` resolved for the line, the index one above the highest
// sibling already in the file, so fixing two unnumbered lines under the same
// parent one after the other gives `2.3` then `2.4`. Top-level numbers follow
// the file's own style (`3.` as Kiro writes them, `3` when the file writes
// them bare); nested ones are always `N.M`. A nesting jump has no safe
// automatic fix (the line could belong at any of several levels), so that rule
// leaves the line as it is — the box and number on it are still fixed.

const TASK_FIX_TITLE = "Fix task line";
/** The rules the fix rewrites the number for. */
const TASK_FIX_NUMBER_RULES = ["number-missing", "number-format", "duplicate"];

/**
 * The valid task numbers of a tasks.md body with, per number, its parent
 * (the number minus its last segment, null at the top) and whether a
 * top-level number was written with a trailing dot (`3.`); pure.
 */
function taskNumbersOf(lines) {
  const numbers = [];
  for (const line of lines) {
    const m = line.match(TASK_FORMAT_LINE);
    if (!m || !m[4]) continue;
    const number = taskNumberOf(m[4]);
    if (!number || !TASK_NUMBER_SHAPE.test(number)) continue;
    const token = (m[4].match(/^\d+(?:\.\d+)*\.?/) || [number])[0];
    const dot = number.lastIndexOf(".");
    numbers.push({ number, parent: dot < 0 ? null : number.slice(0, dot), trailingDot: token.endsWith(".") });
  }
  return numbers;
}

/**
 * The fix for the task line at `lineIndex` of `text` (pure): `{ newLine,
 * changed }`, `changed` the rules the rewrite addressed (a subset of
 * TASK_FORMAT_RULES minus `nesting`), `[]` with the line unchanged when there
 * is nothing to fix on it. `issues` is `taskFormatIssues(text)` when given
 * (the caller usually has it); the line's indent, bullet, optional marker and
 * title are kept byte for byte, only the box content and the number token
 * change.
 */
function fixTaskLine(text, lineIndex, issues) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const line = lines[lineIndex];
  if (typeof line !== "string") return { newLine: "", changed: [] };
  const mine = (issues || taskFormatIssues(text)).filter((i) => i.line === lineIndex);
  const m = line.match(TASK_FORMAT_LINE);
  if (!mine.length || !m) return { newLine: line, changed: [] };
  const base = mine[0];
  const rules = new Set(mine.map((i) => i.rule));
  const changed = [];
  let out = line;

  // The number first, so the box offsets below are read off the original line's prefix.
  const numberRule = TASK_FIX_NUMBER_RULES.find((rule) => rules.has(rule));
  if (numberRule) {
    const numbers = taskNumbersOf(lines);
    const parent = base.parent || null;
    const siblings = numbers.filter((n) => n.parent === parent);
    const next = siblings.reduce((max, n) => Math.max(max, Number(n.number.slice(n.number.lastIndexOf(".") + 1))), 0) + 1;
    let token;
    if (parent) token = parent + "." + next;
    else {
      const top = numbers.filter((n) => n.parent === null);
      const bare = top.filter((n) => !n.trailingDot).length;
      token = String(next) + (bare > top.length - bare ? "" : ".");
    }
    const boxEnd = line.indexOf("[", base.indent) + base.box.length + 2;
    const afterMark = boxEnd + m[3].length;
    const body = m[4] || "";
    const bodyStart = body ? line.indexOf(body, afterMark) : -1;
    const sep = body ? line.slice(afterMark, bodyStart) : " ";
    const trail = body ? line.slice(bodyStart + body.length) : "";
    out = line.slice(0, afterMark) + sep + token + (base.title ? " " + base.title : "") + trail;
    changed.push(numberRule);
  }
  if (rules.has("box")) {
    const boxStart = out.indexOf("[", base.indent);
    out = out.slice(0, boxStart) + "[ ]" + out.slice(boxStart + base.box.length + 2);
    changed.push("box");
  }
  return { newLine: out, changed };
}

/** Whether two ranges (the host's or plain `{ start, end }` objects) share at least a position. */
function rangesIntersect(a, b) {
  if (!a || !b) return false;
  const before = (p, q) => p.line < q.line || (p.line === q.line && p.character < q.character);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/**
 * One "Fix task line" quick fix for the line of a `kirocrew-spec` warning:
 * replaces the whole line with `fixTaskLine`'s `newLine`, carries the line's
 * diagnostics the rewrite addresses and is preferred (auto-fix picks it). A
 * plain object with the same fields when the host (the tests' stub) has no
 * `CodeAction` / `WorkspaceEdit`.
 */
function taskFixAction(document, lineIndex, oldLine, newLine, diagnostics) {
  const range = typeof vscode.Range === "function"
    ? new vscode.Range(lineIndex, 0, lineIndex, oldLine.length)
    : { start: { line: lineIndex, character: 0 }, end: { line: lineIndex, character: oldLine.length } };
  const kind = vscode.CodeActionKind && vscode.CodeActionKind.QuickFix ? vscode.CodeActionKind.QuickFix : "quickfix";
  const action = typeof vscode.CodeAction === "function" ? new vscode.CodeAction(TASK_FIX_TITLE, kind) : { title: TASK_FIX_TITLE, kind };
  let edit;
  if (typeof vscode.WorkspaceEdit === "function") edit = new vscode.WorkspaceEdit();
  else {
    const edits = [];
    edit = { replace(uri, r, newText) { edits.push({ uri, range: r, newText }); }, entries: () => edits.map((e) => [e.uri, [{ range: e.range, newText: e.newText }]]) };
  }
  edit.replace(document.uri, range, newLine);
  action.edit = edit;
  action.diagnostics = diagnostics;
  action.isPreferred = true;
  return action;
}

/**
 * The code action provider on a spec's tasks.md (TASK_LENS_PATTERN): for the
 * `kirocrew-spec` diagnostics of the request that touch the range, one
 * "Fix task line" per line (a line with a bad box and a missing number gets a
 * single action that fixes both), none for a line the fix would not change
 * (a lone nesting warning).
 */
class SpecTaskFixProvider {
  provideCodeActions(document, range, context) {
    const diagnostics = ((context && context.diagnostics) || []).filter((d) => d && d.source === SPEC_TASK_DIAGNOSTICS && d.range && (!range || rangesIntersect(d.range, range)));
    if (!diagnostics.length || !document || typeof document.getText !== "function") return [];
    const text = document.getText();
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const issues = taskFormatIssues(text);
    const byLine = new Map();
    for (const d of diagnostics) {
      const line = d.range.start.line;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(d);
    }
    const actions = [];
    for (const [line, list] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
      const fix = fixTaskLine(text, line, issues);
      if (!fix.changed.length) continue;
      const fixed = list.filter((d) => fix.changed.includes(d.code));
      actions.push(taskFixAction(document, line, lines[line] || "", fix.newLine, fixed.length ? fixed : list));
    }
    return actions;
  }
}

// ---- Requirement hovers (requirement 6.1, 1.4)
//
// Resting the pointer on a `_Requirements: 2.1, 2.2, 1_` line of any spec
// document shows, per referenced requirement, its heading (a command link
// that opens the requirements document — bugfix.md for a bugfix spec — at
// that heading), its user story and the referenced criterion, or every
// criterion when the reference has no sub-number. The pure parts are
// `requirementRefsAt` (which references a line carries and which one the
// cursor is on) and `requirementHoverMarkdown` (one reference's markdown);
// `SpecRequirementHoverProvider` wires them to the editor through a list of
// resolvers, each `{ matches(lineText), hover(ctx) }`, so the property hover
// (requirement 6.2) is one more entry rather than a change to this one.

const SPEC_HOVER_PATTERN = "**/.kiro/specs/*/*.md";
const REVEAL_REQUIREMENT_COMMAND = "kirocrew.spec.revealRequirement";
/** The `Requirements:` label of a reference line (`_Requirements: …_`, `- _Requirements: …_`, `**Requirements:** …`). */
const REQUIREMENTS_LABEL = /(?<![A-Za-z0-9])Requirements?\s*:/i;
/** Number references and emphasis runs after the label: `1.2`, `3`, and the `_` / `**` that opens or closes the list. */
const REQUIREMENTS_TOKEN = /\d+(?:\.\d+)*|[_*]+/g;

/**
 * The requirement references of one line (pure), or null when the line has no
 * `Requirements:` label: `{ label: {start, end}, refs, active }`. Each ref is
 * `{ text, start, end, req, criterion }` — `req` the requirement number
 * ("2" of "2.1"), `criterion` the sub-number ("1") or null for a whole
 * requirement. `active` holds the ref under `character` (its start..end,
 * inclusive) or every ref when the cursor is on the label or anywhere else on
 * the line (no character → every ref). The list ends at the emphasis that
 * closes it (`_Requirements: 1.1, 1.3_ and 2 more` → 1.1, 1.3); an emphasis
 * before the first number is the label's own closing (`**Requirements:** 1.1`).
 * A `_Requirements: none_` line has a label and no refs.
 */
function requirementRefsAt(lineText, character) {
  const line = String(lineText || "");
  const m = REQUIREMENTS_LABEL.exec(line);
  if (!m) return null;
  const label = { start: m.index, end: m.index + m[0].length };
  const refs = requirementRefsAfter(line, label.end);
  return { label, refs, active: activeRefs(refs, character) };
}

/** The requirement refs (`requirementRefsAt`'s shape) of `line` from column `from` to the emphasis that closes the list. */
function requirementRefsAfter(line, from) {
  const rest = String(line || "").slice(from);
  const refs = [];
  REQUIREMENTS_TOKEN.lastIndex = 0;
  for (let t; (t = REQUIREMENTS_TOKEN.exec(rest));) {
    if (/^[_*]/.test(t[0])) { if (refs.length) break; continue; }
    const parts = t[0].match(/^(\d+)(?:\.(\d+(?:\.\d+)*))?$/);
    refs.push({ text: t[0], start: from + t.index, end: from + t.index + t[0].length, req: parts[1], criterion: parts[2] || null });
  }
  return refs;
}

/** The ref whose `start..end` (inclusive) holds `character` as a one-entry list, or every ref when the cursor is elsewhere (or absent). */
function activeRefs(refs, character) {
  const at = Number.isInteger(character) ? refs.find((r) => character >= r.start && character <= r.end) : null;
  return at ? [at] : refs.slice();
}

/** `[` and `]` escaped so a heading can sit inside a markdown link's text. */
const mdLinkText = (s) => String(s || "").replace(/([[\]])/g, "\\$1");

/** The `command:` URI the hover's heading links to: `{ dir, file, req }` for `kirocrew.spec.revealRequirement`. */
function revealRequirementUri(args) {
  return "command:" + REVEAL_REQUIREMENT_COMMAND + "?" + encodeURIComponent(JSON.stringify(args || {}));
}

/**
 * The hover markdown of one reference (pure). `ref` is a `requirementRefsAt`
 * entry (or `{ req, criterion }`), `requirement` the parsed requirement it
 * points at (`findRequirement(...).requirement`, null when absent), `ctx`
 * `{ feature, dir, file }` — `dir` the spec directory path and `file` the
 * document the requirements came from (`bugfix.md` for a bugfix spec). The
 * first line is the heading as a `[**Requirement N: Title**](command:…)`
 * link, then the user story in italics, then the referenced criterion
 * (`**N.M** text`) or every criterion as a list when the reference has no
 * sub-number. A missing requirement yields `Requirement N not found in
 * <file>`; a missing criterion keeps the heading and story and says so.
 */
function requirementHoverMarkdown(ref, requirement, ctx) {
  const r = ref || {};
  const c = ctx || {};
  const file = c.file || "requirements.md";
  const req = String(r.req !== undefined && r.req !== null ? r.req : String(r.text || "").split(".")[0]);
  if (!requirement) return "Requirement " + req + " not found in `" + file + "`";
  const title = requirement.title ? "Requirement " + requirement.number + ": " + requirement.title : "Requirement " + requirement.number;
  const parts = ["[**" + mdLinkText(title) + "**](" + revealRequirementUri({ dir: c.dir || null, file, req: requirement.number }) + ")"];
  if (requirement.userStory || requirement.story) parts.push("*" + (requirement.userStory || requirement.story) + "*");
  const criteria = requirement.criteria || [];
  if (r.criterion) {
    const criterion = criteria.find((x) => x.number === String(r.criterion)) || null;
    parts.push(criterion ? "**" + criterion.ref + "** " + criterion.text : "Criterion " + requirement.number + "." + r.criterion + " not found in `" + file + "`");
  } else if (criteria.length) {
    parts.push(criteria.map((x) => "- **" + x.ref + "** " + x.text).join("\n"));
  }
  return parts.join("\n\n");
}

/** A trusted MarkdownString (so `command:` links work), or a plain `{ value, isTrusted }` without the editor API (the tests' stub). */
function hoverMarkdown(text) {
  if (typeof vscode.MarkdownString === "function") {
    const md = new vscode.MarkdownString(String(text || ""));
    md.isTrusted = true;
    md.supportThemeIcons = true;
    return md;
  }
  return { value: String(text || ""), isTrusted: true };
}

/** A Hover over `line` from `start` to `end`, with plain-object fallbacks when the editor API is absent. */
function makeHover(markdown, line, start, end) {
  const range = typeof vscode.Range === "function" ? new vscode.Range(line, start, line, end) : { start: { line, character: start }, end: { line, character: end } };
  return typeof vscode.Hover === "function" ? new vscode.Hover(markdown, range) : { contents: [markdown], range };
}

/**
 * The `_Requirements: …_` resolver: `matches` is true on a line with the
 * label that is not a `Validates:` line (that one belongs to the property
 * hover); `hover` returns `{ markdown, start, end }` for the refs under the
 * cursor (joined with a rule when there are several) — `start..end` is the
 * single ref, or the label through the last ref — or null with no refs.
 * `ctx` is `{ line, character, spec: {name, dir}, model }`.
 */
const requirementHoverResolver = {
  matches(lineText) { return REQUIREMENTS_LABEL.test(String(lineText || "")) && !VALIDATES_LINE.test(String(lineText || "")); },
  hover(ctx) {
    const at = requirementRefsAt(ctx.line, ctx.character);
    if (!at || !at.active.length) return null;
    const model = ctx.model || null;
    const spec = ctx.spec || {};
    const dir = spec.dir && spec.dir.path !== undefined ? spec.dir.path : spec.dir || null;
    const file = model && model.requirementsFile ? model.requirementsFile : requirementsFileOf(model && model.config);
    const info = { feature: spec.name || "", dir, file };
    const requirements = model ? model.requirements || [] : [];
    const markdown = at.active.map((ref) => requirementHoverMarkdown(ref, findRequirement(requirements, ref.text).requirement, info)).join("\n\n---\n\n");
    const start = at.active.length === 1 ? at.active[0].start : Math.min(at.label.start, at.active[0].start);
    const end = at.active[at.active.length - 1].end;
    return { markdown, start, end };
  },
};

// ---- Property hovers (requirement 6.2)
//
// Resting the pointer on a `_Property N_` / `**Property N**` / `Property N:`
// reference in any spec document shows the property's title from design.md's
// "Correctness Properties" section and the criteria it validates; on a
// `Validates: Requirements …` line inside a property block the same hover
// shows that block's property. Each validated criterion is a reveal link into
// the requirements document (`kirocrew.spec.revealRequirement`, as the
// requirement hover's heading) followed by its text. Pure parts:
// `propertyRefsAt` and `propertyHoverMarkdown`; `propertyHoverResolver` is
// the provider's second resolver.

const PROPERTY_HOVER_FILE = "design.md";
/** Every `Property N` reference of a line (the number is group 1); no `\b` after the number, so `_Property 1_` closes on the `_`. */
const PROPERTY_REFS = /(?<![A-Za-z0-9])Property\s+(\d+(?:\.\d+)*)/gi;
/** Whether a line carries any `Property N` reference. */
const PROPERTY_REF_LINE = /(?<![A-Za-z0-9])Property\s+\d/i;
/** The `Validates:` label of a property's criteria line, through an optional `Requirements` word (`**Validates: Requirements 1.2**`, `_Validates: 1.2_`). */
const VALIDATES_LABEL = /(?<![A-Za-z0-9])Validates\s*:?(?:\s*[*_]{1,2})?(?:\s*Requirements?\s*:?)?/i;

/**
 * The property references of one line (pure), or null when it has none:
 * `{ kind, label, refs, active }`. `kind` is `"validates"` on a `Validates:
 * Requirements 1.2, 3.4` line — `label` the `Validates: Requirements` span
 * and each ref a requirement ref in `requirementRefsAt`'s shape (`{ text,
 * start, end, req, criterion }`) — or `"property"` on a line with `Property
 * N` references (`_Property 3_`, `**Property 3**`, `### Property 3: Title`),
 * `label` null and each ref `{ text: "3", number: "3", start, end }` spanning
 * the words `Property 3`. `active` holds the ref under `character` or every
 * ref when the cursor is elsewhere on the line (no character → every ref).
 */
function propertyRefsAt(lineText, character) {
  const line = String(lineText || "");
  if (VALIDATES_LINE.test(line)) {
    const m = VALIDATES_LABEL.exec(line);
    const label = m ? { start: m.index, end: m.index + m[0].length } : { start: 0, end: 0 };
    const refs = requirementRefsAfter(line, label.end);
    return { kind: "validates", label, refs, active: activeRefs(refs, character) };
  }
  const refs = [];
  PROPERTY_REFS.lastIndex = 0;
  for (let t; (t = PROPERTY_REFS.exec(line));) refs.push({ text: t[1], number: t[1], start: t.index, end: t.index + t[0].length });
  if (!refs.length) return null;
  return { kind: "property", label: null, refs, active: activeRefs(refs, character) };
}

/**
 * The hover markdown of one property reference (pure). `ref` is `{ number }`
 * (or `{ text }`, a `propertyRefsAt` entry), `property` the parsed property
 * (`findProperty(model.properties, N)`, null when absent),
 * `requirementsLookup` the parsed requirements array (or a function `ref →
 * findRequirement(...)`'s result) the `Validates:` refs resolve against, and
 * `ctx` `{ feature, dir, file }` as for `requirementHoverMarkdown` (`file` the
 * requirements document the criteria live in). The first line is `**Property
 * N: Title**`, then `Validates:` with one list entry per validated reference:
 * a criterion as `[**N.M**](command:…) text` (the link reveals requirement N),
 * a whole requirement as its linked heading with its criteria nested under
 * it, a reference to nothing as `**N.M** Requirement N not found in <file>`.
 * A property without a `Validates:` line says so; a missing property yields
 * `Property N not found in design.md`.
 */
function propertyHoverMarkdown(ref, property, requirementsLookup, ctx) {
  const r = ref || {};
  const c = ctx || {};
  const file = c.file || "requirements.md";
  const number = String(r.number !== undefined && r.number !== null ? r.number : r.text || "");
  if (!property) return "Property " + number + " not found in `" + PROPERTY_HOVER_FILE + "`";
  const lookup = typeof requirementsLookup === "function" ? requirementsLookup : (x) => findRequirement(requirementsLookup, x);
  const link = (text, req) => "[**" + mdLinkText(text) + "**](" + revealRequirementUri({ dir: c.dir || null, file, req }) + ")";
  const parts = ["**" + (property.title ? "Property " + property.number + ": " + property.title : "Property " + property.number) + "**"];
  const validates = Array.isArray(property.validates) ? property.validates : [];
  if (!validates.length) {
    parts.push("*No `Validates:` line for this property in `" + PROPERTY_HOVER_FILE + "`*");
    return parts.join("\n\n");
  }
  const rows = validates.map((text) => {
    const m = String(text).match(/^(\d+)(?:\.(\d+(?:\.\d+)*))?$/);
    const found = lookup(text) || {};
    const requirement = found.requirement || null;
    if (!requirement) return "- **" + text + "** Requirement " + (m ? m[1] : text) + " not found in `" + file + "`";
    if (m && m[2]) {
      const criterion = found.criterion || (requirement.criteria || []).find((x) => x.number === m[2]) || null;
      return "- " + link(text, requirement.number) + " " + (criterion ? criterion.text : "Criterion " + text + " not found in `" + file + "`");
    }
    const title = requirement.title ? "Requirement " + requirement.number + ": " + requirement.title : "Requirement " + requirement.number;
    return ["- " + link(title, requirement.number)].concat((requirement.criteria || []).map((x) => "  - **" + x.ref + "** " + x.text)).join("\n");
  });
  parts.push("Validates:\n" + rows.join("\n"));
  return parts.join("\n\n");
}

/** The property whose block holds line `line` of design.md (the nearest `Property N` entry at or above it), or null. */
function propertyAtLine(properties, line) {
  let found = null;
  for (const p of properties || []) if (Number.isInteger(p.line) && p.line <= line && (!found || p.line > found.line)) found = p;
  return found;
}

/**
 * The property resolver: `matches` is true on a `Validates:` line or a line
 * with a `Property N` reference; `hover` returns `{ markdown, start, end }`.
 * On a `Validates:` line of design.md the hover is the enclosing property's
 * (title and criteria) over the label through the last ref; a `Validates:`
 * line elsewhere (or above the first property) falls back to the requirement
 * hover of each ref under the cursor. On `Property N` references the hover is
 * one `propertyHoverMarkdown` per active ref, joined with a rule, over the
 * reference(s). `ctx` is `{ line, character, spec: {name, dir}, model,
 * document, position }`.
 */
const propertyHoverResolver = {
  matches(lineText) { const line = String(lineText || ""); return VALIDATES_LINE.test(line) || PROPERTY_REF_LINE.test(line); },
  hover(ctx) {
    const at = propertyRefsAt(ctx.line, ctx.character);
    if (!at || !at.active.length) return null;
    const model = ctx.model || null;
    const spec = ctx.spec || {};
    const dir = spec.dir && spec.dir.path !== undefined ? spec.dir.path : spec.dir || null;
    const file = model && model.requirementsFile ? model.requirementsFile : requirementsFileOf(model && model.config);
    const info = { feature: spec.name || "", dir, file };
    const requirements = model ? model.requirements || [] : [];
    const properties = model ? model.properties || [] : [];
    const start = at.active.length === 1 ? at.active[0].start : Math.min(at.label ? at.label.start : at.active[0].start, at.active[0].start);
    const end = at.active[at.active.length - 1].end;
    if (at.kind === "validates") {
      const uri = ctx.document && ctx.document.uri;
      const inDesign = uri && specFileOf(uri.path) === PROPERTY_HOVER_FILE;
      const lineNo = ctx.position ? ctx.position.line : null;
      const property = inDesign && Number.isInteger(lineNo) ? propertyAtLine(properties, lineNo) : null;
      if (property) return { markdown: propertyHoverMarkdown({ number: property.number }, property, requirements, info), start: at.label.start, end };
      const markdown = at.active.map((ref) => requirementHoverMarkdown(ref, findRequirement(requirements, ref.text).requirement, info)).join("\n\n---\n\n");
      return { markdown, start, end };
    }
    const markdown = at.active.map((ref) => propertyHoverMarkdown(ref, findProperty(properties, ref.number), requirements, info)).join("\n\n---\n\n");
    return { markdown, start, end };
  },
};

/**
 * The hover provider for `SPEC_HOVER_PATTERN`. `options.models()` returns the
 * SpecModelStore to read (default: the activation's; with none the spec is
 * loaded directly), `options.resolvers` the resolver list (default:
 * `[requirementHoverResolver, propertyHoverResolver]`, in that order). On a
 * line the first matching resolver claims, the spec's model supplies the
 * requirements (`bugfix.md`'s for a bugfix spec, requirement 1.4) and the
 * resolver's markdown becomes a trusted Hover over the reference.
 */
class SpecRequirementHoverProvider {
  constructor(options) {
    const o = options || {};
    this._models = typeof o.models === "function" ? o.models : () => specModelStore();
    this.resolvers = Array.isArray(o.resolvers) ? o.resolvers.slice() : [requirementHoverResolver, propertyHoverResolver];
  }
  /** The spec's model from the store, or loaded directly without one; null when it cannot be read. */
  async modelFor(spec) {
    try {
      const store = this._models();
      return store && typeof store.get === "function" ? await store.get(spec.dir, spec.name) : await loadSpecModel(spec.dir, spec.name);
    } catch { return null; }
  }
  /** The text of `document`'s line `line` (lineAt when the document has it, the split text otherwise). */
  static lineText(document, line) {
    if (typeof document.lineAt === "function") { try { return document.lineAt(line).text; } catch { return ""; } }
    return mdLines(typeof document.getText === "function" ? document.getText() : "")[line] || "";
  }
  async provideHover(document, position) {
    if (!document || !position) return null;
    const spec = SpecTaskCodeLensProvider.specOf(document.uri);
    if (!spec) return null;
    const line = SpecRequirementHoverProvider.lineText(document, position.line);
    const resolver = this.resolvers.find((r) => r && typeof r.matches === "function" && r.matches(line));
    if (!resolver) return null;
    const model = await this.modelFor(spec);
    const hit = await resolver.hover({ line, character: position.character, spec, model, document, position });
    if (!hit || !hit.markdown) return null;
    return makeHover(hoverMarkdown(hit.markdown), position.line, hit.start, hit.end);
  }
}

/**
 * `kirocrew.spec.revealRequirement` (`{ dir, file, req }`, the hover link's
 * arguments): open the spec's requirements document — `file` when given,
 * else `requirementsFileOf` its `.config.kiro` — and select its `###
 * Requirement <req>` heading line, scrolled to the centre. Returns the editor
 * (null when the arguments name no spec); a document without that heading
 * still opens, with a status-bar note.
 */
async function revealRequirement(arg) {
  const a = arg || {};
  const dirPath = a.dir && a.dir.path !== undefined ? a.dir.path : a.dir;
  if (!dirPath) { void vscode.window.showWarningMessage("No spec to reveal the requirement in."); return null; }
  const dir = specDirUri(String(dirPath));
  const file = a.file || requirementsFileOf(await readSpecConfig(dir));
  const uri = vscode.Uri.joinPath(dir, file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const { requirement } = findRequirement(parseRequirements(doc.getText()), String(a.req !== undefined && a.req !== null ? a.req : ""));
  if (!requirement) {
    if (a.req !== undefined && a.req !== null) void vscode.window.setStatusBarMessage("Requirement " + a.req + " not found in " + file, 4000);
    return editor;
  }
  const range = doc.lineAt(requirement.line).range;
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  return editor;
}

// ---- Spec title-bar navigation
//
// A spec document open in the text editor shows the spec's OTHER documents in
// its title bar, in `documentOrder`, so a requirements-first spec reads
// requirements → design → tasks and a bugfix spec bugfix → design → tasks.
// package.json menu entries are static, so each `kirocrew.spec.goto.<doc>`
// command has one `editor/title` entry per workflow type (and one for bugfix
// specs) whose `when` checks the context keys of task 1.3 and whose group
// `navigation@<position>` is the document's place in that order; the entry
// for the document being edited is hidden by `resourceFilename`.
// `specGotoMenuEntries()` is the generator those entries come from, so a test
// can hold package.json to it. A target that does not exist yet is created
// empty and opened (requirement 3.2); previous/next step through the same
// order and stop at its ends.

const SPEC_NAV_DOCUMENTS = ["requirements", "design", "tasks", "bugfix"];
const SPEC_GOTO_COMMAND_PREFIX = "kirocrew.spec.goto.";
/** The `when` fragment selecting a spec document (`.kiro/specs/<f>/<doc>.md`) as the editor's resource. */
const SPEC_RESOURCE_WHEN = "resourcePath =~ /[\\\\/]\\.kiro[\\\\/]specs[\\\\/][^\\\\/]+[\\\\/](requirements|design|tasks|bugfix)\\.md$/";

/** The bare document name of a path or file name ("…/design.md" → "design.md"). */
function specDocumentName(fileOrPath) {
  return String(fileOrPath || "").replace(/\\/g, "/").split("/").pop();
}

/** `kirocrew.spec.goto.<doc>` for a spec document ("design.md" or "design"); null for any other file. */
function specGotoCommand(file) {
  const stem = specDocumentName(file).replace(/\.md$/, "");
  return SPEC_NAV_DOCUMENTS.includes(stem) ? SPEC_GOTO_COMMAND_PREFIX + stem : null;
}

/**
 * The navigation targets shown for a document (pure): the spec's documents in
 * `documentOrder(config)` minus `file` itself, each `{file, position, command}`
 * where `position` is the 1-based place in the FULL order, so the title bar
 * keeps the workflow's order with the current document skipped.
 */
function specNavigationTargets(file, config) {
  const current = specDocumentName(file);
  return documentOrder(config)
    .map((f, i) => ({ file: f, position: i + 1, command: specGotoCommand(f) }))
    .filter((t) => t.file !== current);
}

/**
 * The document `delta` steps away from `file` in `documentOrder(config)` (+1
 * next, -1 previous): the file name, or null at the ends and when `file` is
 * not one of the spec's documents (requirements.md inside a bugfix spec).
 */
function adjacentSpecDocument(file, config, delta) {
  const order = documentOrder(config);
  const i = order.indexOf(specDocumentName(file));
  if (i < 0) return null;
  const j = i + (Number(delta) || 0);
  return j >= 0 && j < order.length ? order[j] : null;
}

/**
 * The `editor/title` menu entries behind the navigation (pure), the exact
 * objects package.json carries: for each workflow type of a feature spec and
 * for a bugfix spec, one entry per document in its order with `when` = spec
 * resource ∧ not this document ∧ the matching context keys, and group
 * `navigation@<position>`. The default workflow type also matches an UNSET
 * key, so the title bar is right before the keys have followed the editor.
 */
function specGotoMenuEntries() {
  const K = SPEC_CONTEXT_KEYS;
  const variants = WORKFLOW_TYPES.map((w) => ({
    config: { workflowType: w, specType: DEFAULT_SPEC_TYPE },
    keys: K.specType + " != 'bugfix' && " + (w === DEFAULT_WORKFLOW_TYPE
      ? "(" + K.workflowType + " == '" + w + "' || !" + K.workflowType + ")"
      : K.workflowType + " == '" + w + "'"),
  })).concat([{ config: { specType: "bugfix" }, keys: K.specType + " == 'bugfix'" }]);
  const entries = [];
  for (const v of variants) {
    documentOrder(v.config).forEach((file, i) => entries.push({
      command: specGotoCommand(file),
      when: SPEC_RESOURCE_WHEN + " && resourceFilename != '" + file + "' && " + v.keys,
      group: "navigation@" + (i + 1),
    }));
  }
  return entries;
}

/**
 * The `commandPalette` entries for the four goto commands (pure): offered on a
 * spec document only, requirements for feature specs and bugfix for bugfix
 * specs (the two never coexist in one spec).
 */
function specGotoPaletteEntries() {
  const K = SPEC_CONTEXT_KEYS;
  return SPEC_NAV_DOCUMENTS.map((doc) => ({
    command: SPEC_GOTO_COMMAND_PREFIX + doc,
    when: SPEC_RESOURCE_WHEN + (doc === "bugfix" ? " && " + K.specType + " == 'bugfix'" : doc === "requirements" ? " && " + K.specType + " != 'bugfix'" : ""),
  }));
}

// ---- Spec title-bar actions: "Sync with project files" and "Next document"
//
// Kiro's spec editor keeps two phase buttons next to the navigation. "Sync
// with project files" (Ctrl/Cmd+Shift+Enter) sends the update turn for the
// document being edited; it is offered only while the document is non-empty
// or dirty (requirement 3.3), which the `kirocrew.spec.documentHasContent`
// context key says — `SpecContentKey` follows the active text editor and its
// edits. "Next document" (requirement 3.4) sits on every document but the last
// of the order: when the next document already has content it opens it, else
// it asks the Spec_Agent to generate it. `nextDocumentDecision` is that rule.

/** The context key behind "Sync with project files": the active spec document is non-empty or dirty. */
const SPEC_CONTENT_KEY = "kirocrew.spec.documentHasContent";
/** `when` of the Sync entry and its keybinding: a spec document with content. */
const SPEC_SYNC_WHEN = SPEC_RESOURCE_WHEN + " && " + SPEC_CONTENT_KEY;
/**
 * `when` of the Next entry: a spec document that is not the last of its order —
 * tasks.md always is, and design.md is in a fast-task spec (tasks → requirements → design).
 */
const SPEC_NEXT_WHEN = SPEC_RESOURCE_WHEN + " && resourceFilename != 'tasks.md' && (" + SPEC_CONTEXT_KEYS.workflowType + " != 'fast-task' || resourceFilename != 'design.md')";
/**
 * `when` of the "Run all tasks" title entry and its keybinding (requirement
 * 3.5): the spec's tasks.md, the one document the run reads; the keybinding
 * adds `editorTextFocus` in front like Sync's does.
 */
const SPEC_RUN_ALL_WHEN = SPEC_RESOURCE_WHEN + " && resourceFilename == 'tasks.md'";

/** Does a spec document count as having content (pure): non-blank text, or unsaved edits. */
function specDocumentHasContent(text, dirty) {
  return Boolean(dirty) || String(text || "").trim().length > 0;
}

/**
 * What "Next document" does from `file` (pure): `{ action, file }` where
 * `file` is the next document of `documentOrder(config)` and `action` is
 * "open" when `nextHasContent`, "generate" otherwise; `{ action: "none",
 * file: null }` at the end of the order or off it.
 */
function nextDocumentDecision(file, config, nextHasContent) {
  const next = adjacentSpecDocument(file, config, 1);
  if (!next) return { action: "none", file: null };
  return { action: nextHasContent ? "open" : "generate", file: next };
}

/**
 * Keeps `kirocrew.spec.documentHasContent` in step with the active text
 * editor: refreshed when the active editor changes, when its document is
 * edited and when it is saved (saving an emptied document turns the key off).
 * A webview taking focus (no text editor) leaves the key alone, like
 * SpecContextKeys; the command itself re-checks the document before sending.
 */
class SpecContentKey {
  constructor(context) {
    this._applied = undefined;
    if (context) {
      context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => this.refresh(editor)),
        vscode.workspace.onDidChangeTextDocument((e) => this.onDocument(e.document)),
        vscode.workspace.onDidSaveTextDocument((d) => this.onDocument(d)));
    }
    this.refresh(vscode.window.activeTextEditor);
  }
  /** Only the active editor's document moves the key. */
  onDocument(document) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) this.refresh(editor);
  }
  refresh(editor) {
    if (!editor || !editor.document) return;
    const doc = editor.document;
    const value = Boolean(specDirOf(doc.uri.path) && specFileOf(doc.uri.path)) && specDocumentHasContent(doc.getText(), doc.isDirty);
    this.apply(value);
  }
  apply(value) {
    if (value === this._applied) return;
    this._applied = value;
    void vscode.commands.executeCommand("setContext", SPEC_CONTENT_KEY, value);
  }
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
      // Every document a spec can have, bugfix.md included (the rows come from documentOrder).
      const present = {};
      for (const file of SPEC_MODEL_FILES) present[file] = (await readWholeText(vscode.Uri.joinPath(dir, file))) !== null;
      const tasksText = await readWholeText(vscode.Uri.joinPath(dir, "tasks.md"));
      const taskTree = parseTaskTree(tasksText);
      // The SpecModel's config when it is already built (its watcher drops it on change), else the file.
      const cached = specModels ? specModels.peek(dir) : undefined;
      const config = cached && cached.config ? cached.config : await readSpecConfig(dir);
      specs.push({ name, dir, present, tasks: flattenTasks(taskTree, tasksText), taskTree, tasksText: tasksText || "", workspace: folder, config });
    }
  }
  return specs;
}

/**
 * The Specs view. Refreshes from the SpecModelStore's debounced `onDidChange`
 * (one batch per 250 ms of edits: a spec directory appearing or disappearing,
 * a `.config.kiro` or document change — requirement 2.5) so the view and the
 * other spec providers re-read together instead of each watching the files;
 * without a store (unit tests) it falls back to its own watcher. `refresh()`
 * is for the actions that want the eye to follow at once (create, rename, delete).
 */
class SpecsTree {
  constructor(context, models, starts) {
    this._change = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._change.event;
    // The start guard (one chat per click): a spec whose start is going shows a spinning row.
    this.starts = starts || null;
    if (models && typeof models.onDidChange === "function") {
      context.subscriptions.push(models.onDidChange(() => this.refresh()));
    } else {
      const watcher = vscode.workspace.createFileSystemWatcher("**/.kiro/specs/**");
      context.subscriptions.push(watcher, watcher.onDidChange(() => this.refresh()), watcher.onDidCreate(() => this.refresh()), watcher.onDidDelete(() => this.refresh()));
    }
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
        // Kiro's `[~]` / `[-]` marks left in tasks.md are an interrupted run; the row
        // says so and offers ⟳ Resume run (the context value keeps the `spec` prefix
        // so every spec menu still applies).
        const partial = spec.tasks.filter((t) => t.leaf && t.partial).length, queued = spec.tasks.filter((t) => t.leaf && t.queued).length;
        const interrupted = partial + queued > 0;
        item.contextValue = interrupted ? "spec-interrupted" : "spec";
        item.spec = spec;
        // The next document the workflow needs (in the spec's order; a fast-task spec's
        // generated rows do not hold it back), else the task tally.
        const needed = specDocumentRows(spec.config, spec.present).find((row) => !row.exists && !row.generated);
        const phase = needed ? "needs " + needed.stem : done + "/" + spec.tasks.length + " tasks";
        const starting = this.starts ? this.starts.titleFor(spec.dir.path) : null;
        item.description = starting ? "starting: " + starting.replace(/^spec [^:]*: /, "") + "…"
          : interrupted ? phase + " · interrupted: " + describeLeft({ partial, queued, remaining: 0 }) : phase;
        item.tooltip = starting ? spec.name + ": " + starting + " is starting — its chat opens in a moment; another click adds nothing."
          : interrupted ? spec.name + ": a run left " + describeLeft({ partial, queued, remaining: 0 }) + " in tasks.md. ⟳ Resume run continues it in the session that ran it (or a new one)." : undefined;
        item.iconPath = new vscode.ThemeIcon(starting ? "loading~spin" : interrupted ? "debug-pause" : "notebook");
        return item;
      });
    }
    if (node.contextValue === "spec" || node.contextValue === "spec-interrupted") {
      const spec = node.spec;
      // One row per document of the spec's order (bugfix.md stands where requirements.md
      // would for a bugfix spec); a fast-task spec leads with tasks and shows requirements
      // and design as dimmer "generated" rows. A missing document is still a row: clicking
      // it writes that document (kirocrew.spec.<stem>).
      const dim = typeof vscode.ThemeColor === "function" ? new vscode.ThemeColor("descriptionForeground") : undefined;
      const files = specDocumentRows(spec.config, spec.present).map(({ file, stem, exists, generated }) => {
        const item = new vscode.TreeItem(stem, vscode.TreeItemCollapsibleState.None);
        item.contextValue = (generated ? "specfile-generated" : "specfile") + (exists ? "" : "-missing");
        item.iconPath = generated ? new vscode.ThemeIcon(exists ? "file" : "circle-outline", dim) : new vscode.ThemeIcon(exists ? "file" : "circle-outline");
        item.description = [generated ? "generated" : "", exists ? "" : "not written"].filter(Boolean).join(" · ");
        if (generated) item.tooltip = file + " is written alongside tasks.md by the fast-task workflow.";
        // Row actions (Review, requirement 2.6) read the document from `documentUri`; a row for
        // a document that is not written yet has none, and its click writes the document instead.
        item.spec = spec;
        item.file = file;
        item.documentUri = exists ? vscode.Uri.joinPath(spec.dir, file) : null;
        item.command = exists
          ? { command: "kirocrew.spec.open", title: "Open", arguments: [item.documentUri] }
          : { command: "kirocrew.spec." + stem, title: "Write", arguments: [node] };
        return item;
      });
      const kas = kasTasks();
      const tasks = spec.tasks.map((task) => {
        const label = (task.number ? task.number + " " : "") + task.title;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        // Kiro's four states: the orchestrator writes `[~]` when it queues a task and `[-]` while it
        // runs; a run on Kiro's engine (kirocrew.specEngine = kas) reports queued / running / failed
        // through its task metadata before the box changes (requirement 5.4).
        const boxState = task.done ? "completed" : task.partial ? "in_progress" : task.queued ? "queued" : "not_started";
        const state = mergeKasTaskState(boxState, kas ? kas.statusOf(spec.name, spec.dir.path, task.id) : undefined);
        const partial = state === "in_progress", queued = state === "queued", failed = state === "failed", aborted = state === "aborted";
        item.contextValue = task.done ? "task-done" : partial ? "task-running" : "task-open";
        item.iconPath = new vscode.ThemeIcon(task.done ? "pass-filled" : partial ? "loading~spin" : queued ? "clock" : failed ? "error" : aborted ? "warning" : "circle-large-outline");
        item.spec = spec;
        item.task = task;
        item.description = partial ? "in progress" : queued ? "queued" : failed ? "failed" : aborted ? "stopped" : task.optional ? "optional" : undefined;
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

/** `.kiro/specs/<name>` and the SPEC_RULES preamble for a spec (`spec`: { name, workspace }). */
function specRulesOf(spec) {
  const dir = ".kiro/specs/" + spec.name;
  return { dir, rules: SPEC_RULES.replace("{dir}", dir).replace("{root}", spec.workspace.uri.path) };
}

/**
 * The request of one spec phase. `phase` is requirements | design | tasks |
 * bugfix; a bugfix spec (config.specType) reads its requirements from
 * bugfix.md, so the design and tasks phases name that file instead.
 */
function phasePrompt(phase, spec, extra) {
  const { dir, rules } = specRulesOf(spec);
  const req = dir + "/" + requirementsFileOf(spec.config);
  if (phase === "requirements") {
    return rules + "\n\nPHASE: REQUIREMENTS. Write or refine " + dir + "/requirements.md for this feature: " + (extra || "(see the existing draft)") +
      ". Cover every user-facing behaviour and edge case as numbered requirements with EARS acceptance criteria. Do not write design or tasks yet. When the file is written, summarise the requirements list.";
  }
  if (phase === "bugfix") {
    return rules + "\n\nPHASE: BUG REPORT. Write or refine " + dir + "/bugfix.md for this bug: " + (extra || "(see the existing draft)") +
      ". State the observed behaviour, the expected behaviour, how to reproduce it, the suspected root cause with the evidence you found in the code, and numbered requirements with EARS acceptance criteria for the fix (the bug no longer occurs; nothing that works today regresses). Do not write design or tasks yet. When the file is written, summarise it.";
  }
  if (phase === "design") {
    return rules + "\n\nPHASE: DESIGN. Read " + req + " and write " + dir + "/design.md: overview, architecture, components and interfaces, data models, error handling, testing strategy, and a requirement-to-design traceability list. Investigate the codebase first so the design fits what exists. Do not write tasks yet.";
  }
  if (phase === "tasks") {
    return rules + "\n\nPHASE: TASKS. Read " + req + " and " + dir + "/design.md and write " + dir + "/tasks.md: a numbered checkbox implementation plan of small, verifiable coding tasks in dependency order, each with a `_Requirements:` trace line, ending in wiring/integration tasks so nothing is left dangling. Every task must be something an agent can do by editing code and running tests.";
  }
  throw new Error("unknown phase " + phase);
}

// ---- Spec turns: the one request builder behind the title-bar actions, the
// Specs view's ＋, the task lenses' "Ask the agent to fix" and the review
// comments (ChatView.sendSpecTurn sends what these return). Kiro's host takes
// these as `_kiro/spec/invoke` operations (createSpec, generateDocument with
// action create|update, …); here each is a turn in our own words on the
// Spec_Agent, with the sibling documents riding along as `#file` context.

const SPEC_TURN_KINDS = ["create", "generate", "update", "fix", "review"];

/** "design" or "…/design.md" → "design.md"; any other name is returned bare. */
function specTurnDocument(document) {
  const name = specDocumentName(document);
  const stem = name.replace(/\.md$/, "");
  return SPEC_NAV_DOCUMENTS.includes(stem) ? stem + ".md" : name;
}

/** The documents of a spec other than `document`, in the spec's order (pure). */
function specSiblings(document, config) {
  const file = specTurnDocument(document);
  return documentOrder(config).filter((f) => f !== file);
}

/**
 * The request text of a spec turn (pure). `document` is the file the turn is
 * about ("design.md" or "design"); `opts.spec` is the spec ({ name, workspace,
 * config }); the other options depend on the kind:
 * - create: `opts.idea` — the feature idea; the first document of the spec's
 *   order is written (the fast-task type writes all three in one go);
 * - generate: write `document` from the ones before it (the existing phase
 *   request; `opts.idea` seeds a requirements/bugfix document);
 * - update: bring `document` in line with the project files and its siblings,
 *   keeping the user's edits;
 * - fix: `opts.task` — the task ({ id, text } or { number, title }) that failed;
 * - review: `opts.body` — buildReviewTurn's text (header, quoted excerpts with
 *   their comments, the apply-feedback instruction); `opts.displayText` its bubble.
 */
function specTurnText(kind, document, opts) {
  const o = opts || {};
  const spec = o.spec;
  if (!spec || !spec.name) throw new Error("spec turn: no spec");
  const file = specTurnDocument(document);
  const { dir, rules } = specRulesOf(spec);
  const order = documentOrder(spec.config);
  const phaseOf = (f) => f.replace(/\.md$/, "");
  const siblings = specSiblings(file, spec.config).map((f) => dir + "/" + f);
  if (kind === "generate") {
    if (!order.includes(file)) throw new Error("spec turn: " + file + " is not a document of " + spec.name);
    return phasePrompt(phaseOf(file), spec, o.idea);
  }
  if (kind === "create") {
    const first = order[0];
    const idea = String(o.idea || "").trim() || "(see the spec's name)";
    const types = "workflow type " + ((spec.config && spec.config.workflowType) || DEFAULT_WORKFLOW_TYPE) + ", spec type " + ((spec.config && spec.config.specType) || DEFAULT_SPEC_TYPE);
    if (spec.config && spec.config.workflowType === "fast-task") {
      return rules + "\n\nPHASE: FAST TASK. This is a new spec (" + types + ") for: " + idea +
        ". Ask at most one short round of clarifying questions only if the idea is genuinely ambiguous; otherwise proceed. Then, without pausing between documents, write " + dir + "/tasks.md (the primary document: a numbered checkbox plan of small, verifiable coding tasks with `_Requirements:` trace lines) and the supporting " + dir + "/requirements.md and " + dir + "/design.md it traces to, and finish with a brief summary and the first task. Do not implement code.";
    }
    const seeded = first === "requirements.md" || first === "bugfix.md" ? phasePrompt(phaseOf(first), spec, idea)
      : rules + "\n\nPHASE: DESIGN FIRST. Write " + dir + "/design.md for this feature: " + idea + ". Investigate the codebase first so the design fits what exists: overview, architecture, components and interfaces, data models, error handling, testing strategy. Do not write requirements or tasks yet; when the file is written, summarise the design.";
    return seeded + "\n\nThis is a new spec (" + types + "); its directory and .config.kiro exist and " + first + " is the first document to write.";
  }
  if (kind === "update") {
    if (!order.includes(file)) throw new Error("spec turn: " + file + " is not a document of " + spec.name);
    const keep = file === "tasks.md" ? " Leave every task box (`[ ]`, `[~]`, `[-]`, `[x]`) as it is and keep the numbering of tasks that are already ticked or referenced." : "";
    return rules + "\n\nPHASE: UPDATE " + phaseOf(file).toUpperCase() + ". Re-read " + dir + "/" + file + (siblings.length ? " and its sibling documents (" + siblings.join(", ") + ", attached as context)" : "") +
      ", then compare the document with the project files it describes and revise " + dir + "/" + file + " so it is consistent with the code base as it is now and with the sibling documents: keep the user's edits, correct what the code contradicts, fill the gaps, and do not renumber anything the other documents still reference." + keep +
      " Do not rewrite the other documents (fix a reference in them only when this change breaks it). Do not implement code. When the file is written, summarise what changed.";
  }
  if (kind === "fix") {
    const task = o.task || {};
    const label = task.text || ((task.number || task.id) ? String(task.number || task.id) + " " : "") + String(task.title || "");
    const block = typeof task.text === "string" && Array.isArray(task.subTasks) ? serializeTask(task) : label;
    return rules + "\n\nPHASE: FIX A FAILED TASK. The run of this task from " + dir + "/tasks.md stopped before the task was done (an error, or the turn was cut):\n\n" + block +
      "\n\nFind out what the earlier attempt left behind (files it edited, a failing build or test, a half-written change), fix the root cause rather than the symptom, finish the task as " + dir + "/requirements.md and " + dir + "/design.md describe it, verify with the project's build and tests, and mark the task `- [x]` in " + dir + "/tasks.md. Stop after this task; do not start the next one.";
  }
  if (kind === "review") {
    const body = String(o.body || "").trim();
    if (!body) throw new Error("spec turn: a review turn needs its comments");
    return rules + "\n\nPHASE: APPLY REVIEW COMMENTS to " + dir + "/" + file + ".\n\n" + body;
  }
  throw new Error("unknown spec turn kind " + kind);
}

/** The short bubble the transcript shows for a spec turn in place of the request (pure). */
function specTurnDisplay(kind, document, opts) {
  const o = opts || {};
  const file = specTurnDocument(document);
  const stem = file.replace(/\.md$/, "");
  if (kind === "create") return "Create spec: " + ((o.spec && o.spec.name) || stem);
  if (kind === "generate") return "Generate " + stem;
  if (kind === "update") return "Sync " + stem + " with project files";
  if (kind === "fix") { const t = o.task || {}; return "Fix task" + (t.id || t.number ? " " + (t.id || t.number) : "") + (t.title ? ": " + t.title : ""); }
  if (kind === "review") return "Review: " + stem;
  return kind + " " + stem;
}

/** The title of a tab a spec turn opens (pure): the idea for a new spec (requirement 2.1), "spec <name>: <doc>" otherwise. */
function specTurnTitle(kind, document, opts) {
  const o = opts || {};
  const name = (o.spec && o.spec.name) || "spec";
  if (kind === "create" && String(o.idea || "").trim()) return clip(String(o.idea).trim().replace(/\s+/g, " "), 60).split("\n")[0];
  return "spec " + name + ": " + specTurnDocument(document).replace(/\.md$/, "");
}

/** The `#file` context items of a spec's sibling documents that exist on disk, one per file, each clipped to the context budget. */
async function specSiblingContexts(spec, document) {
  const root = spec.workspace && spec.workspace.uri ? spec.workspace.uri.path : "";
  const out = [];
  for (const file of specSiblings(document, spec.config)) {
    const uri = vscode.Uri.joinPath(spec.dir, file);
    const text = await readWholeText(uri);
    if (text === null || !text.trim()) continue;
    const rel = root && uri.path.startsWith(root + "/") ? uri.path.slice(root.length + 1) : uri.path;
    out.push({ kind: "file", label: rel, content: "--- " + rel + " ---\n" + clip(text, CONTEXT_BUDGET), paths: [uri.path] });
  }
  return out;
}

// ------------------------------------------------- one start per click
//
// Between a click on a Specs action (Run all tasks, Generate design, …) and the
// chat it opens sit several round trips: focusing the chat view (resolving the
// webview when the side bar was hidden), the engine probe, re-reading the spec,
// creating the session, applying the picks, the steering scan, the context
// injections, and on Kiro's engine the session resolve. For a few seconds
// nothing visible happens, and a second click starts a second chat. The guard
// below holds one start per spec (keyed by the spec's directory; SPEC_START_ANY
// when the spec is not known at the click, e.g. a palette invocation that will
// ask) and answers a click during that window with the start already going
// instead of a new one. `onChange` lets the Specs view spin the row; `progress`
// wraps the work in the host's progress UI; `onDuplicate` tells the user.

const SPEC_START_ANY = "*";
const SPEC_START_NEW = "new-spec"; // the ＋ wizard: one at a time, not tied to a directory

class SpecStartGuard {
  constructor({ onChange, onDuplicate, progress } = {}) {
    this.inFlight = new Map(); // key -> { key, title, promise }
    this.onChange = typeof onChange === "function" ? onChange : () => undefined;
    this.onDuplicate = typeof onDuplicate === "function" ? onDuplicate : () => undefined;
    this.progress = typeof progress === "function" ? progress : null;
  }
  /** The start a click keyed `key` collides with: its own spec's, the unkeyed one, or any when the click is unkeyed. */
  held(key) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    if (this.inFlight.has(SPEC_START_ANY)) return this.inFlight.get(SPEC_START_ANY);
    if (key === SPEC_START_ANY && this.inFlight.size) return this.inFlight.values().next().value;
    return null;
  }
  /** The title of the start going on for the spec directory `dirPath` (exact key; the Specs view's row), else null. */
  titleFor(dirPath) {
    const entry = this.inFlight.get(dirPath);
    return entry ? entry.title : null;
  }
  get size() { return this.inFlight.size; }
  /**
   * Move a start held under `from` (the unkeyed SPEC_START_ANY of a palette
   * click) under `to` (the spec's directory once the handler has resolved it),
   * so the Specs view can spin that row. No-op when nothing is held under
   * `from` or `to` is already held.
   */
  rekey(from, to) {
    const entry = this.inFlight.get(from);
    if (!entry || from === to || this.inFlight.has(to)) return false;
    this.inFlight.delete(from);
    entry.key = to;
    this.inFlight.set(to, entry);
    this.onChange();
    return true;
  }
  /**
   * Run `work` as the start `title` under `key`. A click that collides with a
   * start still going gets that start's promise (and `onDuplicate(heldTitle,
   * title)`), so it adds nothing. The hold ends when `work` settles, however it
   * settles.
   */
  run(key, title, work) {
    const held = this.held(key);
    if (held) { this.onDuplicate(held.title, title); return held.promise; }
    const entry = { key, title, promise: null };
    this.inFlight.set(key, entry);
    this.onChange();
    entry.promise = (async () => {
      try {
        return await (this.progress ? this.progress(title, work) : work());
      } finally {
        if (this.inFlight.get(entry.key) === entry) this.inFlight.delete(entry.key);
        this.onChange();
      }
    })();
    return entry.promise;
  }
}

/** The guard key for what a spec command was invoked on: the spec's directory when the argument names one, else SPEC_START_ANY. */
function specStartKey(arg) {
  if (!arg) return SPEC_START_ANY;
  if (arg.spec && arg.spec.dir && arg.spec.dir.path !== undefined) return arg.spec.dir.path;
  if (arg.dir && arg.dir.path !== undefined) return arg.dir.path;
  if (typeof arg.dir === "string" && arg.dir) return arg.dir;
  const path = arg.path !== undefined && arg.scheme ? arg.path : arg.uri && arg.uri.path !== undefined ? arg.uri.path : arg.fsPath;
  const dir = specDirOf(path);
  return dir || SPEC_START_ANY;
}

/** The `{ name, dir }` record a tab keeps of the spec it works on (null for anything else). */
function specTabRecord(spec) {
  if (!spec) return null;
  if (typeof spec === "string") return spec ? { name: spec, dir: null } : null;
  if (typeof spec !== "object" || typeof spec.name !== "string" || !spec.name) return null;
  const dir = spec.dir && spec.dir.path !== undefined ? spec.dir.path : spec.dir;
  return { name: spec.name, dir: typeof dir === "string" && dir ? dir : null };
}

/** Does tab `t` work on the spec `name` (in directory `dir`, when both sides know one)? Its Run_Record or its `spec` record says. */
function specTabMatches(t, name, dir) {
  const same = (d) => !dir || !d || sameDir(d, dir);
  if (t.run && t.run.spec === name && same(t.run.dir)) return true;
  return Boolean(t.spec && t.spec.name === name && same(t.spec.dir));
}

/** Absolute path of a spec's tasks.md, as Kiro's engine names it in its requests. */
function tasksPathOf(spec) {
  const dir = (spec.dir && spec.dir.path) || (spec.workspace.uri.path + "/.kiro/specs/" + spec.name);
  return dir + "/tasks.md";
}

/**
 * Task requests, in two flavours.
 *
 * `kiroTaskRequest` / `kiroRunAllRequest` are the messages Kiro's IDE itself
 * sends its engine — read from @kiro/agent's `handleSpecExecuteTask` /
 * `handleSpecRunAllTasks` — kept for the resume path and for tests; on
 * Kiro's engine the mod now sends the operation itself (`_kiro/spec/invoke`,
 * kirocrew.specEngine = kas), so the engine's spec sub-intent router hands the
 * turn to its Task Orchestrator, which queues every not-started required
 * task, runs them through its task-execution sub-agent one after another
 * without stopping, and writes `[~]` / `[-]` / `[x]` back into tasks.md.
 *
 * On the gateway, a paraphrase on the crew agent carries the same `<task>`
 * block and asks for the same non-stop loop.
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

/** A host failure row: the `error` role the session log writes, or the
 *  dashboard's `msg-err` class / ❌ ⏱ prefix on an assistant row. */
function isErrorRow(row) {
  if (!row) return false;
  if (row.role === "error") return true;
  return row.role === "assistant" && (/\bmsg-err\b/.test(row.cls || "") || /^\s*[❌⏱]/.test(row.content || ""));
}

/**
 * The host's turn-ceiling card. KiroCrew bounds every dashboard turn at
 * `agent.chat_turn_timeout_secs` (4 h by default, 24 h at most); at the ceiling
 * it cancels the turn, broadcasts `chat_done`, then appends
 * "⏱️ This turn hit the 4-hour limit and was stopped. Work already written to
 * disk is still there — nothing was rolled back. Send a message to continue
 * from where it stopped." as an `error` row (turn_dispatch.format_turn_timeout_card).
 * Matched loosely on the one phrase a reword is least likely to touch.
 */
function isTurnLimitRow(row) {
  return isErrorRow(row) && /hit the \S+ limit and was stopped/i.test(String(row.content || ""));
}
function turnLimitOf(content) {
  const m = /hit the (\S+) limit/i.exec(String(content || ""));
  return m ? m[1] : "time";
}

/** Milliseconds a resume waits after the card: the host has finished the cut turn (chat_done came first) but is still settling the slot. */
const RESUME_SETTLE_MS = 1500;
/** Appended to a task run's resume request: the engine must not trust a `[-]` row the cut turn left half done. */
const RESUME_NOTE = "\n\nThe previous turn on this spec ended before the run finished (the host's turn time limit, a dropped connection, or an error); nothing was rolled back. Re-read tasks.md first: a task marked `[-]` may be partly done, so check its state before carrying on, then continue from the next unfinished task.";
/** A plain chat's continuation, when the user presses Continue on the card. */
const RESUME_CHAT_TEXT = "Continue from where you stopped. The previous turn ended before it finished (the host's turn time limit, a dropped connection, or an error); work already written to disk is still there, so re-check its state first and then finish what was left.";

/** A tab the IDE opened for a spec run or phase: the kind `dispatch` sets, or the key prefix it used before tabs carried a kind. */
function isSpecTab(t) {
  return Boolean(t) && (t.kind === "spec" || /^kirocrew-ide-spec-/.test(String(t.key || "")));
}
/**
 * What tasks.md says about a run right now: how many of its leaf tasks are
 * queued (`[~]`), in progress (`[-]`) and still open at all (`remaining`,
 * required ones unless the run asked for the optional ones too). A
 * single-task run reads its one task. `null` when the spec is gone.
 */
async function runState(run) {
  const specs = await listSpecs();
  const spec = specs.find((s) => s.name === run.spec && (!run.dir || sameDir(s.dir.path, run.dir))) || null;
  if (!spec) return null;
  let leaves;
  if (run.task) {
    const task = findTask(spec.taskTree || [], run.task);
    if (!task) return null;
    leaves = flattenTasks([task]).filter((t) => t.leaf); // the task itself when it has no sub-tasks
  } else {
    leaves = spec.tasks.filter((t) => t.leaf && (run.optional || !t.optional));
  }
  return {
    spec: spec.name,
    queued: leaves.filter((t) => t.queued).length,
    partial: leaves.filter((t) => t.partial).length,
    remaining: leaves.filter((t) => !t.done).length,
  };
}
/** "1 task in progress and 10 queued" — the marks Kiro's orchestrator left in tasks.md. */
function describeLeft(state) {
  const parts = [];
  if (state.partial) parts.push(state.partial + " task" + (state.partial === 1 ? "" : "s") + " in progress");
  if (state.queued) parts.push(state.queued + " queued");
  if (!parts.length && state.remaining) parts.push(state.remaining + " task" + (state.remaining === 1 ? "" : "s") + " left");
  return parts.join(" and ");
}
/** The answer ended on a question to the user: an `[OPTIONS:` line or a trailing question mark. */
function looksLikeQuestion(text) {
  const s = String(text || "").trim();
  return /\[OPTIONS:/i.test(s) || /\?\s*$/.test(s);
}

/**
 * The request that resumes a task run the host cut at its ceiling, built from
 * tasks.md as it is NOW (so the done list the engine skips is current), in the
 * same two flavours the run itself used (`kiro`: Kiro's own engine request for
 * the Spec agent, else the crew-agent paraphrase). `run` is the record
 * `dispatch` kept on the tab: { spec, dir, task, optional, display }. Returns
 * { text, display } or { text: null, reason } when there is nothing left to do.
 */
async function resumeRequest(run, kiro) {
  const specs = await listSpecs();
  const spec = specs.find((s) => s.name === run.spec && (!run.dir || sameDir(s.dir.path, run.dir))) || null;
  if (!spec) return { text: null, reason: "spec " + run.spec + " is no longer in the workspace" };
  if (run.task) {
    const task = findTask(spec.taskTree || [], run.task);
    if (!task) return { text: null, reason: "task " + run.task + " is no longer in tasks.md" };
    if (task.status === "completed") return { text: null, reason: "task " + run.task + " is ticked" };
    return { text: (kiro ? kiroTaskRequest(spec, task) : taskPrompt(spec, task)) + RESUME_NOTE, display: "Resume: " + (run.display || "Execute Task: " + task.text) };
  }
  const remaining = spec.tasks.filter((t) => !t.done && t.leaf && (run.optional || !t.optional)).length;
  if (!remaining) return { text: null, reason: "every " + (run.optional ? "" : "required ") + "task in " + spec.name + " is ticked" };
  return { text: (kiro ? kiroRunAllRequest(spec) : runAllPrompt(spec)) + RESUME_NOTE, display: "Resume: " + (run.display || "Run all tasks") + " (" + remaining + " left)", remaining };
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
  if (gatewayAgent(slot.agent)) live.agent = gatewayAgent(slot.agent);
  return live;
}

/**
 * The single Agent picker, sectioned like Kiro's: the Kiro-modes group is
 * prepended by the caller (kasPicks, from kas/status), then the mod's
 * prompt-guided workflows, then the crew default and every other agent. Each
 * entry's id encodes the kind so the webview stays dumb: `agent:<name>`,
 * `workflow:<mode>`, `kas:<mode>`, `kashint:`, or "".
 */
const WORKFLOWS_SECTION = "Workflows (prompt-guided)";
function agentPicks(agents) {
  const out = [];
  for (const w of WORKFLOWS) if (w.id !== "default") out.push({ id: "workflow:" + w.id, label: w.label, description: w.description, section: WORKFLOWS_SECTION });
  out.push({ id: "", label: "Default", description: "the crew default agent — general coding assistance", section: "Your agents" });
  for (const a of agents || []) {
    if (/^kirocrew(-lite|-skill-view-)/.test(a.name)) continue;
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

// ------------------------------------------------------- Kiro modes (KAS)
//
// Kiro's real Spec, Quick Spec, Bug Fix and Plan engines live in KAS, the bundle
// `kiro-cli acp --agent-engine v3` runs. The gateway cannot run them (it rewrites
// the built-in agent ids), so the mod's hook owns one kiro-cli child per
// workspace and this side talks to it over a WebSocket on the same-origin proxy
// path (hook/kas.py, the Kas_Link). A tab of kind `kas` is such a session: the
// hook relays the raw ACP `session/update` stream with sequence numbers, the
// Adapter below turns it into the messages the chat webview already draws, and
// a reconnect asks for everything after the last sequence it saw. KAS's own
// permissions and Autopilot apply to these tabs; KiroCrew policy, approvals,
// memory and the mod's steering injection do not (KAS loads .kiro/steering).

/** The Kas_Link path on the dashboard origin (hook: KAS_WS_PATH). */
const KAS_WS_PATH = "/kirocrew-ide/_kirocrew/kas/ws";
const KAS_STATUS_ROUTE = "/apps/floofycrew/mods/" + IDE_TAG + "/api/kas/status";
const KAS_STATUS_TTL_MS = 60000;
/** The spec-family modes a Kiro-mode tab may run; `vibe` and user agents stay with the gateway path. */
const KAS_MODES = ["spec", "quick-spec", "bug-fix", "plan"];
const KAS_SECTION = "Kiro modes (kiro-cli)";
/** Said once per Kiro-mode tab (requirement 3.7). */
const KAS_TAB_NOTICE = "This tab runs in Kiro's own engine (kiro-cli on the gateway host). KAS's permissions and Autopilot apply; KiroCrew policy, approvals and memory do not. Steering is loaded by KAS itself.";
const KAS_REQUEST_TIMEOUT_MS = 90000;

const KAS_SESSIONS_ROUTE = "/apps/floofycrew/mods/" + IDE_TAG + "/api/kas/sessions";
/**
 * The History picker's Kiro-mode rows (requirement 6.3), pure: the `kas/sessions` rows of
 * THIS workspace (same folder), newest first, each with the mode, state and age, a check
 * when a tab is open on it (`isOpen(sessionId)`), and `kas: sessionId` for the handler.
 */
function kasHistoryItems(rows, projectPath, isOpen) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.sessionId !== "string" || !r.sessionId) continue;
    if (projectPath && r.folder && !sameDir(r.folder, projectPath)) continue;
    const state = r.state === "running" ? "$(sync~spin) running" : r.pendingAsks ? "$(bell) waiting" : r.state === "detached" ? "detached" : "";
    const when = ageLabel(slotTime(r.lastActivity));
    const open = typeof isOpen === "function" && isOpen(r.sessionId);
    out.push({ label: (open ? "$(check) " : "") + (r.title || r.sessionId), description: ["kiro-cli " + (r.mode || "mode"), r.feature ? "spec " + r.feature : "", state, when].filter(Boolean).join("  ·  "),
      detail: r.source === "kas" ? "in kiro-cli's own store (not relayed by this IDE yet)" : "", kas: r.sessionId, mode: r.mode || "", title: r.title || "" });
  }
  return out;
}

let kasStatusCache = { at: 0, value: null, promise: null };
/** `GET kas/status` from the hook, cached KAS_STATUS_TTL_MS; `{available: false, reason}` when the route fails. */
async function kasStatus(force) {
  const now = Date.now();
  if (!force && kasStatusCache.value && now - kasStatusCache.at < KAS_STATUS_TTL_MS) return kasStatusCache.value;
  if (kasStatusCache.promise) return kasStatusCache.promise;
  kasStatusCache.promise = api(KAS_STATUS_ROUTE)
    .then((doc) => doc && typeof doc === "object" ? doc : { available: false, reason: "kas/status answered nothing" })
    .catch((error) => ({ available: false, reason: "kas/status unavailable: " + (error && error.message || error) }))
    .then((value) => { kasStatusCache = { at: Date.now(), value, promise: null }; return value; });
  return kasStatusCache.promise;
}
function invalidateKasStatus() { kasStatusCache = { at: 0, value: null, promise: null }; }

/**
 * The picker entries of the "Kiro modes" group (requirements 3.1, 7.1, 7.4):
 * one `kas:<mode>` pick per spec-family mode the hook's status advertises, or a
 * single non-selectable hint row naming the reason when KAS is unavailable.
 * Pure; `status` is the `kas/status` document (or null before the first read).
 */
function kasPicks(status) {
  if (!status) return [];
  if (!status.available) {
    return [{ id: "kashint:", label: "Kiro modes unavailable", description: String(status.reason || "kiro-cli is not usable on the gateway host"), section: KAS_SECTION, hint: true }];
  }
  const advertised = Array.isArray(status.modes) ? status.modes : [];
  const out = [];
  for (const id of KAS_MODES) {
    const m = advertised.find((x) => x && x.id === id);
    if (!m) continue;
    out.push({ id: "kas:" + id, label: m.name || id, description: m.description || "", section: KAS_SECTION, kas: true, mode: id });
  }
  return out;
}

/** A tab that runs (or will run) in Kiro's engine: created there, or a draft whose pick is a Kiro mode. */
function isKasTab(t) {
  return Boolean(t) && (t.kind === "kas" || Boolean(t.settings && t.settings.engine === "kas"));
}
/** The persisted/live state of a Kiro-mode tab (design: KasTabState). `asks` and the stream bookkeeping are not persisted. */
function kasTabState(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  return {
    sessionId: typeof s.sessionId === "string" ? s.sessionId : "",
    mode: typeof s.mode === "string" ? s.mode : "",
    wsHash: typeof s.wsHash === "string" ? s.wsHash : "",
    lastSeq: Number.isFinite(Number(s.lastSeq)) ? Number(s.lastSeq) : 0,
    state: typeof s.state === "string" ? s.state : "new",
    autopilot: Boolean(s.autopilot),
    noticeShown: Boolean(s.noticeShown),
    running: false, replayUntil: 0, pendingUser: "", sentLocally: false, skipEcho: false, streaming: false, asks: {},
  };
}
function kasTabRecord(k) {
  if (!k) return null;
  return { sessionId: k.sessionId, mode: k.mode, wsHash: k.wsHash, lastSeq: k.lastSeq, state: k.state, autopilot: k.autopilot, noticeShown: k.noticeShown };
}

/**
 * The ACP prompt content blocks of one turn (requirement 3.8): `#` contexts as
 * text blocks headed by their label, attachments as image blocks (inline) or a
 * text block naming the uploaded path, then the typed text. Pure.
 * `attached`: [{ name, image, mime, data (base64, images), path (others) }].
 */
function kasPromptBlocks(text, contexts, attached) {
  const blocks = [];
  for (const c of contexts || []) if (c && c.content) blocks.push({ type: "text", text: "[" + (c.label || c.kind || "context") + "]\n" + String(c.content) });
  for (const a of attached || []) {
    if (!a) continue;
    if (a.image && a.data) blocks.push({ type: "image", mimeType: a.mime || "image/png", data: a.data });
    else if (a.path) blocks.push({ type: "text", text: "[attached_file] " + a.path });
  }
  const typed = String(text || "").trim();
  if (typed) blocks.push({ type: "text", text: typed });
  else if (blocks.length) blocks.push({ type: "text", text: attached && attached.length ? "See the attached file(s)." : "See the context provided." });
  return blocks;
}

/** The text of an ACP content block (text blocks; others as a short marker). */
function kasContentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return String(content.text || "");
  if (content.type === "image") return "";
  if (content.type === "resource_link") return String(content.uri || content.name || "");
  if (content.type === "resource" && content.resource) return String(content.resource.text || content.resource.uri || "");
  return "";
}
function kasImageMarkdown(content) {
  if (!content || content.type !== "image" || !content.data) return "";
  return "![image](data:" + (content.mimeType || "image/png") + ";base64," + content.data + ")";
}
/** The output text of a `tool_call_update.content` list (text blocks joined; diffs as a path note). */
function kasToolOutput(content) {
  const parts = [];
  for (const c of content || []) {
    if (!c) continue;
    if (c.type === "content") parts.push(kasContentText(c.content));
    else if (c.type === "diff") parts.push("edit " + (c.path || "") + (c.newText !== undefined ? "\n" + String(c.newText).slice(0, 4000) : ""));
    else if (c.type === "terminal") parts.push("terminal " + (c.terminalId || ""));
  }
  return parts.filter(Boolean).join("\n");
}
/** The option a card decision maps to: Approve → the first `allow*` option, Reject → the first `reject*` one (null = cancel). */
function kasPermissionChoice(options, action) {
  const list = Array.isArray(options) ? options : [];
  const want = action === "approved" ? "allow" : "reject";
  const hit = list.find((o) => o && String(o.kind || "").startsWith(want));
  return hit ? hit.optionId : null;
}

/**
 * The Adapter (requirements 3.3–3.5, 4.1, 7.3): one Kas_Link frame → the
 * webview messages for its tab (without `id`), mutating `ts` (kasTabState).
 * Frames with `seq <= ts.lastSeq` are duplicates of what the tab has drawn
 * and yield nothing; `attached {cleared}` restarts the numbering with a
 * `clear`. Replayed `user_message_chunk`s (seq within the attach's window, or
 * a turn this bridge did not send) become `user` rows; the live echo of a
 * prompt sent here is consumed, since the page drew the bubble at send time.
 * Messages whose type starts with `_` are for the ChatView itself (tab badge,
 * config echo, title), never posted to the page.
 */
function kasFramesToMessages(frame, ts) {
  const out = [];
  if (!frame || typeof frame !== "object") return out;
  if (frame.seq !== undefined && frame.seq !== null) {
    if (frame.seq <= ts.lastSeq) return out;
    ts.lastSeq = frame.seq;
  }
  const replay = frame.seq !== undefined && frame.seq <= (ts.replayUntil || 0);
  if (frame.kind !== "userPrompt" && !(frame.kind === "update" && (frame.update || {}).sessionUpdate === "user_message_chunk")) ts.skipEcho = false;
  const flushUser = () => { if (ts.pendingUser) { out.push({ type: "row", row: { role: "user", content: ts.pendingUser, ts: "", cls: "", meta: {} } }); ts.pendingUser = ""; } };
  const endStream = () => { if (ts.streaming) { out.push({ type: "segment" }); ts.streaming = false; } };
  switch (frame.kind) {
    case "attached": {
      ts.state = "live";
      ts.running = Boolean(frame.running);
      if (frame.mode) ts.mode = frame.mode;
      if (frame.autopilot !== undefined) ts.autopilot = Boolean(frame.autopilot);
      if (frame.cleared) { ts.lastSeq = 0; ts.asks = {}; ts.pendingUser = ""; ts.streaming = false; out.push({ type: "clear" }); }
      ts.replayUntil = Number(frame.lastSeq) || 0;
      out.push({ type: "_attached", running: ts.running, mode: ts.mode, title: frame.title || "" });
      break;
    }
    case "clear": ts.asks = {}; ts.pendingUser = ""; ts.streaming = false; out.push({ type: "clear" }); break;
    case "accepted": if (frame.op === "prompt") { ts.running = true; ts.sentLocally = true; } break;
    case "userPrompt": {
      // The hook's record of a prompt (KAS does not echo live prompts): drawn on replay, or when
      // another window sent it; the sender's own page drew the bubble at send time.
      if (replay || !ts.sentLocally) { flushUser(); ts.pendingUser = String(frame.text || ""); ts.skipEcho = true; }
      break;
    }
    case "update": {
      const u = frame.update || {};
      const kind = u.sessionUpdate;
      if (kind === "user_message_chunk") {
        if (ts.skipEcho) break;   // the same prompt, echoed by KAS right after the hook's record
        const text = kasContentText(u.content) || (u.content && u.content.type === "image" ? "[image]" : "");
        if (replay || !ts.sentLocally) ts.pendingUser += text;
        break;
      }
      flushUser();
      if (kind !== "session_info_update" && kind !== "config_option_update" && kind !== "available_commands_update") ts.sentLocally = false;
      switch (kind) {
        case "agent_message_chunk": {
          const img = kasImageMarkdown(u.content);
          if (img) { endStream(); out.push({ type: "row", row: { role: "assistant", content: img, ts: "", cls: "", meta: {} } }); break; }
          const text = kasContentText(u.content);
          if (text) { ts.streaming = true; out.push({ type: "chunk", text, seq: frame.seq }); }
          break;
        }
        case "agent_thought_chunk": { const text = kasContentText(u.content); if (text) out.push({ type: "thinking", text }); break; }
        case "tool_call": {
          endStream();
          const done = u.status === "completed" || u.status === "failed";
          out.push({ type: "row", row: { role: "tool", content: String(u.title || u.kind || "tool"), ts: "", cls: "", meta: { tool_call_id: u.toolCallId || "", tool_name: u.kind || "", kind: u.kind || "", input: u.rawInput, done, mid: frame.seq !== undefined ? "kas:" + frame.seq : undefined } } });
          if (done) out.push({ type: "toolResult", tcid: u.toolCallId || "", output: kasToolOutput(u.content) || (u.rawOutput !== undefined ? JSON.stringify(u.rawOutput, null, 2) : (u.status === "failed" ? "❌ failed" : "")) });
          break;
        }
        case "tool_call_update": {
          const tcid = u.toolCallId || "";
          if (u.title || u.rawInput !== undefined) out.push({ type: "toolUpdate", tcid, title: u.title || "", input: u.rawInput });
          const output = kasToolOutput(u.content);
          if (output || u.status === "completed" || u.status === "failed") {
            const text = output || (u.rawOutput !== undefined ? JSON.stringify(u.rawOutput, null, 2) : "");
            out.push({ type: "toolResult", tcid, output: u.status === "failed" ? "❌ " + (text || "failed") : text });
          }
          break;
        }
        case "plan": {
          const entries = Array.isArray(u.entries) ? u.entries : [];
          if (entries.length) out.push({ type: "status", text: "Plan:\n" + entries.map((e) => (e.status === "completed" ? "☑ " : e.status === "in_progress" ? "◐ " : "☐ ") + String(e.content || "")).join("\n") });
          break;
        }
        case "current_mode_update": if (u.currentModeId) { ts.mode = u.currentModeId; out.push({ type: "_mode", mode: u.currentModeId }); } break;
        case "config_option_update": {
          const opts = Array.isArray(u.configOptions) ? u.configOptions : [];
          const cfgMsg = { type: "_config" };
          for (const o of opts) {
            if (!o) continue;
            if (o.id === "autopilot") cfgMsg.autopilot = o.currentValue === "on";
            else if (o.id === "model") cfgMsg.model = o.currentValue === "auto" ? "" : String(o.currentValue || "");
            else if (o.id === "effortLevel") cfgMsg.effort = String(o.currentValue || "");
            else if (o.id === "mode" && o.currentValue) cfgMsg.mode = String(o.currentValue);
          }
          if (Object.keys(cfgMsg).length > 1) { if (cfgMsg.autopilot !== undefined) ts.autopilot = cfgMsg.autopilot; if (cfgMsg.mode) ts.mode = cfgMsg.mode; out.push(cfgMsg); }
          break;
        }
        case "session_info_update": {
          const kiro = (u._meta && u._meta.kiro) || {};
          if (kiro.kind === "turn_start") ts.running = true;
          if (u.title || kiro.title) out.push({ type: "_title", title: String(u.title || kiro.title) });
          break;
        }
        default: break;
      }
      break;
    }
    case "ask": {
      flushUser();
      const rid = frame.requestId;
      if (frame.ask === "permission") {
        endStream();
        ts.asks[rid] = { kind: "permission", options: frame.options || [] };
        out.push({ type: "row", row: { role: "permission", content: String(frame.title || "tool"), ts: "", cls: "", meta: { request_id: String(rid), tool_title: String(frame.title || "tool"), tool_input: frame.rawInput !== undefined ? toolInputPreview(frame.rawInput) : undefined, options: frame.options || [] } } });
      } else {
        ts.asks[rid] = { kind: "userInput" };
        const options = Array.isArray(frame.options) ? frame.options : [];
        out.push({ type: "question", card: { ask_id: "kas:" + rid, questions: [{ key: "answer", question: String(frame.question || "").replace(/^\*\*|\*\*$/g, ""), options: options.map((o) => ({ label: String(o.title || ""), value: String(o.title || ""), description: o.description || (o.recommended ? "recommended" : "") })) }] } });
      }
      break;
    }
    case "askResolved": {
      const ask = ts.asks[frame.requestId];
      delete ts.asks[frame.requestId];
      if (ask && ask.kind === "userInput") out.push({ type: "questionResolved", qid: "kas:" + frame.requestId });
      else out.push({ type: "permissionResolved", requestId: String(frame.requestId) });
      break;
    }
    case "turnEnd": {
      flushUser();
      ts.running = false; ts.streaming = false; ts.sentLocally = false;
      out.push({ type: "done" });
      if (frame.stopReason && frame.stopReason !== "end_turn") out.push({ type: "status", text: "Turn ended: " + frame.stopReason });
      break;
    }
    case "error": {
      let text = String(frame.message || "error");
      if (frame.login) text += " — run `kiro-cli login` on the gateway host, then send again.";
      out.push({ type: "error", text });
      if (frame.op === "prompt" || frame.op === "new") { ts.running = false; out.push({ type: "done" }); }
      break;
    }
    case "childState": {
      if (frame.state !== "exited") break;
      flushUser();
      ts.state = "exited"; ts.running = false; ts.streaming = false; ts.asks = {};
      out.push({ type: "done" });
      const why = frame.reason === "login" ? "kiro-cli is not logged in: run `kiro-cli login` on the gateway host."
        : frame.reason === "idle" ? "kiro-cli for this workspace was stopped after idling."
        : "kiro-cli exited (code " + (frame.code === null || frame.code === undefined ? "?" : frame.code) + ")" + (frame.reason && frame.reason !== "exited" ? " — " + frame.reason : "") + ".";
      out.push({ type: "error", text: why });
      out.push({ type: "interrupted", text: "This Kiro-mode session is detached. Reload brings kiro-cli back and replays the transcript from Kiro's own store.", resume: true, label: "Reload session", hint: "Start kiro-cli for this workspace again and load this session (session/load)." });
      break;
    }
    default: break;
  }
  return out;
}
/** A short preview of a tool call's arguments for the approval card (JSON, clipped). */
function toolInputPreview(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string") return input.slice(0, 400);
  try { return JSON.stringify(input, null, 1).slice(0, 400); } catch { return String(input).slice(0, 400); }
}

/**
 * The Kas_Link (requirements 4.1, 4.3): one WebSocket per workspace to the
 * hook, reconnecting with the Feed's backoff (1 s doubling to 30 s), `hello`
 * on every open (the hook spawns or reuses the kiro-cli child), request/reply
 * correlation by `ref` for the ops that answer (`new`, `attach`, `config`,
 * `spec`, `prompt`'s `accepted`), and every frame fanned out to listeners.
 * Listeners also get `{kind: "_open"}` after a successful hello and
 * `{kind: "_closed"}` when the socket drops, so the ChatView re-attaches its
 * Kiro-mode tabs and shows "reconnecting".
 */
class KasLink {
  constructor(folder) {
    this.folder = folder;
    this.ws = null;
    this.delay = 1000;
    this.closed = false;
    this.listeners = new Set();
    this.pending = new Map();   // ref -> { resolve, reject, timer }
    this.nextRef = 1;
    this.hello = null;          // the last hello reply
    this.state = "idle";        // idle | connecting | open | reconnecting
    this.waiters = [];
  }
  url() { return ORIGIN.replace(/^http/, "ws") + KAS_WS_PATH; }
  start() {
    if (!ORIGIN || this.closed || this.ws) return;
    this.state = this.hello ? "reconnecting" : "connecting";
    let ws;
    try { ws = new WebSocket(this.url()); } catch (error) { this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 1000;
      this.request({ op: "hello", folder: this.folder }).then((reply) => {
        this.hello = reply;
        this.state = "open";
        for (const w of this.waiters.splice(0)) w.resolve(reply);
        this.emit({ kind: "_open", hello: reply });
      }).catch((error) => {
        this.state = "error";
        for (const w of this.waiters.splice(0)) w.reject(error);
        this.emit({ kind: "_helloFailed", error: String(error && error.message || error) });
      });
    };
    ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame && frame.ref !== undefined && frame.ref !== null && this.pending.has(String(frame.ref))) {
        const p = this.pending.get(String(frame.ref));
        if (frame.kind === "error") { this.pending.delete(String(frame.ref)); clearTimeout(p.timer); const err = new Error(frame.message || "KAS error"); err.frame = frame; p.reject(err); return; }
        if (frame.kind !== "update") { this.pending.delete(String(frame.ref)); clearTimeout(p.timer); p.resolve(frame); }
        if (frame.kind === "hello" || frame.kind === "created" || frame.kind === "configured" || frame.kind === "specResult" || frame.kind === "accepted") return;
      }
      this.emit(frame);
    };
    ws.onclose = () => { this.ws = null; const was = this.state; this.state = "reconnecting"; this.failPending("the connection to kiro-cli dropped"); if (was === "open" || was === "reconnecting") this.emit({ kind: "_closed" }); this.retry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };
  }
  retry() {
    if (this.closed) return;
    setTimeout(() => this.start(), this.delay);
    this.delay = Math.min(this.delay * 2, 30000);
  }
  failPending(why) {
    for (const [ref, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); this.pending.delete(ref); }
  }
  /** Resolves with the hello reply once the link is open (connecting if needed). */
  ready(timeout = KAS_REQUEST_TIMEOUT_MS) {
    if (this.state === "open" && this.ws && this.ws.readyState === 1) return Promise.resolve(this.hello);
    if (!this.ws) { this.delay = 1000; this.start(); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w.timer !== timer); reject(new Error("kiro-cli did not answer in time (hello)")); }, timeout);
      this.waiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer });
    });
  }
  send(frame) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("the connection to kiro-cli is not open" + (this.state === "reconnecting" ? " (reconnecting)" : ""));
    this.ws.send(JSON.stringify(frame));
  }
  /** Send a frame and resolve with its reply (matched by `ref`); rejects on an `error` reply or the timeout. */
  request(frame, timeout = KAS_REQUEST_TIMEOUT_MS) {
    const ref = "r" + (this.nextRef++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(ref); reject(new Error(frame.op + " timed out")); }, timeout);
      this.pending.set(ref, { resolve, reject, timer });
      try { this.send(Object.assign({}, frame, { ref })); } catch (error) { this.pending.delete(ref); clearTimeout(timer); reject(error); }
    });
  }
  emit(frame) {
    for (const fn of this.listeners) {
      try { fn(frame); } catch (error) { console.warn("[kirocrew] kas listener failed", error); }
    }
  }
  on(fn) { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }
  dispose() { this.closed = true; this.failPending("closed"); try { this.ws && this.ws.close(); } catch { /* closing */ } }
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

/** True for `.kiro/specs/<name>/{requirements,design,tasks}.md`. */
function isSpecDocument(uriPath) {
  return /[\\/]\.kiro[\\/]specs[\\/][^\\/]+[\\/](requirements|design|tasks)\.md$/.test(String(uriPath || ""));
}

/**
 * "Open Preview" for a spec file: the Kiro spec editor (beside the source when
 * asked, as Ctrl+K V does for markdown). A URI that is not a spec file goes to
 * the built-in preview, so the shared keys keep their meaning everywhere else.
 */
async function openSpecPreview(uri, beside) {
  const active = vscode.window.activeTextEditor;
  const target = uri && uri.path ? uri : active && active.document.uri;
  if (!target) return;
  if (!isSpecDocument(target.path)) {
    return vscode.commands.executeCommand(beside ? "markdown.showPreviewToSide" : "markdown.showPreview", target);
  }
  await vscode.commands.executeCommand("vscode.openWith", target, "kirocrew.spec", beside ? vscode.ViewColumn.Beside : undefined);
}

/**
 * The document the Specs view's Review action works on: the view's document
 * row (`documentUri`; a row for an unwritten document has none), a Uri (the
 * title bar), or — from the palette — the active spec document, text editor
 * or spec editor (`specCommandSource`). Null when nothing points at a spec
 * document.
 */
function specReviewTarget(arg, specEditors) {
  if (arg && arg.documentUri !== undefined) return arg.documentUri || null;
  const source = specCommandSource(arg, specEditors);
  return source ? source.uri : null;
}

/**
 * Review on a spec document (requirements 2.6, 7.5): open it in the spec
 * editor with review mode on. A spec editor already showing the document is
 * revealed and switched directly; otherwise the editor opens and gets the
 * request when its page says `ready` (`SpecEditorProvider.setReviewMode`
 * parks it until then). A document the spec editor does not show (bugfix.md)
 * opens as text, since review comments live in the spec editor. Returns the
 * Uri reviewed, or null when there was none.
 */
async function reviewSpecDocument(arg, specEditors) {
  const uri = specReviewTarget(arg, specEditors);
  if (!uri) { void vscode.window.showWarningMessage("Open a spec document (.kiro/specs/<name>/*.md) first."); return null; }
  if (!stageOf(uri.path)) {
    void vscode.window.showWarningMessage("Review mode is available for requirements, design and tasks; " + uri.path.split("/").pop() + " opens as text.");
    await vscode.commands.executeCommand("kirocrew.spec.open", uri);
    return null;
  }
  const shown = specEditors.panelsShowing(uri);
  if (shown.length) {
    const panel = shown.find((p) => p.active) || shown.find((p) => p.visible) || shown[0];
    if (typeof panel.reveal === "function") panel.reveal(undefined, false);
  } else {
    await vscode.commands.executeCommand("vscode.openWith", uri, "kirocrew.spec");
  }
  specEditors.setReviewMode(uri, true);
  return uri;
}

/**
 * While a spec file's SOURCE is the active editor, the built-in markdown
 * extension's own "Open Preview" button steps aside (`hasCustomMarkdownPreview`
 * is the context key it checks for exactly this) and the spec editor's button
 * takes its place. Cleared on any other text editor; a webview becoming active
 * (no text editor) leaves the keys alone.
 */
function markSpecEditor(editor) {
  if (!editor || !editor.document) return;
  const spec = isSpecDocument(editor.document.uri.path);
  void vscode.commands.executeCommand("setContext", "hasCustomMarkdownPreview", spec);
  void vscode.commands.executeCommand("setContext", "kirocrew.specFile", spec ? editor.document.uri.path.split("/").pop() : "");
}

/**
 * The spec document a navigation command starts from: the Uri the title bar
 * passed, else the active text editor's, else the active spec editor's (the
 * palette's previous/next while the custom editor has focus). Null when none
 * of them is inside `.kiro/specs/<name>/`.
 */
function specCommandSource(arg, specEditors) {
  const candidates = [
    ["argument", arg && arg.path !== undefined ? arg : null],
    ["textEditor", vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null],
    ["specEditor", specEditors && typeof specEditors.activeDocumentUri === "function" ? specEditors.activeDocumentUri() : null],
  ];
  for (const [origin, uri] of candidates) if (uri && specDirOf(uri.path) && specFileOf(uri.path)) return { uri, origin };
  return null;
}

/**
 * The Specs-view-shaped `{ spec, contextValue: "spec" }` node a run command
 * (Run all tasks, requirement 3.5) works on when it is invoked away from the
 * view: from the title bar with the document's Uri, from the keybinding with
 * no argument (the active text editor), or from the spec editor. A node the
 * view passed is returned as is. `specs` are listSpecs()' rows; the spec is
 * the one whose directory holds the document (`sameDir`, so a symlinked home
 * spelled two ways still matches). Null when nothing points at a listed spec,
 * which lets the caller fall back to its picker.
 */
function specRunNode(arg, specs, specEditors) {
  if (arg && arg.spec) return arg;
  const source = specCommandSource(arg, specEditors);
  if (!source) return null;
  const dir = specDirOf(source.uri.path);
  const spec = (specs || []).find((s) => s && s.dir && sameDir(s.dir.path, dir)) || null;
  return spec ? { spec, contextValue: "spec" } : null;
}

/**
 * Open `file` of the spec `from` belongs to, as text (the spec editor instead
 * when the user came from one and the target has a stage there). A target
 * that does not exist yet is created empty first — requirement 3.2 — so the
 * phase actions and "Sync with project files" have a document to work on.
 */
async function gotoSpecDocument(from, file, specEditors) {
  const source = specCommandSource(from, specEditors);
  if (!source) { void vscode.window.showWarningMessage("Open a spec document (.kiro/specs/<name>/*.md) first."); return null; }
  const target = source.uri.with({ path: specDirOf(source.uri.path) + "/" + file });
  try { await vscode.workspace.fs.stat(target); } catch { await vscode.workspace.fs.writeFile(target, new Uint8Array()); }
  if (source.origin === "specEditor" && isSpecDocument(target.path)) {
    await vscode.commands.executeCommand("vscode.openWith", target, "kirocrew.spec");
    return target;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { preview: false });
  return target;
}

/**
 * Previous (`delta` -1) / next (+1) document of the current spec in its
 * `documentOrder`; at either end nothing opens and the status bar says so.
 * Returns the file opened, or null.
 */
async function stepSpecDocument(from, delta, specEditors) {
  const source = specCommandSource(from, specEditors);
  if (!source) { void vscode.window.showWarningMessage("Open a spec document (.kiro/specs/<name>/*.md) first."); return null; }
  const config = await specConfigFor(source.uri);
  const current = specFileOf(source.uri.path);
  const target = adjacentSpecDocument(current, config, delta);
  if (!target) {
    const order = documentOrder(config);
    const why = order.includes(current)
      ? current + " is the " + (delta < 0 ? "first" : "last") + " document of this spec (" + order.map((f) => f.replace(/\.md$/, "")).join(" → ") + ")"
      : current + " is not one of this spec's documents (" + order.join(", ") + ")";
    vscode.window.setStatusBarMessage("KiroCrew: " + why, 5000);
    return null;
  }
  // Pass the source the way it was found, so a step taken inside the spec editor stays there.
  await gotoSpecDocument(source.origin === "argument" ? from : undefined, target, specEditors);
  return target;
}

/** The spec config of the spec a document belongs to: the cached SpecModel's, else read from `.config.kiro` (defaults when absent). */
async function specConfigFor(uri) {
  let config = null;
  try { const model = specModels ? await specModels.forDocument(uri) : null; config = model ? model.config : null; } catch { config = null; }
  return config || readSpecConfig(uri.with({ path: specDirOf(uri.path) }));
}

/** `{ text, dirty }` of a spec document: the open text document's when the editor has it, else the file on disk (text null when absent). */
async function specDocumentState(uri) {
  const open = (vscode.workspace.textDocuments || []).find((d) => d.uri && d.uri.path === uri.path) || null;
  if (open) return { text: open.getText(), dirty: Boolean(open.isDirty), document: open };
  return { text: await readWholeText(uri), dirty: false, document: null };
}

/**
 * "Sync with project files" (requirement 3.3): the update turn for the spec
 * document the title bar, the active text editor or the spec editor shows,
 * through `chat.sendSpecTurn(feature, "update", document)` — the Spec_Agent,
 * the spec's idle session when it has one, the siblings as context. Unsaved
 * edits are saved first so the agent reads what the user sees; an empty,
 * clean document is refused with a hint (the key normally hides the action).
 * Returns sendSpecTurn's `{ key, reused }`, or null when nothing was sent.
 */
async function syncSpecDocument(from, specEditors, chat) {
  const source = specCommandSource(from, specEditors);
  if (!source) { void vscode.window.showWarningMessage("Open a spec document (.kiro/specs/<name>/*.md) first."); return null; }
  const file = specFileOf(source.uri.path);
  const state = await specDocumentState(source.uri);
  if (!specDocumentHasContent(state.text, state.dirty)) {
    void vscode.window.showWarningMessage(file + " is empty — write a draft first, or use \"Next document\" from the previous one to have it generated.");
    return null;
  }
  if (state.document && state.dirty) await state.document.save();
  const dir = source.uri.with({ path: specDirOf(source.uri.path) });
  try {
    return await chat.sendSpecTurn(dir.path.split("/").pop(), "update", file, { dir });
  } catch (error) {
    void vscode.window.showErrorMessage("KiroCrew: sync " + file + ": " + (error && error.message ? error.message : String(error)));
    return null;
  }
}

/**
 * "Next document" (requirement 3.4): `nextDocumentDecision` on the current
 * document — the next one of the order is opened when it already has content
 * (on disk or unsaved in an editor), generated by the Spec_Agent through
 * `chat.sendSpecTurn(feature, "generate", next)` otherwise. At the end of the
 * order nothing happens and the status bar says why (stepSpecDocument's
 * message). Returns the decision taken, or null when nothing applied.
 */
async function nextSpecDocument(from, specEditors, chat) {
  const source = specCommandSource(from, specEditors);
  if (!source) { void vscode.window.showWarningMessage("Open a spec document (.kiro/specs/<name>/*.md) first."); return null; }
  const config = await specConfigFor(source.uri);
  const current = specFileOf(source.uri.path);
  const dirPath = specDirOf(source.uri.path);
  const next = adjacentSpecDocument(current, config, 1);
  if (!next) { await stepSpecDocument(from, 1, specEditors); return null; }
  const state = await specDocumentState(source.uri.with({ path: dirPath + "/" + next }));
  const decision = nextDocumentDecision(current, config, specDocumentHasContent(state.text, state.dirty));
  if (decision.action === "open") {
    await gotoSpecDocument(source.origin === "argument" ? from : undefined, decision.file, specEditors);
    return decision;
  }
  try {
    await chat.sendSpecTurn(dirPath.split("/").pop(), "generate", decision.file, { dir: source.uri.with({ path: dirPath }) });
  } catch (error) {
    void vscode.window.showErrorMessage("KiroCrew: generate " + decision.file + ": " + (error && error.message ? error.message : String(error)));
    return null;
  }
  return decision;
}

/** The names of the spec directories under `<folder>/.kiro/specs/` (files there are ignored); empty when the folder has none. */
async function existingSpecNames(folder) {
  const root = vscode.Uri.joinPath(folder.uri, ".kiro", "specs");
  try {
    return (await vscode.workspace.fs.readDirectory(root)).filter(([, kind]) => kind === vscode.FileType.Directory).map(([name]) => name);
  } catch { return []; }
}

/**
 * The Specs view's ＋ (requirements 2.1, 2.2, 1.2): ask for the feature idea
 * (an empty one is refused in the box), pick the workflow type (requirements
 * first by default) and the spec type (feature by default), derive the
 * directory name from the idea (`specNameFromIdea`; when a spec of that name
 * already exists the user is asked for another, validated against
 * `^[A-Za-z0-9_-]+$` and the names taken, and may cancel), write
 * `.kiro/specs/<name>/.config.kiro` with a fresh specId and the two choices,
 * then send the create turn through `chat.sendSpecTurn(name, "create",
 * <first document of the order>, { dir, idea })`, whose tab title is the idea.
 * Escape at any step aborts with nothing written. With several workspace
 * folders the first question is which one. Returns `{ name, dir, config, key,
 * reused }`, or null when the user cancelled or nothing could be sent.
 */
async function createSpecFromIdea(chat, specsTree) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) { void vscode.window.showErrorMessage("Open a folder first — a spec lives in its .kiro/specs/."); return null; }
  let folder = folders[0];
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.path, folder: f })), { placeHolder: "Which workspace folder gets the spec?" });
    if (!picked) return null;
    folder = picked.folder;
  }
  const idea = await vscode.window.showInputBox({
    title: "New spec",
    prompt: "What should this feature (or fix) do? One or two sentences — this names the spec and titles its chat tab.",
    placeHolder: "e.g. Add dark mode to the settings page",
    ignoreFocusOut: true,
    validateInput: (v) => (String(v || "").trim() ? null : "Describe the idea first."),
  });
  if (idea === undefined) return null;
  const ideaText = String(idea).trim().replace(/\s+/g, " ");
  if (!ideaText) return null;
  const workflow = await vscode.window.showQuickPick(WORKFLOW_TYPE_PICKS.map((p) => Object.assign({}, p)), { title: "New spec · workflow type", placeHolder: "How should the documents be produced?", ignoreFocusOut: true });
  if (!workflow) return null;
  const type = await vscode.window.showQuickPick(SPEC_TYPE_PICKS.map((p) => Object.assign({}, p)), { title: "New spec · spec type", placeHolder: "What kind of spec is this?", ignoreFocusOut: true });
  if (!type) return null;
  const taken = await existingSpecNames(folder);
  let name = specNameFromIdea(ideaText);
  if (validateSpecName(name, taken)) {
    // The derived name is taken (or unusable): ask for another; Escape aborts with nothing written.
    const chosen = await vscode.window.showInputBox({
      title: "New spec · directory name",
      prompt: "A spec named " + name + " already exists in " + folder.name + ". Pick another directory name.",
      value: name,
      valueSelection: [0, name.length],
      ignoreFocusOut: true,
      validateInput: (v) => validateSpecName(v, taken),
    });
    if (chosen === undefined) return null;
    name = String(chosen).trim();
    if (validateSpecName(name, taken)) return null;
  }
  const dir = vscode.Uri.joinPath(folder.uri, ".kiro", "specs", name);
  // Kiro writes `.config.kiro` (spec id and the two types) alongside the documents; so do we,
  // before the turn, so the Spec_Agent and the Specs view read the same choices.
  let config;
  try {
    config = await writeSpecConfig(dir, newSpecConfig({ workflowType: workflow.value, specType: type.value }));
  } catch (error) {
    void vscode.window.showErrorMessage("KiroCrew: could not create " + name + ": " + (error && error.message ? error.message : String(error)));
    return null;
  }
  if (specsTree && typeof specsTree.refresh === "function") specsTree.refresh(); // the watcher does this too; this is for the eye
  try {
    const sent = await chat.sendSpecTurn(name, "create", documentOrder(config)[0], { dir, idea: ideaText });
    return Object.assign({ name, dir, config }, sent);
  } catch (error) {
    void vscode.window.showErrorMessage("KiroCrew: create spec " + name + ": " + (error && error.message ? error.message : String(error)) + " — the directory and .config.kiro were written; use Write requirements on the spec to start.");
    return { name, dir, config, key: null, reused: false };
  }
}

/** The workspace folder a spec row's directory lives in (the node carries it; fall back to the Uri lookup). */
function specFolderOf(spec) {
  return (spec && spec.workspace) || (spec && spec.dir && vscode.workspace.getWorkspaceFolder && vscode.workspace.getWorkspaceFolder(spec.dir)) || null;
}

/**
 * The Specs view's Rename row action (requirement 2.3): an input box prefilled
 * with the current name, validated as typed by `validateSpecName(name, taken,
 * current)` — so an empty, malformed, unchanged or taken name cannot be
 * submitted — then `.kiro/specs/<old>` is renamed to `.kiro/specs/<new>` in
 * place (the documents, `.config.kiro` and anything else inside move with it)
 * and the tree refreshes. Escape leaves the directory alone. Returns `{ from,
 * to, name }` on success, null when cancelled or when the rename failed (an
 * error message says why).
 */
async function renameSpec(spec, specsTree) {
  if (!spec || !spec.dir || !spec.name) return null;
  const folder = specFolderOf(spec);
  const taken = folder ? await existingSpecNames(folder) : [];
  const chosen = await vscode.window.showInputBox({
    title: "Rename spec " + spec.name,
    prompt: "New directory name for .kiro/specs/" + spec.name + " — letters, digits, `_` and `-`.",
    value: spec.name,
    valueSelection: [0, spec.name.length],
    ignoreFocusOut: true,
    validateInput: (v) => validateSpecName(v, taken, spec.name),
  });
  if (chosen === undefined) return null;
  const name = String(chosen).trim();
  if (validateSpecName(name, taken, spec.name)) return null;
  const to = spec.dir.with({ path: spec.dir.path.replace(/\/+$/, "").replace(/[^/]+$/, name) }); // sibling of the old directory
  try {
    await vscode.workspace.fs.rename(spec.dir, to, { overwrite: false });
  } catch (error) {
    void vscode.window.showErrorMessage("KiroCrew: could not rename " + spec.name + " to " + name + ": " + (error && error.message ? error.message : String(error)));
    return null;
  }
  if (specsTree && typeof specsTree.refresh === "function") specsTree.refresh(); // the watcher sees the directory move too; this is for the eye
  return { from: spec.dir, to, name };
}

/** The Delete confirmation's button label (the dialog's only non-cancel choice). */
const SPEC_DELETE_BUTTON = "Delete";

/**
 * The Specs view's Delete row action (requirement 2.4): a modal warning that
 * names the directory about to go (`.kiro/specs/<name>` under the folder, the
 * full path in the detail), with a single Delete button; Escape or closing the
 * dialog deletes nothing. On confirm the directory is removed recursively
 * (documents, `.config.kiro`, everything inside) and the tree refreshes.
 * Returns the deleted directory's Uri, or null when cancelled or when the
 * delete failed (an error message says why).
 */
async function deleteSpec(spec, specsTree) {
  if (!spec || !spec.dir || !spec.name) return null;
  const folder = specFolderOf(spec);
  const shown = folder ? folder.name + "/" + relPath(spec.dir, folder) : spec.dir.path;
  const answer = await vscode.window.showWarningMessage(
    "Delete the spec " + spec.name + "? This removes the directory " + shown + " and everything in it.",
    { modal: true, detail: spec.dir.fsPath || spec.dir.path },
    SPEC_DELETE_BUTTON,
  );
  if (answer !== SPEC_DELETE_BUTTON) return null;
  try {
    await vscode.workspace.fs.delete(spec.dir, { recursive: true, useTrash: false });
  } catch (error) {
    void vscode.window.showErrorMessage("KiroCrew: could not delete " + spec.name + ": " + (error && error.message ? error.message : String(error)));
    return null;
  }
  if (specsTree && typeof specsTree.refresh === "function") specsTree.refresh(); // the watcher sees the directory go too; this is for the eye
  return spec.dir;
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
    s = s.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, bang, label, url) => {
      // An image: an https URL loads as is; a local path is a placeholder the webview fills
      // in through the extension (it reads the bytes; the page cannot reach the disk). A
      // path without an image extension is a link like any other.
      if (bang && /^https?:\/\//.test(url)) return hold('<img class="mdimg" src="' + esc(url) + '" alt="' + esc(label) + '" title="' + esc(label || url) + '">');
      if (bang && /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(url) && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return hold('<img class="mdimg" data-path="' + esc(url) + '" alt="' + esc(label) + '" title="' + esc(label || url) + '">');
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

/** Longest quoted passage a review comment carries (characters); longer blocks are cut with an ellipsis. */
const REVIEW_EXCERPT_MAX = 160;

/**
 * The id a review comment anchors to (requirement 7.4). Pure and
 * SELF-CONTAINED: `reviewBlockId.toString()` is embedded in the spec editor
 * page, which assigns one to every rendered block. The id is a hash of the
 * block's kind (`h`, `p`, `li`, `code`, `table`, `quote`) and its
 * whitespace-collapsed text, with `occurrence` (0-based) telling apart blocks
 * with the same text (`_Requirements: 1.1_` under several tasks). Hashing the
 * text instead of the line number keeps a comment on its passage when lines
 * are added above it and lets a Sync Files re-render re-attach every comment
 * whose block did not change; a block whose text changed gets a new id and
 * its comment is listed as unanchored instead of being lost.
 */
function reviewBlockId(kind, text, occurrence) {
  const s = String(kind || "p") + "\n" + String(text || "").replace(/\s+/g, " ").trim();
  let h = 2166136261; // FNV-1a, 32-bit
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "b" + h.toString(36) + (occurrence ? "-" + occurrence : "");
}

/** A review excerpt cut to REVIEW_EXCERPT_MAX with an ellipsis, whitespace collapsed (the page's rvExcerpt, applied again here so a foreign message cannot inflate the turn). */
function reviewExcerpt(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > REVIEW_EXCERPT_MAX ? s.slice(0, REVIEW_EXCERPT_MAX - 1).trimEnd() + "…" : s;
}

/**
 * The review turn (requirement 7.2), pure: `comments` are the page's
 * `[{blockId, excerpt, text}]` on `file` of the spec `feature`. Returns
 * `{ text, displayText }`: `text` is the body specTurnText("review") wraps in
 * the spec rules and its PHASE line — a header naming the document, one item
 * per comment (the quoted passage, then the comment) and our instruction to
 * apply each comment to that document and nothing else; `displayText` is the
 * transcript's bubble, "Review: N comments on <file>". Comments with no text
 * are skipped; with none left both strings are empty (nothing to send).
 */
function buildReviewTurn({ feature, file, comments } = {}) {
  const name = String(feature || "").trim() || "spec";
  const doc = specDocumentName(file) || "document";
  const items = (Array.isArray(comments) ? comments : [])
    .map((c) => ({ excerpt: reviewExcerpt(c && c.excerpt), text: String((c && c.text) || "").trim() }))
    .filter((c) => c.text);
  if (!items.length) return { text: "", displayText: "" };
  const n = items.length;
  const count = n + (n === 1 ? " comment" : " comments");
  const lines = ["Review comments on " + name + "/" + doc + " (" + count + "):", ""];
  items.forEach((c, i) => {
    lines.push(String(i + 1) + ". " + (c.excerpt ? "On the passage:" : "On the document as a whole:"));
    if (c.excerpt) lines.push("   > " + c.excerpt);
    lines.push("   Comment: " + c.text.replace(/\r?\n/g, "\n   "), "");
  });
  lines.push("Apply each comment to " + doc + " of this spec, in the passage it quotes, and keep everything else in the document as it is: do not renumber or rewrite what no comment touches, and do not edit the other documents (fix a reference in them only when a change here breaks it). Do not implement code. When the file is written, list what changed, comment by comment.");
  return { text: lines.join("\n"), displayText: "Review: " + count + " on " + doc };
}

/**
 * The spec editor page. The document body arrives by message, rendered by the
 * engine's OWN markdown renderer (`markdown.api.render`: the built-in preview's
 * markdown-it, GFM, highlight.js code colours) or, when that command is not
 * around, by `mdToHtml`. The page then adds what the built-in preview does not
 * have: a language label and Copy on every code block, Kiro's task boxes with
 * a ▶ Start task per open row, and mermaid diagrams drawn in place with the
 * library the hook vendors in (`assets.mermaid`, null when it is not there —
 * the fence then stays a code block). Review mode (requirement 7) lives in
 * the page too: a banner toggle, a comment box under the clicked block, cards
 * with Edit/Delete, the comments kept by block id across a Sync Files
 * re-render and nowhere else (closing the editor drops them).
 */
function specEditorHtml(specName, stage, present, assets) {
  const crumbs = STAGES.map((s) => {
    const here = s.file === stage.file;
    const missing = !present[s.file];
    return "<button class='stage" + (here ? " on" : "") + (missing ? " missing" : "") + "' data-file='" + s.file + "'" + (missing ? " title='not written yet'" : "") + "><span class='n'>" + s.n + "</span>" + s.label + "</button>";
  }).join("<span class='sep'>›</span>");
  const mermaidTag = assets && assets.mermaid ? '<script src="' + String(assets.mermaid).replace(/"/g, "&quot;") + '"></script>' : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
 :root{color-scheme:light dark}
 body{margin:0;font:13px/1.55 var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
 #banner{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--vscode-editorWidget-background);border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));z-index:2;flex-wrap:wrap}
 #banner .name{font-weight:600;margin-right:4px}
 .stage{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--vscode-button-secondaryBackground);background:transparent;color:inherit;border-radius:3px;padding:3px 10px;cursor:pointer;font:inherit}
 .stage.on{background:var(--vscode-button-secondaryBackground)}
 .stage.missing{opacity:.5}
 .stage .n{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:2px;padding:0 5px;font-size:11px}
 .sep{opacity:.4}
 #actions{margin-left:auto;display:flex;gap:8px}
 #actions button{border:0;border-radius:3px;padding:4px 12px;cursor:pointer;font:inherit;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 #actions #continue{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
 #doc{max-width:920px;margin:0 auto;padding:16px 22px 60px;word-wrap:break-word}
 #doc h1{font-size:1.5em}#doc h2{font-size:1.25em;border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));padding-bottom:4px}#doc h3{font-size:1.1em}
 #doc code{background:var(--vscode-textCodeBlock-background);border-radius:2px;padding:1px 5px;font-family:var(--vscode-editor-font-family);font-size:.92em}
 #doc pre{margin:0;padding:10px 12px;overflow:auto;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size,13px);line-height:1.45}
 #doc pre code{background:transparent;padding:0;font-size:inherit;display:block}
 #doc pre code > div{display:inline}
 #doc .codeblock{margin:8px 0;border-radius:3px;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));overflow:hidden}
 #doc .codebar{display:flex;align-items:center;justify-content:space-between;padding:2px 10px;font-size:11px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))}
 #doc .codebar .copy{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 4px;margin:0}#doc .codebar .copy:hover{text-decoration:underline;color:var(--vscode-foreground)}
 #doc table{border-collapse:collapse;margin:8px 0;display:block;overflow:auto}#doc th,#doc td{border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));padding:3px 8px;vertical-align:top}#doc th{background:var(--vscode-editorWidget-background)}
 #doc ol{padding-left:22px}#doc del{opacity:.7}#doc a{color:var(--vscode-textLink-foreground);text-decoration:none;cursor:pointer}#doc a:hover{text-decoration:underline}
 #doc ul{padding-left:22px}#doc li{margin:2px 0}#doc img{max-width:100%}
 #doc blockquote{border-left:3px solid var(--vscode-focusBorder);margin:8px 0;padding:2px 12px;opacity:.85}
 #doc hr{border:0;border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border))}
 .box{opacity:.8}.box.on{color:var(--vscode-charts-green,inherit)}.box.part{opacity:.6}.box.queued{opacity:.7}.box.optional{opacity:.55}
 .start{margin-left:8px;border:1px solid var(--vscode-button-secondaryBackground);background:transparent;color:var(--vscode-textLink-foreground);border-radius:3px;padding:0 7px;cursor:pointer;font:inherit;font-size:11px;line-height:18px;vertical-align:middle;opacity:.6}
 #doc li:hover>.start,.start:focus,.start:hover{opacity:1}
 .start.state{cursor:default;color:var(--vscode-descriptionForeground);border-color:transparent;opacity:1}
 .start.state.part::before{content:'';display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:var(--vscode-focusBorder);animation:kide-pulse 1.1s ease-in-out infinite;vertical-align:middle}
 @keyframes kide-pulse{0%,100%{opacity:.35}50%{opacity:1}}
 .path{opacity:.7;font-family:var(--vscode-editor-font-family);font-size:12px}
 #stale{display:none;position:sticky;top:44px;text-align:center;font-size:12px;padding:3px;background:var(--vscode-inputValidation-infoBackground);border-bottom:1px solid var(--vscode-inputValidation-infoBorder)}
 /* Find in the document (Ctrl/Cmd+F): a row of the sticky banner, like the editor's find widget.
    Every match is marked, the current one stronger; on tasks.md a Filter hides the task rows
    that do not match (a row stays when its parent or a sub-task matches). */
 #find{flex:1 0 100%;display:flex;align-items:center;gap:6px;margin-top:6px;padding-top:6px;border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border))}
 #find[hidden]{display:none}
 #find input{flex:0 1 260px;min-width:120px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;padding:3px 6px;font:inherit}
 #find input:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
 #find.none input{outline:1px solid var(--vscode-inputValidation-errorBorder,#be1100);outline-offset:-1px}
 #find .count{font-size:11px;color:var(--vscode-descriptionForeground);min-width:64px;white-space:nowrap}
 #find button{border:1px solid transparent;background:transparent;color:inherit;border-radius:3px;padding:2px 6px;cursor:pointer;font:inherit;line-height:1.2}
 #find button:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-button-secondaryBackground))}
 #find button[aria-pressed="true"]{background:var(--vscode-inputOption-activeBackground,var(--vscode-button-secondaryBackground));border-color:var(--vscode-inputOption-activeBorder,transparent);color:var(--vscode-inputOption-activeForeground,inherit)}
 #find button:disabled{opacity:.4;cursor:default}
 #find .close{margin-left:auto}
 #find .filter[hidden]{display:none}
 mark.hit{background:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33));color:inherit;border-radius:2px;padding:0}
 mark.hit.cur{background:var(--vscode-editor-findMatchBackground,rgba(168,172,148,.6));outline:1px solid var(--vscode-editor-findMatchBorder,transparent)}
 #doc li.find-hide{display:none}
 /* Review mode (requirement 7): the toggle carries a count badge; "Send N comments" shows as soon as
    there is one, review mode on or off. While on, every block is a click target (an outline on hover,
    a bar on the left once commented), the comment box opens under the block, saved comments are
    cards under their block, and comments whose block is gone after a re-render are listed in the
    banner row so nothing is silently lost. Off hides the cards and the box, keeps the comments. */
 #reviewbtn .badge{display:none;margin-left:5px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:4px;padding:0 5px;font-size:11px;line-height:16px;vertical-align:1px}
 #reviewbtn .badge.show{display:inline-block}
 #actions button[aria-pressed="true"]{background:var(--vscode-inputOption-activeBackground,var(--vscode-button-secondaryBackground));color:var(--vscode-inputOption-activeForeground,inherit);outline:1px solid var(--vscode-inputOption-activeBorder,transparent);outline-offset:-1px}
 #reviewsend{display:none}#reviewsend.show{display:inline-block}
 #review{flex:1 0 100%;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:6px;padding-top:6px;border-top:1px solid var(--vscode-widget-border,var(--vscode-panel-border));font-size:12px;color:var(--vscode-descriptionForeground)}
 #review[hidden]{display:none}
 #review .status{margin-left:auto;white-space:nowrap}
 #review .orphans{flex:1 0 100%;display:none;flex-direction:column;gap:4px}
 #review .orphans.show{display:flex}
 #review .orphan{display:flex;gap:8px;align-items:baseline;padding:3px 8px;border-radius:4px;background:var(--vscode-inputValidation-warningBackground,rgba(255,204,0,.12));border:1px solid var(--vscode-inputValidation-warningBorder,transparent);color:var(--vscode-foreground)}
 #review .orphan .q{flex:0 1 40%;opacity:.75;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 #review .orphan .t{flex:1 1 auto;white-space:pre-wrap}
 body.review #doc .rv-block{cursor:pointer;border-radius:4px}
 body.review #doc .rv-block:hover:not(:has(.rv-block:hover)){outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
 body.review #doc .rv-block.rv-has{box-shadow:-8px 0 0 -5px var(--vscode-focusBorder)}
 .review-editor,.review-card{margin:6px 0 8px;padding:7px 10px;border-radius:5px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));font-size:12px;cursor:default;font-weight:normal;font-style:normal;text-align:left}
 .review-editor{padding:8px}
 .review-editor textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:5px 7px;font:inherit;line-height:1.4}
 .review-editor textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
 .review-editor .row,.review-card .row{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;color:var(--vscode-descriptionForeground)}
 .review-editor .hint,.review-card .when{margin-left:auto;white-space:nowrap}
 .review-editor button,.review-card button,#review button{border:1px solid transparent;border-radius:4px;padding:2px 9px;cursor:pointer;font:inherit;font-size:12px;line-height:1.4;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 .review-editor button.save{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
 .review-editor button:disabled{opacity:.5;cursor:default}
 .review-card{border-left:3px solid var(--vscode-focusBorder)}
 .review-card .excerpt{color:var(--vscode-descriptionForeground);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .review-card .excerpt::before{content:'\\201C'}.review-card .excerpt::after{content:'\\201D'}
 .review-card .text{margin-top:3px;white-space:pre-wrap;color:var(--vscode-foreground)}
 .review-card[hidden]{display:none}
 body:not(.review) .review-card,body:not(.review) .review-editor{display:none}
 .mermaid{margin:8px 0 16px;overflow-x:auto}.mermaid>svg{max-width:100%;height:auto}
 .mermaid-error{padding:4px 8px;font-family:var(--vscode-editor-font-family);font-size:12px;color:var(--vscode-errorForeground);border-left:3px solid var(--vscode-errorForeground)}
 /* highlight.js token colours, one palette per theme kind (the body carries vscode-light / vscode-dark / vscode-high-contrast). */
 .hljs-comment,.hljs-quote{color:#6a9955}.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-name,.hljs-tag{color:#569cd6}
 .hljs-string,.hljs-meta .hljs-string,.hljs-addition{color:#ce9178}.hljs-number,.hljs-regexp{color:#b5cea8}
 .hljs-title,.hljs-function .hljs-title,.hljs-section{color:#dcdcaa}.hljs-type,.hljs-class .hljs-title,.hljs-built_in,.hljs-title.class_{color:#4ec9b0}
 .hljs-attr,.hljs-attribute,.hljs-variable,.hljs-template-variable,.hljs-params,.hljs-property{color:#9cdcfe}
 .hljs-meta,.hljs-doctag,.hljs-selector-id,.hljs-selector-class{color:#c586c0}.hljs-symbol,.hljs-bullet,.hljs-link{color:#d7ba7d}
 .hljs-deletion{color:#f44747}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}
 body.vscode-light .hljs-comment,body.vscode-light .hljs-quote{color:#008000}body.vscode-light .hljs-keyword,body.vscode-light .hljs-selector-tag,body.vscode-light .hljs-literal,body.vscode-light .hljs-name,body.vscode-light .hljs-tag{color:#0000ff}
 body.vscode-light .hljs-string,body.vscode-light .hljs-meta .hljs-string,body.vscode-light .hljs-addition{color:#a31515}body.vscode-light .hljs-number,body.vscode-light .hljs-regexp{color:#098658}
 body.vscode-light .hljs-title,body.vscode-light .hljs-function .hljs-title,body.vscode-light .hljs-section{color:#795e26}body.vscode-light .hljs-type,body.vscode-light .hljs-class .hljs-title,body.vscode-light .hljs-built_in,body.vscode-light .hljs-title.class_{color:#267f99}
 body.vscode-light .hljs-attr,body.vscode-light .hljs-attribute,body.vscode-light .hljs-variable,body.vscode-light .hljs-template-variable,body.vscode-light .hljs-params,body.vscode-light .hljs-property{color:#001080}
 body.vscode-light .hljs-meta,body.vscode-light .hljs-doctag,body.vscode-light .hljs-selector-id,body.vscode-light .hljs-selector-class{color:#af00db}body.vscode-light .hljs-symbol,body.vscode-light .hljs-bullet,body.vscode-light .hljs-link{color:#0451a5}
 body.vscode-light .hljs-deletion{color:#a31515}
 body.vscode-high-contrast .hljs-keyword,body.vscode-high-contrast .hljs-literal,body.vscode-high-contrast .hljs-tag{font-weight:600}
</style></head><body>
<div id="noscript-hint" style="padding:10px 12px;font-size:12px;opacity:.7">Loading the spec editor&hellip; If this line never disappears, scripts inside webviews are blocked &mdash; screenshot this and report it. The markdown source is available via right-click &rarr; Reopen Editor With &rarr; Text Editor.</div>
<div id="banner"><span class="name">${specName}</span>${crumbs}
 <span id="actions"><button id="findbtn" title="Find in this document (Ctrl+F / ⌘F)">🔍 Find</button><button id="reviewbtn" title="Review mode: click a block of the document to comment on it" aria-pressed="false">💬 Review<span class="badge" id="reviewcount">0</span></button><button id="reviewsend" title="Send every comment to the Spec agent as one request">Send 0 comments</button><button id="edit" title="Open the markdown source in a text editor">Edit source</button><button id="sync" title="Reload this document from disk">⟳ Sync Files</button><button id="continue" title="">→ Continue</button></span>
 <div id="review" role="region" aria-label="Review comments" hidden><span class="hint">Click a heading, paragraph, list item, task row, code block or table to comment on it. Esc cancels, Ctrl+Enter saves.</span><span class="status" id="reviewstatus">No comments yet.</span><div class="orphans" id="revieworphans"></div></div>
 <div id="find" role="search" hidden><input id="findtext" type="text" placeholder="Find" spellcheck="false" aria-label="Find in document"><span class="count" id="findcount" aria-live="polite"></span><button type="button" id="findprev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button><button type="button" id="findnext" title="Next match (Enter)" aria-label="Next match">↓</button><button type="button" id="findcase" title="Match case" aria-pressed="false">Aa</button><button type="button" id="findfilter" class="filter" title="Show only the task rows that match" aria-pressed="false" hidden>Filter tasks</button><button type="button" class="close" id="findclose" title="Close (Esc)" aria-label="Close find">✕</button></div></div>
<div id="stale">updated on disk — synced</div>
<div id="doc"></div>
${mermaidTag}
<script>
document.getElementById('noscript-hint').remove();
const vscode = acquireVsCodeApi();
const STAGE_FILE = ${JSON.stringify(stage.file)};
const BOX = { ' ': ['open', '☐'], 'x': ['on', '☑'], '-': ['part', '◪'], '~': ['queued', '◷'] };
let tasks = [];
document.querySelectorAll('.stage').forEach(b=>b.onclick=()=>vscode.postMessage({type:'stage', file:b.dataset.file}));
document.addEventListener('click', (e)=>{ const a=e.target.closest && e.target.closest('a, button.copy, button.start'); if(!a) return;
  if(a.classList.contains('start')){ e.preventDefault(); if(!a.classList.contains('state')) vscode.postMessage({type:'startTask', line:Number(a.dataset.line)}); return; }
  if(a.classList.contains('copy')){ e.preventDefault(); const pre=a.closest('.codeblock').querySelector('pre'); vscode.postMessage({type:'copy', text: pre?pre.textContent:''}); a.textContent='Copied'; setTimeout(()=>{a.textContent='Copy';},1200); return; }
  if(a.tagName!=='A') return;
  e.preventDefault();
  if(a.dataset.url) return void vscode.postMessage({type:'link', url:a.dataset.url});
  if(a.dataset.path) return void vscode.postMessage({type:'open', path:a.dataset.path, line:a.dataset.line?Number(a.dataset.line):undefined, column:a.dataset.col?Number(a.dataset.col):undefined});
  const href=a.getAttribute('href')||'';
  if(href.startsWith('#')){ const id=decodeURIComponent(href.slice(1)); const t=document.getElementById(id)||document.querySelector('[name="'+id+'"]'); if(t) t.scrollIntoView(); return; }
  if(/^[a-z][a-z0-9+.-]*:/i.test(href)) vscode.postMessage({type:'link', url:href}); else vscode.postMessage({type:'open', path:href.split('#')[0], relative:true}); });
document.getElementById('sync').onclick=()=>vscode.postMessage({type:'sync'});
document.getElementById('continue').onclick=()=>vscode.postMessage({type:'continue'});
document.getElementById('edit').onclick=()=>vscode.postMessage({type:'edit'});
// Every fenced block gets the bar the editor has always had: the language and a Copy.
// The built-in renderer emits <pre><code class="language-x">; mdToHtml already wraps its own.
function dressCode(){
  document.querySelectorAll('#doc pre > code').forEach((code)=>{
    const pre=code.parentElement; if(pre.closest('.codeblock')) return;
    const m=(code.className||'').match(/(?:^|\\s)(?:language|lang)-([\\w+#.-]+)/); const lang=m?m[1]:'';
    if(lang==='mermaid'||lang==='mmd') return; // drawn by drawMermaid, or left as a block there
    const wrap=document.createElement('div'); wrap.className='codeblock';
    const bar=document.createElement('div'); bar.className='codebar';
    const l=document.createElement('span'); l.className='lang'; l.textContent=lang||'text';
    const c=document.createElement('button'); c.type='button'; c.className='copy'; c.title='Copy'; c.textContent='Copy';
    bar.appendChild(l); bar.appendChild(c); pre.parentNode.insertBefore(wrap, pre); wrap.appendChild(bar); wrap.appendChild(pre);
  });
}
// Kiro's task rows. The built-in renderer prints the bracket text as is; each such row becomes a
// .box with the task's SOURCE LINE (the k-th task row of the document is the k-th task the
// extension parsed from the same text), which is what a Start click sends back.
function dressTasks(){
  if(document.querySelector('#doc .box[data-line]')) return; // mdToHtml output: already boxed
  let k=0;
  document.querySelectorAll('#doc li').forEach((li)=>{
    let node=li.firstChild; while(node && node.nodeType===1 && node.tagName==='P' && node.firstChild) node=node.firstChild;
    if(!node || node.nodeType!==3) return;
    const m=node.nodeValue.match(/^\\[([ xX\\-~])\\](\\*?)[ \\t]+/); if(!m) return;
    const task=tasks[k++]; const st=BOX[m[1].toLowerCase()]||BOX[' '];
    const box=document.createElement('span'); box.className='box '+st[0]+(m[2]?' optional':''); box.dataset.line=String(task?task.line:-1); if(m[2]) box.title='optional task'; box.textContent=st[1];
    node.nodeValue=node.nodeValue.slice(m[0].length); node.parentNode.insertBefore(box, node); node.parentNode.insertBefore(document.createTextNode(' '), node);
  });
}
// tasks.md: like Kiro's IDE, every task row that is not done gets its own "Start task"
// (one task, one session); a queued or running row shows its state instead.
function decorateTasks(){
  if(STAGE_FILE!=='tasks.md') return;
  document.querySelectorAll('#doc .box[data-line]').forEach((box)=>{
    if(box.classList.contains('on') || Number(box.dataset.line)<0) return;
    const b=document.createElement('button'); b.type='button'; b.className='start'; b.dataset.line=box.dataset.line;
    if(box.classList.contains('part')){ b.classList.add('state','part'); b.textContent='In progress'; }
    else if(box.classList.contains('queued')){ b.classList.add('state','queued'); b.textContent='Queued'; }
    else { b.textContent='▶ Start task'; b.title='Run this task in its own KiroCrew session'; }
    const li=box.closest('li'); const anchor=Array.from(li.children).find((c)=>c.tagName==='UL'||c.tagName==='OL');
    if(anchor) li.insertBefore(b, anchor); else li.appendChild(b);
  });
}
// mermaid fences, drawn in place when the vendored library is on the page; otherwise they stay code.
let mermaidSeq=0;
async function drawMermaid(){
  const blocks=Array.from(document.querySelectorAll('#doc pre > code')).filter((c)=>/(?:^|\\s)(?:language|lang)-(?:mermaid|mmd)(?:\\s|$)/.test(c.className||''));
  if(!blocks.length) return false;
  if(!window.mermaid){ blocks.forEach((c)=>{ c.className='language-text'; }); dressCode(); return true; }
  const dark=document.body.classList.contains('vscode-dark')||(document.body.classList.contains('vscode-high-contrast')&&!document.body.classList.contains('vscode-high-contrast-light'));
  window.mermaid.initialize({ startOnLoad:false, securityLevel:'strict', theme: dark?'dark':'default', suppressErrorRendering:true });
  for(const code of blocks){
    const pre=code.parentElement; const host=document.createElement('div'); host.className='mermaid'; host.id='mermaid-'+(++mermaidSeq);
    host.dataset.source=code.textContent||''; // the drawn diagram keeps its fence text, so a review comment anchors to it like to any code block
    pre.parentNode.insertBefore(host, pre);
    try{ const out=await window.mermaid.render(host.id+'-svg', code.textContent||''); host.innerHTML=out.svg; if(typeof out.bindFunctions==='function') out.bindFunctions(host); pre.remove(); }
    catch(err){ host.className='mermaid-error'; host.textContent='mermaid: '+String((err&&err.message)||err).split('\\n')[0]; code.className='language-text'; dressCode(); }
  }
  return true; // blocks changed shape: the review ids are assigned again
}
// ---- Find in the document. Matches are text-node local (like most in-page finds: a
// phrase split by inline markup is two nodes and is not matched across them); each becomes
// <mark class="hit">, the current one .cur. Code is searched, labels (code bars, Start
// buttons, box glyphs) and drawn diagrams are not. The host swallows Ctrl+F before the
// browser sees it and forwards the key to the workbench, so the bar opens from this page's
// own keydown and from the extension's 'find' message (its keybinding), idempotently.
const FIND_CAP = 2000;
const find = { bar: document.getElementById('find'), input: document.getElementById('findtext'), count: document.getElementById('findcount'), cs: false, filter: false, hits: [], cur: -1 };
const findBtn = (id)=>document.getElementById(id);
if(STAGE_FILE==='tasks.md') findBtn('findfilter').hidden=false;
function findOpen(){
  const was = !find.bar.hidden;
  find.bar.hidden=false;
  const sel = window.getSelection ? String(window.getSelection()).trim() : '';
  if(sel && sel.length<200 && !sel.includes('\\n') && !find.bar.contains(window.getSelection().anchorNode)) find.input.value=sel;
  find.input.focus(); find.input.select();
  if(!was || sel) findRun(); else findCount();
}
function findClose(){ find.bar.hidden=true; findClear(); findFilter(); find.input.blur(); }
function findClear(){
  document.querySelectorAll('#doc mark.hit').forEach((m)=>{ const p=m.parentNode; if(!p) return; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); });
  find.hits=[]; find.cur=-1;
}
function findEscape(s){ return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }
function findNodes(){
  const out=[]; const root=document.getElementById('doc');
  const w=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(n){ const p=n.parentElement; if(!p || p.closest('svg, script, style, .codebar, button.start, .box, .mermaid-error')) return NodeFilter.FILTER_REJECT; return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } });
  let n; while((n=w.nextNode())) out.push(n);
  return out;
}
function findRun(keep){
  const prev = keep && find.cur>=0 ? find.cur : -1;
  findClear();
  const q=find.input.value;
  if(!q){ find.bar.classList.remove('none'); findCount(); findFilter(); return; }
  const re=new RegExp(findEscape(q), find.cs ? 'g' : 'gi');
  const hits=[];
  outer: for(const node of findNodes()){
    const text=node.nodeValue; let rest=node, off=0;
    for(const m of text.matchAll(re)){
      if(!m[0]) break;
      const hit=rest.splitText(m.index-off); rest=hit.splitText(m[0].length); off=m.index+m[0].length;
      const mark=document.createElement('mark'); mark.className='hit'; hit.parentNode.insertBefore(mark, hit); mark.appendChild(hit); hits.push(mark);
      if(hits.length>=FIND_CAP) break outer;
    }
  }
  find.hits=hits;
  find.bar.classList.toggle('none', !hits.length);
  if(hits.length){
    // Start at the first match on or below the fold (the banner's bottom), as an editor does from its cursor.
    let start = prev>=0 && prev<hits.length ? prev : -1;
    if(start<0){ const fold=document.getElementById('banner').getBoundingClientRect().bottom; start=hits.findIndex((h)=>h.getBoundingClientRect().top>=fold); if(start<0) start=0; }
    findGo(start, true);
  }
  findCount(); findFilter();
}
function findGo(index, absolute){
  const n=find.hits.length; if(!n){ findCount(); return; }
  if(find.cur>=0 && find.hits[find.cur]) find.hits[find.cur].classList.remove('cur');
  find.cur = absolute ? ((index%n)+n)%n : (((find.cur<0?0:find.cur)+index)%n+n)%n;
  const h=find.hits[find.cur]; h.classList.add('cur');
  const row=h.closest('li'); if(row && row.classList.contains('find-hide')) row.classList.remove('find-hide');
  h.scrollIntoView({ block:'center', inline:'nearest' });
  findCount();
}
function findCount(){
  const n=find.hits.length;
  find.count.textContent = !find.input.value ? '' : !n ? 'No results' : (find.cur+1)+' of '+n+(n>=FIND_CAP?'+':'');
  findBtn('findprev').disabled=findBtn('findnext').disabled=!n;
}
// tasks.md: with Filter on, a task row stays when it, a parent task or a sub-task matches.
function findFilter(){
  const rows=document.querySelectorAll('#doc li');
  rows.forEach((li)=>li.classList.remove('find-hide'));
  if(!find.filter || find.bar.hidden || !find.input.value || !find.hits.length) return;
  const own=new Set(); find.hits.forEach((h)=>{ const li=h.closest('li'); if(li) own.add(li); });
  rows.forEach((li)=>{
    if(li.querySelector('mark.hit')) return;
    for(let a=li.parentElement && li.parentElement.closest('li'); a; a=a.parentElement && a.parentElement.closest('li')) if(own.has(a)) return;
    li.classList.add('find-hide');
  });
}
find.input.addEventListener('input', ()=>findRun());
find.input.addEventListener('keydown', (e)=>{
  if(e.key==='Enter'){ e.preventDefault(); findGo(e.shiftKey?-1:1); }
  else if(e.key==='Escape'){ e.preventDefault(); findClose(); }
});
findBtn('findnext').onclick=()=>findGo(1); findBtn('findprev').onclick=()=>findGo(-1);
findBtn('findclose').onclick=findClose;
findBtn('findbtn').onclick=findOpen;
findBtn('findcase').onclick=(e)=>{ find.cs=!find.cs; e.currentTarget.setAttribute('aria-pressed', String(find.cs)); findRun(); find.input.focus(); };
findBtn('findfilter').onclick=(e)=>{ find.filter=!find.filter; e.currentTarget.setAttribute('aria-pressed', String(find.filter)); findFilter(); find.input.focus(); };
document.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && !e.altKey && (e.key==='f'||e.key==='F')){ e.preventDefault(); findOpen(); return; }
  if(e.key==='F3'){ e.preventDefault(); if(find.bar.hidden) findOpen(); else findGo(e.shiftKey?-1:1); return; }
  if(e.key==='Escape' && review.editor){ rvCancel(); return; } // the box's own textarea handles Esc first; this is for focus on its buttons
  if(e.key==='Escape' && !find.bar.hidden){ findClose(); }
});
// ---- Review comments (requirement 7). Every rendered block gets a data-block-id (reviewBlockId:
// a hash of its kind and text plus an occurrence index), so a comment keyed by that id finds its
// block again after a Sync Files re-render when the passage did not change; one whose passage
// changed is listed as unanchored in the banner row. State lives in this page only: closing the
// editor drops it. The extension hears 'review.changed' {count, on} and 'review.send' {comments}
// and can switch the mode with 'review.setMode' {on} (no 'on': toggle) or clear with 'review.clear'.
${reviewBlockId.toString()}
const RV_EXCERPT_MAX = ${REVIEW_EXCERPT_MAX};
const RV_BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote,.codeblock,.mermaid';
const review = { on:false, comments:new Map(), editor:null, draft:null, bar:document.getElementById('review'), btn:document.getElementById('reviewbtn'), badge:document.getElementById('reviewcount'), send:document.getElementById('reviewsend'), status:document.getElementById('reviewstatus'), orphans:document.getElementById('revieworphans') };
function rvKind(el){ const t=el.tagName.toLowerCase(); if(/^h[1-6]$/.test(t)) return 'h'; if(t==='li') return 'li'; if(t==='table') return 'table'; if(t==='blockquote') return 'quote'; if(t==='pre'||el.classList.contains('codeblock')||el.classList.contains('mermaid')) return 'code'; return 'p'; }
// The block an element belongs to: the innermost block element, where a <p> inside a list item or a
// quote stands for its parent and a <pre> for its .codeblock wrapper. Null outside the document or
// inside the review widgets themselves.
function rvBlockOf(el){
  let b = el && el.closest ? el.closest(RV_BLOCKS) : null;
  while(b){
    if(b.closest('.review-card, .review-editor')) return null;
    const p=b.parentElement;
    if(b.tagName==='P' && p && (p.tagName==='LI'||p.tagName==='BLOCKQUOTE')){ b=p; continue; }
    if(b.tagName==='PRE' && p && p.classList.contains('codeblock')){ b=p; continue; }
    break;
  }
  return b && document.getElementById('doc').contains(b) ? b : null;
}
// A block's own text: a list item without its sub-list, a code block without its bar, a task row
// without its state glyph and Start button (so a task keeps its id when it is ticked), a drawn
// diagram by its fence text.
function rvText(el){
  if(el.dataset && el.dataset.source!==undefined) return el.dataset.source;
  const c=el.cloneNode(true);
  c.querySelectorAll('ul, ol, button, .codebar, .review-card, .review-editor, .box, svg').forEach((n)=>n.remove());
  return (c.textContent||'').replace(/\\s+/g,' ').trim();
}
function rvExcerpt(text){ return text.length>RV_EXCERPT_MAX ? text.slice(0, RV_EXCERPT_MAX-1).trimEnd()+'…' : text; }
function rvBlocks(){
  const seen=new Set(); const out=[];
  document.querySelectorAll('#doc '+RV_BLOCKS.split(',').join(',#doc ')).forEach((el)=>{ const b=rvBlockOf(el); if(b && !seen.has(b)){ seen.add(b); out.push(b); } });
  return out;
}
function rvAssignIds(){
  document.querySelectorAll('#doc .rv-block').forEach((el)=>{ el.classList.remove('rv-block','rv-has'); delete el.dataset.blockId; });
  const counts=new Map();
  rvBlocks().forEach((b)=>{ const kind=rvKind(b), text=rvText(b); const base=kind+'\\n'+text; const n=counts.get(base)||0; counts.set(base, n+1); b.dataset.blockId=reviewBlockId(kind, text, n); b.classList.add('rv-block'); });
}
function rvBlockById(id){ return /^[a-z0-9-]+$/.test(String(id)) ? document.querySelector('#doc .rv-block[data-block-id="'+id+'"]') : null; }
function rvCardOf(id){ return /^[a-z0-9-]+$/.test(String(id)) ? document.querySelector('#doc .review-card[data-for="'+id+'"]') : null; }
// A card or the comment box sits right under its block: inside a list item (before its sub-list,
// so it stays with the item's own text), after any other block.
function rvMount(block, node){
  if(block.tagName==='LI'){ const nested=Array.from(block.children).find((c)=>c.tagName==='UL'||c.tagName==='OL'); if(nested) block.insertBefore(node, nested); else block.appendChild(node); }
  else block.insertAdjacentElement('afterend', node);
}
function rvWhen(ts){ try{ return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }catch{ return ''; } }
function rvEl(tag, cls, text){ const e=document.createElement(tag); if(cls) e.className=cls; if(text!==undefined) e.textContent=text; return e; }
function rvButton(cls, label){ const b=rvEl('button', cls, label); b.type='button'; return b; }
function rvCard(c){
  const card=rvEl('div','review-card'); card.dataset.for=c.blockId;
  const q=rvEl('div','excerpt',c.excerpt); q.title=c.excerpt;
  const row=rvEl('div','row');
  const edit=rvButton('edit','Edit'), del=rvButton('delete','Delete');
  edit.onclick=(e)=>{ e.stopPropagation(); const b=rvBlockById(c.blockId); if(!b) return; card.hidden=true; rvOpen(b, c.text, card); };
  del.onclick=(e)=>{ e.stopPropagation(); rvDelete(c.blockId); };
  row.append(edit, del, rvEl('span','when',rvWhen(c.updatedAt||c.createdAt)));
  card.append(q, rvEl('div','text',c.text), row);
  return card;
}
// One comment box at a time, under the block; 'card' is the card it edits (hidden meanwhile), if any.
function rvOpen(block, text, card){
  rvCancel();
  const box=rvEl('div','review-editor'); box.dataset.for=block.dataset.blockId;
  const ta=rvEl('textarea'); ta.placeholder='Comment on this block…'; ta.value=text||''; ta.setAttribute('aria-label','Review comment');
  const row=rvEl('div','row');
  const save=rvButton('save','Save'), cancel=rvButton('cancel','Cancel');
  save.disabled=!ta.value.trim();
  row.append(save, cancel, rvEl('span','hint',(/Mac|iP/.test(navigator.platform||'')?'⌘':'Ctrl')+'+Enter saves · Esc cancels'));
  box.append(ta, row);
  review.editor={ box, block, blockId:block.dataset.blockId, ta, card:card||null };
  review.draft={ blockId:block.dataset.blockId, text:ta.value };
  ta.addEventListener('input', ()=>{ save.disabled=!ta.value.trim(); review.draft={ blockId:block.dataset.blockId, text:ta.value }; });
  ta.addEventListener('keydown', (e)=>{
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); rvCancel(); }
    else if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); rvSave(); }
  });
  save.onclick=(e)=>{ e.stopPropagation(); rvSave(); };
  cancel.onclick=(e)=>{ e.stopPropagation(); rvCancel(); };
  rvMount(block, box);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}
function rvCancel(){ const ed=review.editor; if(!ed) return; ed.box.remove(); if(ed.card) ed.card.hidden=false; review.editor=null; review.draft=null; }
function rvSave(){
  const ed=review.editor; if(!ed) return;
  const text=ed.ta.value.trim(); if(!text) return;
  const prev=review.comments.get(ed.blockId); const now=Date.now();
  const c={ blockId:ed.blockId, excerpt:rvExcerpt(rvText(ed.block)), text, createdAt: prev?prev.createdAt:now, updatedAt: now };
  review.comments.set(ed.blockId, c);
  review.editor=null; review.draft=null; ed.box.remove(); if(ed.card) ed.card.remove();
  ed.block.classList.add('rv-has'); rvMount(ed.block, rvCard(c));
  rvChanged();
}
function rvDelete(id){
  review.comments.delete(id);
  const b=rvBlockById(id); if(b) b.classList.remove('rv-has');
  const card=rvCardOf(id); if(card) card.remove();
  if(review.editor && review.editor.blockId===id) rvCancel();
  rvChanged();
}
function rvOrphanList(){ const list=[]; for(const c of review.comments.values()) if(!rvBlockById(c.blockId)) list.push(c); return list; }
function rvRenderOrphans(){
  const list=rvOrphanList(); review.orphans.textContent=''; review.orphans.classList.toggle('show', list.length>0);
  if(!list.length) return;
  review.orphans.appendChild(rvEl('div','head', list.length+(list.length===1?' comment no longer matches':' comments no longer match')+' a block of this document (the passage changed). Still sent, quoting the original passage:'));
  list.forEach((c)=>{
    const row=rvEl('div','orphan'); const q=rvEl('span','q',c.excerpt); q.title=c.excerpt;
    const del=rvButton('delete','Delete'); del.onclick=()=>rvDelete(c.blockId);
    row.append(q, rvEl('span','t',c.text), del); review.orphans.appendChild(row);
  });
}
// Badge, Send label, status row and the host: after every change to the set.
function rvChanged(){
  const n=review.comments.size;
  review.badge.textContent=String(n); review.badge.classList.toggle('show', n>0);
  review.send.textContent='Send '+n+(n===1?' comment':' comments'); review.send.classList.toggle('show', n>0);
  rvRenderOrphans();
  const o=rvOrphanList().length;
  review.status.textContent = !n ? 'No comments yet.' : n+(n===1?' comment':' comments')+(o?' ('+o+' unanchored)':'');
  vscode.postMessage({ type:'review.changed', count:n, on:review.on });
}
// After the document is (re)rendered: ids again, every comment back under its block, the box
// re-opened with its draft when its block is still there.
function rvRefresh(){
  rvAssignIds();
  document.querySelectorAll('#doc .review-card, #doc .review-editor').forEach((n)=>n.remove());
  review.editor=null;
  for(const c of review.comments.values()){ const b=rvBlockById(c.blockId); if(!b) continue; b.classList.add('rv-has'); rvMount(b, rvCard(c)); }
  const draft=review.draft; review.draft=null;
  if(draft){ const b=rvBlockById(draft.blockId); if(b){ const card=rvCardOf(draft.blockId); if(card) card.hidden=true; rvOpen(b, draft.text, card); } }
  rvChanged();
}
function rvSetMode(on){
  on = typeof on==='boolean' ? on : !review.on;
  review.on=on; document.body.classList.toggle('review', on); review.btn.setAttribute('aria-pressed', String(on)); review.bar.hidden=!on;
  if(!on) rvCancel();
  rvChanged();
}
review.btn.onclick=()=>rvSetMode();
review.send.onclick=()=>{ if(!review.comments.size) return; vscode.postMessage({ type:'review.send', comments:[...review.comments.values()].map((c)=>({ blockId:c.blockId, excerpt:c.excerpt, text:c.text })) }); };
document.getElementById('doc').addEventListener('click', (e)=>{
  if(!review.on) return;
  if(e.target.closest('a, button, textarea, input, .review-card, .review-editor')) return; // links, Start and Copy keep their job
  const sel=window.getSelection ? String(window.getSelection()) : ''; if(sel.trim()) return; // a drag to select text is not a click to comment
  const b=rvBlockOf(e.target); if(!b) return;
  if(review.editor && review.editor.block===b) return;
  e.preventDefault();
  const existing=review.comments.get(b.dataset.blockId);
  if(existing){ const card=rvCardOf(b.dataset.blockId); if(card) card.hidden=true; rvOpen(b, existing.text, card); }
  else rvOpen(b, '');
});
window.addEventListener('message',(e)=>{
  const m=e.data;
  if(m.type==='doc'){ tasks=Array.isArray(m.tasks)?m.tasks:[]; document.getElementById('doc').innerHTML=m.html; dressTasks(); dressCode(); decorateTasks(); rvRefresh(); drawMermaid().then((drew)=>{ if(drew) rvRefresh(); }, ()=>rvRefresh()); if(!find.bar.hidden) findRun(true); if(m.synced){const s=document.getElementById('stale'); s.style.display='block'; setTimeout(()=>{s.style.display='none';},1500);} }
  if(m.type==='continueLabel'){ const b=document.getElementById('continue'); b.textContent='→ '+m.label; b.title=m.title||''; }
  if(m.type==='find'){ findOpen(); }
  if(m.type==='review.setMode'){ rvSetMode(typeof m.on==='boolean' ? m.on : undefined); }
  if(m.type==='review.clear'){ rvCancel(); review.comments.clear(); rvRefresh(); }
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
    // Kiro's `[~]` / `[-]` marks are a run's own trace: the orchestrator writes
    // them as it goes and leaves none when it finishes, so their presence means
    // an interrupted run, resumed in the session that ran it when it still exists.
    if (remaining.some((t) => t.partial || t.queued)) return { label: "Resume run (" + remaining.length + " left)", command: "kirocrew.spec.resume", remaining: remaining.length, interrupted: true };
    const started = leaves.length > remaining.length;
    return { label: (started ? "Resume tasks" : "Run all tasks") + " (" + remaining.length + " left)", command: "kirocrew.spec.runAll", remaining: remaining.length };
  }
  const optional = tasks.filter((t) => t.leaf !== false && t.optional && !t.done).length;
  if (optional) return { label: "Run optional tasks (" + optional + ")", command: "kirocrew.spec.runAllOptional", remaining: optional };
  return { label: "All tasks done", command: null };
}

/**
 * Render a spec document the way the built-in Markdown preview does.
 * `markdown.api.render` is the command the engine's markdown extension exposes
 * (its own markdown-it: GFM, highlight.js colours on fences, the `data-line`
 * attributes); it lives in the engine's extension host, so it is reached as a
 * command, never as a module. When it is missing (extension disabled, an engine
 * without it) `mdToHtml` renders instead. `{html, engine: "builtin" | "own"}`.
 */
let _builtinRender; // undefined: not probed; false: absent; true: available
async function renderMarkdown(text) {
  if (_builtinRender === undefined) {
    try { _builtinRender = (await vscode.commands.getCommands(true)).includes("markdown.api.render"); } catch { _builtinRender = false; }
  }
  if (_builtinRender) {
    try {
      const html = await vscode.commands.executeCommand("markdown.api.render", String(text || ""));
      if (typeof html === "string") return { html, engine: "builtin" };
    } catch (error) {
      console.warn("[kirocrew] markdown.api.render failed, using the built-in-free renderer", error);
    }
  }
  return { html: mdToHtml(text), engine: "own" };
}

/** Relative `<img src>` in a spec document points at the spec's own directory; the webview needs the resource URI. */
function localizeImages(html, dir, webview) {
  // The own renderer leaves a local image as `<img data-path>` for the chat page to fetch; the
  // spec editor has resource roots instead, so the path becomes an ordinary src here.
  html = String(html).replace(/<img\b([^>]*)\sdata-path="([^"]+)"([^>]*)>/gi, (all, before, path, after) => "<img" + before + ' src="' + path + '"' + after + ">");
  return String(html).replace(/(<img\b[^>]*\ssrc=")([^"]+)(")/gi, (all, before, src, after) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#|data:)/i.test(src)) return all;
    try { return before + webview.asWebviewUri(vscode.Uri.joinPath(dir, decodeURIComponent(src))).toString() + after; } catch { return all; }
  });
}

/** Context keys mirroring the ACTIVE spec editor's review state (requirement 7): the comment count and whether review mode is on. */
const SPEC_REVIEW_CONTEXT_KEYS = { count: "kirocrew.spec.reviewCount", on: "kirocrew.spec.reviewMode" };

class SpecEditorProvider {
  /** `chat` is the ChatView whose `sendSpecTurn` carries the review turn (requirement 7.2); without it the Send button reports that nothing can be sent. */
  constructor(context, chat) {
    this.context = context; this.chat = chat || null; this.panels = new Set(); this.documents = new Map();
    // Review state per panel as the page reports it (`review.changed`), and review-mode requests
    // for documents whose editor has not said `ready` yet (the Specs view's Review action opens
    // the editor and asks for review mode in one go; a message posted before the page listens
    // would be lost, so it waits for `ready`).
    this.review = new Map(); this.pendingReviewMode = new Map();
    // Panels whose page has said `ready` (listens for messages); a mode request for a panel
    // still loading is parked in `pendingReviewMode` instead of being posted into the void.
    this.ready = new Set();
  }
  /** The spec editor the user is in (the active panel), or null. */
  activePanel() { return [...this.panels].find((p) => p.active) || null; }
  /** The spec editors showing `uri` (none, one, or one per editor group). */
  panelsShowing(uri) {
    const key = uri && uri.toString();
    if (!key) return [];
    return [...this.panels].filter((panel) => { const shown = this.documents.get(panel); return shown && shown.toString() === key; });
  }
  /** `{count, on}` of a panel's review state; zeros for a panel that reported nothing. */
  reviewStateOf(panel) { return (panel && this.review.get(panel)) || { count: 0, on: false }; }
  /** The active editor's review state onto the context keys (a title badge or `when` clause reads them). */
  updateReviewContext() {
    const state = this.reviewStateOf(this.activePanel());
    if (this._reviewApplied && this._reviewApplied.count === state.count && this._reviewApplied.on === state.on) return;
    this._reviewApplied = { count: state.count, on: state.on };
    void vscode.commands.executeCommand("setContext", SPEC_REVIEW_CONTEXT_KEYS.count, state.count);
    void vscode.commands.executeCommand("setContext", SPEC_REVIEW_CONTEXT_KEYS.on, state.on);
  }
  /**
   * Switch review mode on (`on` true), off (false) or toggle it (undefined) in
   * every spec editor showing `uri`; an editor still loading (or not opened
   * yet) gets the request when it says `ready`. Returns the number of editors
   * told right away.
   */
  setReviewMode(uri, on) {
    const key = uri && uri.toString();
    if (!key) return 0;
    let told = 0;
    for (const panel of this.panelsShowing(uri)) {
      if (!this.ready.has(panel)) continue;
      panel.webview.postMessage({ type: "review.setMode", on });
      told += 1;
    }
    if (!told) this.pendingReviewMode.set(key, on);
    return told;
  }
  /** Toggle review mode in the active spec editor; false when none is active. */
  toggleReviewInActive() {
    const panel = this.activePanel();
    if (!panel) return false;
    panel.webview.postMessage({ type: "review.setMode" });
    return true;
  }
  /**
   * "Send N comments" (requirements 7.2, 7.3): build the review turn from the
   * page's comments on the document `uri` shows and send it through
   * `chat.sendSpecTurn(feature, "review", file, { dir, body, displayText })` —
   * the Spec_Agent, the spec's idle session when it has one, the siblings as
   * context, "Review: N comments on <file>" as the transcript's bubble. Only a
   * turn that was sent clears the comments (`review.clear`) and resets the
   * count; a failure shows an error and leaves them in the page. An empty list
   * is ignored. Returns sendSpecTurn's `{ key, reused }`, or null when nothing
   * was sent.
   */
  async sendReview(panel, uri, comments) {
    if (!Array.isArray(comments) || !comments.length) return null;
    const feature = specNameOf(uri.path);
    const file = specFileOf(uri.path) || specDocumentName(uri.path);
    const turn = buildReviewTurn({ feature, file, comments });
    if (!turn.text) return null;
    if (!this.chat || typeof this.chat.sendSpecTurn !== "function") {
      void vscode.window.showErrorMessage("KiroCrew: the chat view is not available; the review comments were not sent.");
      return null;
    }
    const dir = uri.with({ path: specDirOf(uri.path) || uri.path.replace(/\/[^/]+$/, "") });
    let result;
    try {
      const send = () => this.chat.sendSpecTurn(feature, "review", file, { dir, body: turn.text, displayText: turn.displayText });
      // One start per click (SpecStartGuard, when the chat carries one): a second Send
      // while the first is still opening its chat adds nothing.
      result = this.chat.specStarts ? await this.chat.specStarts.run(dir.path, "Send review comments", send) : await send();
    } catch (error) {
      void vscode.window.showErrorMessage("KiroCrew: send review comments on " + file + ": " + (error && error.message ? error.message : String(error)));
      return null;
    }
    panel.webview.postMessage({ type: "review.clear" });
    const state = this.reviewStateOf(panel);
    this.review.set(panel, { count: 0, on: state.on });
    this.updateReviewContext();
    return result;
  }
  /** The Uri of the document shown in the active spec editor, or null (the palette's previous/next document start here when no text editor is active). */
  activeDocumentUri() { const panel = this.activePanel(); return (panel && this.documents.get(panel)) || null; }
  /**
   * Ctrl/Cmd+F: open the active spec editor's find bar. The webview host swallows
   * the key before the page sees it only to forward it to the workbench, where
   * this command's keybinding runs while a spec editor is active; the page's
   * own keydown opens the bar too, and opening twice is harmless.
   */
  findInActive() {
    const panel = this.activePanel();
    if (!panel) return false;
    panel.webview.postMessage({ type: "find" });
    return true;
  }
  async resolveCustomTextEditor(document, panel) {
    this.panels.add(panel);
    this.documents.set(panel, document.uri);
    // Closing the editor drops its review comments with the page (requirement 7.4): nothing is persisted here.
    panel.onDidDispose(() => { this.panels.delete(panel); this.documents.delete(panel); this.review.delete(panel); this.ready.delete(panel); this.updateReviewContext(); });
    if (typeof panel.onDidChangeViewState === "function") panel.onDidChangeViewState(() => this.updateReviewContext());
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
    // The spec dir is a resource root so relative images in design.md load.
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri, dir] };
    const mermaidUri = vscode.Uri.joinPath(this.context.extensionUri, "media", "mermaid.min.js");
    let mermaid = null;
    try { await vscode.workspace.fs.stat(mermaidUri); mermaid = panel.webview.asWebviewUri(mermaidUri).toString(); } catch { mermaid = null; }
    panel.webview.html = specEditorHtml(specName, stage, present, { mermaid });
    const specObj = async () => {
      const specs = await listSpecs();
      return specs.find((x) => x.name === specName && sameDir(x.dir.path, dir.path)) || { name: specName, dir, present, tasks: [], workspace: (vscode.workspace.workspaceFolders || [])[0] };
    };
    const push = async (synced) => {
      const text = document.getText();
      const rendered = await renderMarkdown(text);
      const html = localizeImages(rendered.html, dir, panel.webview);
      const tasks = stage.file === "tasks.md" ? flattenTasks(parseTaskTree(text)).map((t) => ({ line: t.line, status: t.status, optional: t.optional })) : [];
      panel.webview.postMessage({ type: "doc", html, engine: rendered.engine, tasks, synced: Boolean(synced) });
      const action = continueAction(stage, await specObj());
      panel.webview.postMessage({ type: "continueLabel", label: action.label, title: "Continue the spec workflow from " + stage.label });
    };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === document.uri.toString()) push(true); });
    panel.onDidDispose(() => sub.dispose());
    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          this.ready.add(panel);
          await push(false);
          const key = document.uri.toString();
          if (this.pendingReviewMode.has(key)) { const on = this.pendingReviewMode.get(key); this.pendingReviewMode.delete(key); panel.webview.postMessage({ type: "review.setMode", on }); }
        }
        else if (msg.type === "review.changed") { this.review.set(panel, { count: Number(msg.count) || 0, on: Boolean(msg.on) }); this.updateReviewContext(); }
        else if (msg.type === "review.send") await this.sendReview(panel, document.uri, msg.comments);
        else if (msg.type === "link" && msg.url) await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
        else if (msg.type === "copy") await vscode.env.clipboard.writeText(String(msg.text || ""));
        else if (msg.type === "open") {
          // A link the renderer left relative is relative to the spec's own directory.
          const raw = String(msg.path || "");
          if (msg.relative && raw && !raw.startsWith("/")) await openPathLink(vscode.Uri.joinPath(dir, raw).path, msg.line, msg.column);
          else await openPathLink(raw, msg.line, msg.column);
        }
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
 *
 * Only a change seen WHILE the window is open moves the theme. The first poll
 * learns the scheme and writes nothing: until 0.30.11 it counted as a change
 * (`lastScheme` starts empty), so every window load applied the dashboard's
 * polarity to a stock theme or an unset one — a user on Dark Modern under a
 * light dashboard was flipped to Light Modern on each new window, and a fresh
 * engine start that opens every workspace at once flipped them all
 * (2026-11-07, "the theme just changed to default"). A window that opens with
 * no theme set already shows the dashboard's polarity through the served
 * document's configuration defaults (the hook's `_inject_settings`), so nothing
 * is lost by not writing it.
 */
function syncTheme(context) {
  let lastScheme = null;
  const tick = async () => {
    if (!cfg("syncTheme", true)) return;
    let doc;
    try { doc = await api("/apps/floofycrew/mods/" + IDE_TAG + "/api/theme"); } catch { return; }
    const scheme = doc && doc.scheme;
    if (!scheme || scheme === lastScheme) return;
    const first = lastScheme === null;
    lastScheme = scheme;
    if (first) return;
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

// ---------------------------------------------------------------- native highlighting

/**
 * The chat's command tip asks for a shell command coloured the way the editor would
 * colour it. This host (a browser worker) has no tokenizer and a webview gets no token
 * colours, so the request goes to the mod's engine-host extension (preview/highlight.js:
 * the engine's own vscode-textmate, the shellscript grammar, the active theme's rules)
 * through its command. `{lines: null}` — the engine's modules missing, the preview
 * extension not provisioned — leaves the tip on its own fallback colouring; the reason
 * is logged once per theme, and a theme change gives it another try.
 */
const HIGHLIGHT_COMMAND = "kirocrew.preview.highlight";
let nativeHighlightFailure = "";
async function nativeHighlight(text) {
  if (nativeHighlightFailure) return { lines: null };
  try {
    const r = await vscode.commands.executeCommand(HIGHLIGHT_COMMAND, { text: String(text || "") });
    if (!r || !Array.isArray(r.lines)) throw new Error((r && r.error) || "the engine's highlighter returned nothing");
    if (!nativeHighlightLogged) { nativeHighlightLogged = true; log("command tip: native highlighting through " + HIGHLIGHT_COMMAND + " (theme " + (r.theme || "?") + ", vscode-textmate under " + (r.root || "?") + ")"); }
    return { lines: r.lines, theme: r.theme || "" };
  } catch (error) {
    nativeHighlightFailure = String((error && error.message) || error);
    log("command tip: native highlighting unavailable, using the fallback colours — " + nativeHighlightFailure);
    return { lines: null };
  }
}
let nativeHighlightLogged = false;

// ---------------------------------------------------------------- activate

function activate(context) {
  const feed = new Feed();
  const sessions = new Sessions(feed);
  const chat = new ChatView(context, sessions, feed);
  // The terminal context provider's "last N lines" source: shell-integration output per terminal.
  if (!trackTerminalOutput(context)) log("terminal provider: no shell-integration API in this engine; only the selection path is available");
  // The cached per-spec model (config, tasks, requirements, properties) the spec
  // providers read; its watcher on .kiro/specs/** invalidates it and fires onDidChange —
  // the one change source the Specs view refreshes from too.
  specModels = new SpecModelStore(context);
  // One spec chat per click: a start (Run all tasks, a phase, a review, a resume…) holds
  // its spec until its chat is away; the Specs view spins the row, the host's progress
  // toast shows the title, and a click during the hold is told so and adds nothing.
  let specsTree = null;
  const specStarts = new SpecStartGuard({
    onChange: () => { if (specsTree) specsTree.refresh(); },
    onDuplicate: (held) => vscode.window.setStatusBarMessage("KiroCrew: " + held + " is still starting — its chat opens in a moment; the second click was ignored", 6000),
    progress: (title, work) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "KiroCrew: starting " + title + "…", cancellable: false }, () => work()),
  });
  /** Run `work` as the start `title` of whatever `arg` names (a Specs node, a document Uri, nothing). */
  const startSpec = (arg, title, work) => specStarts.run(specStartKey(arg), title, work);
  specsTree = new SpecsTree(context, specModels, specStarts);
  chat.specStarts = specStarts; // the spec editor's Send goes through the same guard
  // Which session ran which task (kirocrew.taskSessionLinks): written by runTasks and the
  // chat's turn ends, read by "View session" and the task states.
  taskLinks = new TaskSessionLinks(context);
  // The active spec's workflow/spec type as context keys, and the warning on a broken .config.kiro.
  new SpecContextKeys(context, specModels);
  new SpecContentKey(context);
  new SpecConfigDiagnostics(context, specModels);
  // Task format warnings on every open tasks.md (requirement 5.1); the constructor registers
  // the open / change / close listeners and checks the documents already open.
  new SpecTaskDiagnostics(context);
  const specEditors = new SpecEditorProvider(context, chat); // chat carries the review turn (requirement 7.2)
  // The lens row above each task line of a tasks.md.
  const taskLenses = new SpecTaskCodeLensProvider({ links: () => taskLinks, isRunning: (key) => { const slot = sessions.slot(key); return Boolean(slot && slot.running); } });
  // The per-state left border over each task block (requirement 4.5).
  const taskDecorations = new SpecTaskDecorations(taskLenses);
  // Lenses and borders follow both state sources (requirement 4.6): a tasks.md changing on
  // disk — the orchestrator's `[~]` / `[-]` / `[x]` writes included, which reach us through
  // the SpecModel watcher like any other file change — and a run record being added or
  // getting its session / outcome. The two often land together (runTasks records the link
  // as Kiro starts marking the task), so a short trailing debounce collapses them into one
  // refresh; the watcher's 250 ms plus these 100 ms keep the update well under a second.
  let taskUiRefreshTimer = null;
  function scheduleTaskUiRefresh() {
    if (taskUiRefreshTimer) clearTimeout(taskUiRefreshTimer);
    taskUiRefreshTimer = setTimeout(() => {
      taskUiRefreshTimer = null;
      taskLenses.refresh();
      taskDecorations.applyAll();
    }, TASK_UI_REFRESH_DEBOUNCE_MS);
  }
  // Task state from Kiro's engine (requirement 5.4): the store takes the Kas_Link's specEvents and
  // polls kas/tasks while a Kiro-mode spec run is live; the lenses, borders and Specs view follow.
  kasTaskStore = new KasTaskStore(sessions.projectPath());
  chat.kasSpecListeners.add((frame) => {
    if (!kasTaskStore.applyEvent(frame)) return;
    const feature = kasFeatureOfPath((frame.params || {}).tasksFilePath);
    if (feature) kasTaskStore.track(feature, () => chat.kasTabs().some((t) => t.kas.running && t.spec && t.spec.name === feature));
  });
  context.subscriptions.push(
    kasTaskStore,
    kasTaskStore.onDidChange(() => { scheduleTaskUiRefresh(); specsTree.refresh(); }),
    specModels.onDidChange(() => scheduleTaskUiRefresh()),
    taskLinks.onDidChange(() => scheduleTaskUiRefresh()),
    { dispose: () => { if (taskUiRefreshTimer) clearTimeout(taskUiRefreshTimer); taskUiRefreshTimer = null; } },
  );
  const trees = { steering: new AssetTree(context, "steering"), skills: new AssetTree(context, "skills"), hooks: new HooksTree(context), mcp: new McpServersTree(context) };
  const skillsView = vscode.window.createTreeView("kirocrew.skills", { treeDataProvider: trees.skills });
  // A TreeView for Hooks too: the ＋ wizard reveals the new row (requirement 12.4) and the
  // view carries the standing note that kiro-cli, not this extension, runs hooks (12.5).
  const hooksView = vscode.window.createTreeView("kirocrew.hooks", { treeDataProvider: trees.hooks });
  setHookViewMessage(hooksView);
  // A steering file written or renamed re-reads the composer's steering indicator.
  context.subscriptions.push(trees.steering.onDidChangeTreeData(() => chat.pushSteering().catch(() => undefined)));
  context.subscriptions.push(
    feed,
    vscode.window.registerWebviewViewProvider("kirocrew.chat", chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider("kirocrew.specs", specsTree),
    vscode.window.registerTreeDataProvider("kirocrew.steering", trees.steering),
    // A TreeView (not a bare provider) for Skills: "Import skill" reveals the new row (requirement 11.5).
    skillsView,
    hooksView,
    // The read-only MCP Servers view (spec task 16.1): a bare provider, nothing to reveal.
    vscode.window.registerTreeDataProvider("kirocrew.mcp", trees.mcp),
    vscode.window.registerCustomEditorProvider("kirocrew.spec", specEditors, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("kirocrew.spec.find", () => specEditors.findInActive()),
    // Review mode in the active spec editor (requirement 7.5); the Specs view's Review row
    // action (requirement 2.6) opens the document in the spec editor with review mode on.
    vscode.commands.registerCommand("kirocrew.spec.toggleReview", () => specEditors.toggleReviewInActive()),
    vscode.commands.registerCommand("kirocrew.spec.review", (arg) => reviewSpecDocument(arg, specEditors)),
    vscode.commands.registerCommand("kirocrew.spec.editSource", (uri) => vscode.commands.executeCommand("vscode.openWith", uri, "default")),
    // "Open Preview" on a spec file (Shift+Cmd+V, Ctrl+K V, the title-bar button) means the
    // Kiro spec editor, not the built-in markdown preview; any other file keeps the built-in one.
    vscode.commands.registerCommand("kirocrew.spec.preview", (uri, beside) => openSpecPreview(uri, Boolean(beside))),
    vscode.commands.registerCommand("kirocrew.spec.previewToSide", (uri) => openSpecPreview(uri, true)),
    vscode.window.onDidChangeActiveTextEditor((editor) => markSpecEditor(editor)),
    // Title-bar navigation between a spec's documents (the entries are ordered per workflow
    // type in package.json; see `specGotoMenuEntries`), and the palette's previous/next.
    ...SPEC_NAV_DOCUMENTS.map((doc) => vscode.commands.registerCommand(specGotoCommand(doc), (uri) => gotoSpecDocument(uri, doc + ".md", specEditors))),
    vscode.commands.registerCommand("kirocrew.spec.previousDocument", (uri) => stepSpecDocument(uri, -1, specEditors)),
    // "Next document" opens the next document when it has content and has the Spec_Agent
    // generate it otherwise; "Sync with project files" sends the update turn for this one.
    vscode.commands.registerCommand("kirocrew.spec.nextDocument", (uri) => startSpec(uri, "Next document", () => nextSpecDocument(uri, specEditors, chat))),
    vscode.commands.registerCommand("kirocrew.spec.syncDocument", (uri) => startSpec(uri, "Sync with project files", () => syncSpecDocument(uri, specEditors, chat))),
  );
  markSpecEditor(vscode.window.activeTextEditor);
  log(`bridge ${context.extension && context.extension.packageJSON ? context.extension.packageJSON.version : "?"} activated`);
  // The other way a chat pane stays blank: the workbench never asked for the view at all. Leave a trace either way.
  const resolvedCheck = setTimeout(() => log(chat.view ? "chat view resolved by the workbench" : "chat view NOT resolved 10s after activation (KiroCrew Chat container hidden, or the workbench never asked for it)"), 10000);
  context.subscriptions.push({ dispose: () => clearTimeout(resolvedCheck) });
  feed.start();
  sessions.refresh().catch((error) => console.warn("[kirocrew] initial refresh failed", error));
  watchApprovals(feed, sessions, context);
  syncTheme(context);
  // The command tip's colours follow the theme: a change drops the webview's cache (and
  // forgets a failure, so a theme that arrives with a working engine gets the real colours).
  const highlightReset = () => { nativeHighlightFailure = ""; nativeHighlightLogged = false; chat.post({ type: "highlightReset" }); };
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(highlightReset));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("kirocrew.chatFontSize")) chat.post({ type: "fontSize", px: Number(cfg("chatFontSize", 0)) || 0 });
    if (e.affectsConfiguration("kirocrew.chatWidth")) chat.post({ type: "width", preset: String(cfg("chatWidth", "compact") || "compact") });
    if (e.affectsConfiguration("kirocrew.toolCardDisplayMode")) chat.post({ type: "toolCardDisplayMode", mode: String(cfg("toolCardDisplayMode", "collapseOnComplete") || "collapseOnComplete") });
    if (e.affectsConfiguration("workbench.colorTheme") || e.affectsConfiguration("editor.tokenColorCustomizations")) highlightReset();
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
    const key = await chat.dispatch(prompt, { mode: "spec", agent: cfg("specAgent", "") || undefined, title, kind, spec: { name: spec.name, dir: spec.dir } });
    vscode.window.setStatusBarMessage("KiroCrew: " + title + " running in session " + key, 5000);
    return key;
  };

  const specOf = async (node) => {
    const spec = await pickSpec(node);
    // A palette click held the unkeyed start; now that the spec is known, the hold is its row's.
    if (spec && spec.dir && spec.dir.path !== undefined) specStarts.rekey(SPEC_START_ANY, spec.dir.path);
    return spec;
  };
  const pickSpec = async (node) => {
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
    // Kiro's tab shortcuts while the chat view has focus (package.json binds them with
    // `focusedView == kirocrew.chat`); Rename also sits in the view's title menu.
    vscode.commands.registerCommand("kirocrew.chat.nextTab", () => chat.stepTab(1)),
    vscode.commands.registerCommand("kirocrew.chat.prevTab", () => chat.stepTab(-1)),
    vscode.commands.registerCommand("kirocrew.chat.closeTab", () => chat.requestCloseTab()),
    vscode.commands.registerCommand("kirocrew.chat.newTab", () => chat.requestNewTab()),
    vscode.commands.registerCommand("kirocrew.chat.find", () => chat.openFind()),
    vscode.commands.registerCommand("kirocrew.chat.approveAll", () => chat.approveAll()),
    vscode.commands.registerCommand("kirocrew.chat.rejectAll", () => chat.rejectAll()),
    vscode.commands.registerCommand("kirocrew.chat.renameTab", (id) => chat.renameTab(typeof id === "number" ? id : undefined)),
    vscode.commands.registerCommand("kirocrew.extensions.installFromMarketplace", installFromMarketplace),
    vscode.commands.registerCommand("kirocrew.openSession", async (key) => { await vscode.commands.executeCommand("kirocrew.chat.focus"); await chat.open(key); }),
    vscode.commands.registerCommand("kirocrew.openInDashboard", (key) => vscode.env.openExternal(vscode.Uri.parse(ORIGIN + "/chat/" + encodeURIComponent(typeof key === "string" ? key : chat.key || "")))),
    vscode.commands.registerCommand("kirocrew.stopSession", (key) => sessions.stop(typeof key === "string" ? key : chat.key).catch((e) => vscode.window.showErrorMessage(e.message))),
    vscode.commands.registerCommand("kirocrew.checkpoints.revert", async () => {
      // The palette's way to the same restore: every checkpoint of this folder's repository, newest first.
      const folder = chat.sessions.projectPath();
      if (!folder) { vscode.window.showErrorMessage("KiroCrew: open a folder first."); return; }
      let listed;
      try { listed = await modApi("checkpoints?folder=" + encodeURIComponent(folder)); } catch (error) {
        vscode.window.showErrorMessage("KiroCrew: " + (error && error.unsupported ? "this folder is not a git repository, so it has no checkpoints." : (error && error.message) || String(error)));
        return;
      }
      const rows = ((listed && listed.checkpoints) || []).slice().reverse();
      if (!rows.length) { vscode.window.showInformationMessage("KiroCrew: no checkpoints yet. One is taken before every chat turn."); return; }
      const pick = await vscode.window.showQuickPick(rows.map((r) => ({
        label: (r.kind === "before-revert" ? "$(discard) " : "$(comment) ") + (r.label || (r.kind === "before-revert" ? "before a revert" : "turn " + (r.turn || "?"))),
        description: ageLabel(Number(r.time) * 1000) + (r.session ? " · " + String(r.session).replace(/^dashboard_/, "") : ""),
        detail: r.id, id: r.id,
      })), { placeHolder: "Restore the workspace to how it was at…", matchOnDescription: true, matchOnDetail: true });
      if (!pick) return;
      const t = chat.tab(chat.active) || chat.newTab(true);
      await chat.revertTo(t, pick.id);
    }),
    vscode.commands.registerCommand("kirocrew.history", async () => {
      const [, kasDoc] = await Promise.all([sessions.refresh().catch(() => undefined), api(KAS_SESSIONS_ROUTE).catch(() => null)]);
      const rows = sessions.history();
      const project = sessions.projectPath();
      const kasRows = kasHistoryItems(kasDoc && kasDoc.sessions, project, (sid) => Boolean(chat.tabForKey("kas:" + sid)));
      if (!rows.length && !kasRows.length) return vscode.window.showInformationMessage("No KiroCrew sessions for " + (project || "this workspace") + " yet — send a message to start one.");
      const items = rows.map((s) => {
        const busy = s.running ? "$(sync~spin) running" : (s.pending_approval || s.needs_input || s.waiting_for_input) ? "$(bell) waiting" : "";
        const when = ageLabel(slotActivity(s));
        return { label: (chat.tabForKey(s.key) ? "$(check) " : "") + (s.title || s.label || s.key), description: [s.effective_agent || s.agent, busy, when].filter(Boolean).join("  ·  "), detail: (s.last_message || s.prompt_preview || "").toString().slice(0, 120), key: s.key };
      });
      // The Kiro-mode sessions of this workspace (requirement 6.3), from the hook's index and
      // kiro-cli's own store, as a second group; a row opens the session as a Kiro-mode tab.
      const separator = typeof vscode.QuickPickItemKind === "object" ? vscode.QuickPickItemKind.Separator : undefined;
      const all = [];
      if (items.length && kasRows.length && separator !== undefined) all.push({ label: "KiroCrew sessions", kind: separator });
      all.push(...items);
      if (kasRows.length && separator !== undefined) all.push({ label: KAS_SECTION, kind: separator });
      all.push(...kasRows);
      const picked = await vscode.window.showQuickPick(all, { placeHolder: "Sessions of " + (project || "this workspace") + " — newest first, created here or in the dashboard" + (kasRows.length ? ", Kiro-mode sessions below" : ""), matchOnDescription: true, matchOnDetail: true });
      if (!picked) return;
      await vscode.commands.executeCommand("kirocrew.chat.focus");
      if (picked.kas) await chat.openKas(picked.kas, { mode: picked.mode || "", title: picked.title || "" });
      else await chat.open(picked.key);
    }),
    vscode.commands.registerCommand("kirocrew.openFile", async (uri) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand("kirocrew.steering.new", () => newAsset("steering", vscode.workspace.workspaceFolders || [])),
    // The Steering view's welcome content and title-bar sparkle (requirement 11.1).
    vscode.commands.registerCommand(STEERING_GENERATE_COMMAND, () => generateSteeringDocs(chat)),
    // The title-bar sparkle on a steering document and the Steering view's row action (requirement 11.2).
    vscode.commands.registerCommand(STEERING_REFINE_COMMAND, (uri) => refineSteeringDoc(chat, uri)),
    // The Steering view's "Import from other assistants" title-bar action and welcome link (requirement 11.3).
    vscode.commands.registerCommand(STEERING_IMPORT_COMMAND, () => importSteeringFromAssistants(trees.steering)),
    vscode.commands.registerCommand("kirocrew.skills.new", () => newAsset("skills", vscode.workspace.workspaceFolders || [])),
    // The Skills view's "Import skill" title-bar action (requirements 11.4, 11.5).
    vscode.commands.registerCommand(SKILL_IMPORT_COMMAND, () => importSkill(trees.skills, skillsView)),
    vscode.commands.registerCommand("kirocrew.hooks.new", () => createHookWizard(trees.hooks, hooksView)),
    vscode.commands.registerCommand(HOOK_DOCS_COMMAND, () => vscode.env.openExternal(vscode.Uri.parse(HOOK_DOCS_URL))),
    // The Agent Hooks view's row actions (requirement 12.2): the inline Disable on an enabled
    // hook and Enable on a disabled one (two commands so each state gets its own icon), the
    // context-menu Toggle on either; and the view's title-bar Refresh.
    vscode.commands.registerCommand("kirocrew.hooks.toggle", (item) => toggleHook(trees.hooks, item)),
    vscode.commands.registerCommand("kirocrew.hooks.enable", (item) => toggleHook(trees.hooks, item, true)),
    vscode.commands.registerCommand("kirocrew.hooks.disable", (item) => toggleHook(trees.hooks, item, false)),
    vscode.commands.registerCommand("kirocrew.hooks.refresh", () => trees.hooks.refresh()),
    // The Run row action on a `userTriggered` hook (requirement 12.3).
    vscode.commands.registerCommand(HOOK_RUN_COMMAND, (item) => runHook(chat, item)),
    // The MCP Servers view's title-bar Refresh and "Open config file" (also every row's click, with the file and line).
    vscode.commands.registerCommand("kirocrew.mcp.refresh", () => trees.mcp.refresh()),
    vscode.commands.registerCommand(MCP_OPEN_CONFIG_COMMAND, (uri, line) => openMcpConfig(uri, line)),
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
    // ＋ in the Specs view: idea → workflow type → spec type → directory + .config.kiro →
    // create turn on the Spec_Agent with the idea as the tab title (createSpecFromIdea).
    vscode.commands.registerCommand("kirocrew.spec.new", () => startSpec({ dir: SPEC_START_NEW }, "New spec", () => createSpecFromIdea(chat, specsTree))),
    // Spec row actions: Rename (validated input box, directory moved) and Delete (modal
    // confirmation naming the directory, recursive). Both refresh the tree themselves.
    vscode.commands.registerCommand("kirocrew.spec.rename", async (node) => renameSpec(await specOf(node), specsTree)),
    vscode.commands.registerCommand("kirocrew.spec.delete", async (node) => deleteSpec(await specOf(node), specsTree)),
    vscode.commands.registerCommand("kirocrew.spec.requirements", (node) => startSpec(node, "Write requirements", async () => {
      const spec = await specOf(node);
      const idea = spec.present["requirements.md"] ? "" : await vscode.window.showInputBox({ prompt: "What should this feature do?" });
      if (idea === undefined) return;
      await dispatch(spec, phasePrompt("requirements", spec, idea), "spec", "spec " + spec.name + ": requirements");
    })),
    // The bugfix spec's first document (its "requirements"); the view's missing bugfix row runs this.
    vscode.commands.registerCommand("kirocrew.spec.bugfix", (node) => startSpec(node, "Write bugfix", async () => {
      const spec = await specOf(node);
      const idea = spec.present["bugfix.md"] ? "" : await vscode.window.showInputBox({ prompt: "What is the bug? (what happens, what should happen)" });
      if (idea === undefined) return;
      await dispatch(spec, phasePrompt("bugfix", spec, idea), "spec", "spec " + spec.name + ": bugfix");
    })),
    vscode.commands.registerCommand("kirocrew.spec.design", (node) => startSpec(node, "Write design", async () => {
      const spec = await specOf(node);
      const req = requirementsFileOf(spec.config);
      if (!spec.present[req]) return vscode.window.showWarningMessage("Write " + req.replace(/\.md$/, "") + " first — the design is derived from it.");
      await dispatch(spec, phasePrompt("design", spec), "spec", "spec " + spec.name + ": design");
    })),
    vscode.commands.registerCommand("kirocrew.spec.tasks", (node) => startSpec(node, "Write tasks", async () => {
      const spec = await specOf(node);
      if (!spec.present["design.md"]) return vscode.window.showWarningMessage("Write the design first — tasks are derived from it.");
      await dispatch(spec, phasePrompt("tasks", spec), "spec", "spec " + spec.name + ": tasks");
    })),
    // Analyze requirements (requirement 5.1): Kiro's own `analyzeRequirements` on its engine; on the
    // gateway, the mod's read-only review of the requirements document.
    vscode.commands.registerCommand("kirocrew.spec.analyze", (node) => startSpec(node, "Analyze requirements", async () => {
      const spec = await specOf(node);
      const reqFile = requirementsFileOf(spec.config);
      if (!spec.present[reqFile]) return vscode.window.showWarningMessage("Write the requirements first — there is nothing to analyze.");
      const title = "spec " + spec.name + ": analyze requirements";
      const docs = ChatView.kasSpecDocuments(spec);
      await chat.specAction(
        () => chat.runKasSpec("analyzeRequirements", { featureName: spec.name, specDocuments: docs.specDocuments }, { feature: spec.name, dir: spec.dir, title: "Analyze requirements: " + spec.name }),
        () => dispatch(spec, "Analyze the requirements of the spec `" + spec.name + "` (" + spec.dir.path + "/" + reqFile + "). For each acceptance criterion check: EARS form (WHEN/IF … THEN the system SHALL …), testability, ambiguity, overlap with other criteria, and gaps against the introduction and user stories. Report the findings as a numbered list with the criterion quoted and a suggested rewording where one is needed. Do not edit any file.", "spec", title));
    })),
    vscode.commands.registerCommand("kirocrew.spec.runTask", (node) => startSpec(node, "Start task", async () => {
      if (!node || !node.task) return vscode.window.showWarningMessage("Pick a task in the Specs view.");
      let spec = node.spec;
      if (!spec.taskTree) spec = (await listSpecs()).find((s) => s.name === spec.name && sameDir(s.dir.path, spec.dir.path)) || spec;
      const task = (spec.taskTree && findTask(spec.taskTree, node.task.id || node.task.line)) || null;
      const text = task ? task.text : (node.task.number ? node.task.number + " " : "") + node.task.title;
      const taskId = task ? task.id : (typeof node.task.id === "string" && node.task.id) || text;
      await runTasks(spec, (kiro) => (kiro && task ? kiroTaskRequest(spec, task) : taskPrompt(spec, node.task)), "Execute Task: " + text, "task", task ? { spec: spec.name, dir: spec.dir.path, task: task.id, optional: false, display: "Execute Task: " + text } : null, [taskId]);
    })),
    // Run all also comes from tasks.md's title bar (a Uri) and its keybinding (no argument,
    // the active editor); `runNodeOf` turns those into the view's node, else specOf asks.
    vscode.commands.registerCommand("kirocrew.spec.runAll", (node) => startSpec(node, "Run all tasks", async () => runAllOf(await runNodeOf(node), false))),
    vscode.commands.registerCommand("kirocrew.spec.runAllOptional", (node) => startSpec(node, "Run all tasks", async () => runAllOf(await runNodeOf(node), true))),
    vscode.commands.registerCommand("kirocrew.spec.resume", (node) => startSpec(node, "Resume run", () => resumeOf(node))),
    vscode.commands.registerCommand("kirocrew.spec.viewSession", (arg) => viewSessionOf(arg)),
    // The task lenses (requirement 4.1): the links store decides failed / aborted and "View
    // session"; a session counts as running while its slot's turn is going.
    taskLenses,
    vscode.languages.registerCodeLensProvider({ language: "markdown", pattern: TASK_LENS_PATTERN }, taskLenses),
    // "Fix task line" on the task format warnings (requirement 5.2).
    vscode.languages.registerCodeActionsProvider({ language: "markdown", pattern: TASK_LENS_PATTERN }, new SpecTaskFixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    // The borders follow the editors: painted when a tasks.md becomes visible or active and
    // re-painted (debounced) as it is typed in.
    taskDecorations,
    vscode.window.onDidChangeVisibleTextEditors(() => taskDecorations.applyAll()),
    vscode.window.onDidChangeActiveTextEditor((editor) => taskDecorations.apply(editor)),
    vscode.workspace.onDidChangeTextDocument((e) => taskDecorations.onDocument(e.document)),
    vscode.commands.registerCommand("kirocrew.spec.fixTask", (arg) => startSpec(arg, "Ask the agent to fix", () => fixTaskOf(arg))),
    vscode.commands.registerCommand("kirocrew.spec.makeRequired", (arg) => makeTaskRequired(arg)),
    // Requirement hovers on `_Requirements: …_` lines of every spec document (requirement 6.1) and
    // property hovers on `Property N` references and `Validates:` lines (requirement 6.2); the
    // heading and criterion links open the requirements (or bugfix) document at that heading.
    vscode.languages.registerHoverProvider({ language: "markdown", pattern: SPEC_HOVER_PATTERN }, new SpecRequirementHoverProvider({ models: () => specModels })),
    vscode.commands.registerCommand(REVEAL_REQUIREMENT_COMMAND, (arg) => revealRequirement(arg)),
    // The editor's "KiroCrew" context submenu (requirement 10.1, 10.2): one command per
    // action id, `kirocrew.editor.<id>`; package.json lists them under the submenu.
    ...EDITOR_ACTION_IDS.map((id) => vscode.commands.registerCommand("kirocrew.editor." + id, () =>
      runEditorAction(chat, id).catch((e) => vscode.window.showErrorMessage("KiroCrew: " + (e && e.message ? e.message : String(e)))))),
    // "Add code block to chat" (requirement 10.7), the submenu's last group: the selection as a
    // fenced block inserted into the composer's text, for the user to write around.
    vscode.commands.registerCommand("kirocrew.editor.addCodeBlock", () =>
      addCodeBlockToChat(chat).catch((e) => vscode.window.showErrorMessage("KiroCrew: " + (e && e.message ? e.message : String(e))))),
    // "Ask the agent to fix" in the light-bulb menu of any diagnostic (requirement 10.3): the
    // provider is registered on every document; the command receives the action's plain args.
    vscode.languages.registerCodeActionsProvider("*", new AgentFixCodeActionProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand(DIAGNOSTIC_FIX_COMMAND, (arg) =>
      runDiagnosticFix(chat, arg).catch((e) => vscode.window.showErrorMessage("KiroCrew: " + (e && e.message ? e.message : String(e))))),
    // "Send terminal to chat" (requirement 10.4): the `terminal/context` menu passes its
    // terminal, Ctrl/Cmd+Shift+R and the palette pass nothing (the active terminal).
    vscode.commands.registerCommand("kirocrew.terminal.sendToChat", (arg) =>
      sendTerminalToChat(chat, arg).catch((e) => vscode.window.showErrorMessage("KiroCrew: " + (e && e.message ? e.message : String(e))))),
    // "Add to chat context" (requirement 10.5): the explorer passes the clicked URI and
    // the whole multi-selection as the second argument.
    vscode.commands.registerCommand("kirocrew.explorer.addToChat", (uri, uris) =>
      addExplorerToChat(chat, uri, uris).catch((e) => vscode.window.showErrorMessage("KiroCrew: " + (e && e.message ? e.message : String(e))))),
    // "Generate commit message" (requirement 10.6): the `scm/title` menu passes its
    // SourceControl (the repository's rootUri), the palette passes nothing.
    vscode.commands.registerCommand(COMMIT_MESSAGE_COMMAND, (arg) =>
      generateCommitMessage(sessions, feed, arg).catch((e) => vscode.window.showErrorMessage("KiroCrew: " + (e && e.message ? e.message : String(e))))),
  );
  // A tasks.md already open when the extension starts gets its borders now.
  taskDecorations.applyAll();

  /**
   * "Ask the agent to fix" on a failed task's lens: the `fix` spec turn on the
   * Spec_Agent, with the full task (its details and sub-tasks from the spec's
   * tree) when the spec still has the task. `arg` is `{ feature, dir, task }`.
   */
  async function fixTaskOf(arg) {
    const target = viewSessionTarget(arg);
    const row = arg && arg.task && typeof arg.task === "object" ? arg.task : null;
    if (!target || !row) return vscode.window.showWarningMessage("Pick a failed task in tasks.md.");
    const spec = (await listSpecs()).find((s) => s.name === target.feature && (!target.dir || sameDir(s.dir.path, target.dir))) || null;
    const full = spec && spec.taskTree ? findTask(spec.taskTree, row.id || row.line) : null;
    const task = full || row;
    const label = full ? full.text : (row.number ? row.number + " " : "") + (row.title || row.id || "");
    await chat.sendSpecTurn(target.feature, "fix", "tasks.md", { dir: target.dir, task, displayText: "Fix task: " + label });
  }

  /**
   * "Make required" on an optional task's lens (requirement 4.4): delete the
   * `*` after the box of that one line through a WorkspaceEdit, so the rest of
   * the document (other optional marks included) is untouched and the change
   * lands in the editor's undo stack. `arg` is `{ uri, line }`.
   */
  async function makeTaskRequired(arg) {
    const uri = arg && arg.uri && arg.uri.path !== undefined ? arg.uri : null;
    const line = arg && Number.isInteger(arg.line) ? arg.line : -1;
    if (!uri || line < 0) return false;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (line >= doc.lineCount) return false;
    const mark = optionalMarkRange(doc.lineAt(line).text);
    if (!mark) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.delete(uri, new vscode.Range(line, mark.start, line, mark.end));
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) taskLenses.refresh();
    return ok;
  }

  /** The view's node when it passed one, else the spec of the document the command was invoked on (title bar, keybinding, spec editor); the raw argument when neither applies. */
  async function runNodeOf(node) {
    if (node && node.spec) return node;
    return specRunNode(node, await listSpecs(), specEditors) || node;
  }

  /**
   * "View session" (a Specs view row, a task code lens; requirement 13.2): the
   * session that last ran the task, else the one that last ran the spec. A tab
   * that already shows it is brought to the front as it is; otherwise the
   * session is reopened from history through kirocrew.openSession. From the
   * palette, with nothing to go on, the spec of the active document is used.
   */
  async function viewSessionOf(arg) {
    const target = viewSessionTarget(arg) || viewSessionTarget(specRunNode(arg, await listSpecs(), specEditors));
    if (!target) return vscode.window.showWarningMessage("Pick a spec or a task in the Specs view, or open one of the spec's documents.");
    const link = resolveViewSessionLink(taskSessionLinks(), target);
    // A run on Kiro's engine: the task's lastSessionId (or the feature's spec session) opens as a
    // Kiro-mode tab (requirement 5.5); it wins over an older gateway run of the same task.
    const kas = resolveKasViewSession(target, kasTasks(), taskSessionLinks());
    if (kas && (!link || link.engine === "kas" || !(kas.sessionId === link.sessionId))) {
      await vscode.commands.executeCommand("kirocrew.chat.focus");
      await chat.openKas(kas.sessionId, { mode: "spec", title: "Kiro spec: " + target.feature });
      return;
    }
    if (!link) return vscode.window.showInformationMessage("No session has run " + target.feature + (target.taskId ? " (task " + target.taskId + ")" : "") + " yet.");
    await vscode.commands.executeCommand("kirocrew.chat.focus");
    if (link.engine === "kas") { await chat.openKas(link.sessionId, { mode: "spec", title: "Kiro spec: " + target.feature }); return; }
    const tab = chat.tabForKey(link.sessionId);
    if (tab) chat.select(tab.id);
    else await vscode.commands.executeCommand("kirocrew.openSession", link.sessionId);
  }

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
    const taskIds = spec.tasks.filter((t) => !t.done && t.leaf && (optional || !t.optional)).map((t) => t.id);
    await runTasks(spec, (kiro) => (kiro ? kiroRunAllRequest(spec) : runAllPrompt(spec)), display, "spec", { spec: spec.name, dir: spec.dir.path, task: null, optional: Boolean(optional), display }, taskIds);
  }

  /**
   * Resume an interrupted run (the Specs view's ⟳, the spec editor's "Resume
   * run"): in the session that ran it when the IDE still has its tab and it is
   * idle, else as a fresh Run all tasks, whose request already carries the
   * ticked tasks to skip. Optional tasks stay optional unless a tab's run said
   * otherwise.
   */
  async function resumeOf(node) {
    const spec = await specOf(node);
    await vscode.commands.executeCommand("kirocrew.chat.focus");
    const outcome = await chat.resumeSpec(spec, () => runAllOf({ spec, contextValue: "spec" }, false));
    if (outcome === "running") vscode.window.setStatusBarMessage("KiroCrew: the run of " + spec.name + " is still going", 5000);
    else if (outcome === "resumed") vscode.window.setStatusBarMessage("KiroCrew: resuming " + spec.name + " in its session", 5000);
  }

  /**
   * Dispatch a task run: Spec mode, the configured spec agent, Autopilot per
   * `kirocrew.specAutopilot`, Kiro's visible turn text; `run` is what checkRun
   * resumes from. `taskIds` (the tasks this run executes) go into a
   * TaskSessionLinks record before the turn starts; the tab fills in the
   * session id once the gateway names it and the outcome when the turn ends
   * (a dispatch that fails before a turn runs is recorded as an error).
   */
  async function runTasks(spec, text, display, kind, run, taskIds) {
    await vscode.commands.executeCommand("kirocrew.chat.focus");
    // The chat shows this run starting before the engine probe and the session create,
    // in the tab both engines then land in (dispatch takes it; openKas adopts it).
    const prepared = chat.beginSpecRun({
      mode: "spec", agent: cfg("specAgent", "") || undefined, kind, title: display, display,
      autopilot: cfg("specAutopilot", true) !== false, run: run || null, spec: { name: spec.name, dir: spec.dir },
    });
    const engine = await chat.specEngine();
    const links = taskSessionLinks();
    const link = links ? links.record({ feature: spec.name, dir: spec.dir.path, taskIds: Array.isArray(taskIds) ? taskIds : [], sessionId: null, startedAt: Date.now(), engine: engine === "kas" ? "kas" : undefined }) : null;
    let key;
    try {
      // Kiro's engine (kirocrew.specEngine = kas): executeTask / runAllTasks with Kiro IDE's argument
      // shapes; the hook turns Autopilot on for the session first. No run record: Kiro's own
      // checkpoint resumes a run-all, and a method KAS lacks falls back to the gateway path.
      const docs = ChatView.kasSpecDocuments(spec);
      const viaKas = async () => {
        const op = run && run.task ? "executeTask" : "runAllTasks";
        const args = op === "executeTask"
          ? { featureName: spec.name, specDocuments: docs.specDocuments, tasksFilePath: docs.tasksFilePath, taskId: run.task }
          : { featureName: spec.name, specDocuments: docs.specDocuments, tasksFilePath: docs.tasksFilePath, makeAllRequired: Boolean(run && run.optional) };
        const t = await chat.runKasSpec(op, args, { feature: spec.name, dir: spec.dir, title: display, link: link ? link.id : null, tab: prepared });
        return t.key;
      };
      const viaGateway = () => chat.dispatch(text, { mode: "spec", agent: cfg("specAgent", "") || undefined, title: display, kind, display, autopilot: cfg("specAutopilot", true) !== false, run: run || null, spec: { name: spec.name, dir: spec.dir }, link: link ? link.id : null, tab: prepared });
      key = run ? await chat.specAction(viaKas, viaGateway) : await viaGateway();
    } catch (error) {
      if (link) links.setOutcome(link.id, "error");
      // Nothing ran in the prepared tab: drop it rather than leave a chat that never starts.
      if (!prepared.key) chat.closeTab(prepared.id);
      throw error;
    }
    vscode.window.setStatusBarMessage("KiroCrew: " + display + " — session " + key, 5000);
    return key;
  }
}

module.exports = { activate, deactivate() {} };
// Pure helpers, exposed for `tests/extension_unit.test.mjs` (never used by the host).
module.exports.__test = { gatewayAgent, GATEWAY_RESERVED_AGENT_IDS, unavailableAgentOf, kasHistoryItems, KAS_SESSIONS_ROUTE, mergeKasTaskState, kasFeatureOfPath, resolveKasViewSession, KasTaskStore, KAS_TASK_POLL_MS, KAS_WS_PATH, KAS_MODES, KAS_SECTION, KAS_TAB_NOTICE, kasStatus, invalidateKasStatus, kasPicks, isKasTab, kasTabState, kasTabRecord, kasPromptBlocks, kasContentText, kasToolOutput, kasPermissionChoice, kasFramesToMessages, toolInputPreview, KasLink, isErrorRow, isTurnLimitRow, turnLimitOf, resumeRequest, isSpecTab, runState, describeLeft, looksLikeQuestion, listSpecs, imageData, IMAGE_PREVIEW_MAX, RESUME_CHAT_TEXT, RESUME_NOTE, readText, readWholeText, SPEC_CONFIG_FILE, WORKFLOW_TYPES, SPEC_TYPES, DEFAULT_WORKFLOW_TYPE, DEFAULT_SPEC_TYPE, DOCUMENT_ORDER, uuid, parseSpecConfig, readSpecConfig, newSpecConfig, serializeSpecConfig, writeSpecConfig, documentOrder, requirementsFileOf, specDocumentRows, SPEC_NAME_PATTERN, SPEC_NAME_MAX, SPEC_NAME_FALLBACK, WORKFLOW_TYPE_PICKS, SPEC_TYPE_PICKS, specNameFromIdea, validateSpecName, existingSpecNames, createSpecFromIdea, specFolderOf, renameSpec, SPEC_DELETE_BUTTON, deleteSpec, HOST_CONTEXT_MAX, CONTEXT_BUDGET, parseSteering, globToRegExp, steeringMatches, steeringMentions, listSteering, invalidateSteeringCache, agentLoadsSteering, parseTasks, parseTaskLine, parseTaskTree, flattenTasks, taskBlockEnd, findTask, serializeTask, makeAllTasksRequired, parseRequirements, findRequirement, parseProperties, findProperty, correctnessSection, buildSpecModel, loadSpecModel, specDirOf, specFileOf, SpecModelStore, specModelStore, SPEC_MODEL_DEBOUNCE_MS, SPEC_MODEL_FILES, TASK_SESSION_LINKS_KEY, TASK_SESSION_LINKS_MAX, LINK_OUTCOMES, normalizeLink, readLinks, pruneLinks, latestLink, linkMatchesFeature, latestLinkForTask, latestLinkForFeature, findLink, viewSessionTarget, resolveViewSessionLink, TASK_STATES, taskStateLink, taskState, TaskSessionLinks, taskSessionLinks, TASK_LENS_PATTERN, TASK_STATE_LENS_TITLES, TASK_LENS_RETRY, TASK_LENS_FIX, TASK_LENS_VIEW_SESSION, TASK_LENS_MAKE_REQUIRED, taskLensSpecs, optionalMarkRange, SpecTaskCodeLensProvider, TASK_DECORATION_COLORS, TASK_DECORATION_OPTIONAL_OPACITY, TASK_DECORATION_DEBOUNCE_MS, mergeLineRanges, taskDecorationRanges, SpecTaskDecorations, SPEC_CONTEXT_KEYS, SPEC_CONFIG_DIAGNOSTICS, specContextKeyValues, positionAt, specConfigDiagnostic, toVscodeDiagnostic, specDirUri, SpecContextKeys, SpecConfigDiagnostics, SPEC_TASK_DIAGNOSTICS, TASK_FORMAT_RULES, TASK_FORMAT_BOXES, TASK_FORMAT_INDENT, TASK_FORMAT_LINE, TASK_DIAGNOSTICS_DEBOUNCE_MS, taskFormatIssues, toTaskDiagnostic, createDiagnosticCollection, SpecTaskDiagnostics, TASK_FIX_TITLE, TASK_FIX_NUMBER_RULES, taskNumbersOf, fixTaskLine, rangesIntersect, taskFixAction, SpecTaskFixProvider, SPEC_HOVER_PATTERN, REVEAL_REQUIREMENT_COMMAND, requirementRefsAt, requirementRefsAfter, activeRefs, revealRequirementUri, requirementHoverMarkdown, hoverMarkdown, makeHover, requirementHoverResolver, PROPERTY_HOVER_FILE, propertyRefsAt, propertyHoverMarkdown, propertyAtLine, propertyHoverResolver, SpecRequirementHoverProvider, revealRequirement, SPEC_NAV_DOCUMENTS, SPEC_GOTO_COMMAND_PREFIX, SPEC_RESOURCE_WHEN, specDocumentName, specGotoCommand, specNavigationTargets, adjacentSpecDocument, specGotoMenuEntries, specGotoPaletteEntries, specCommandSource, specRunNode, gotoSpecDocument, stepSpecDocument, SPEC_CONTENT_KEY, SPEC_SYNC_WHEN, SPEC_NEXT_WHEN, SPEC_RUN_ALL_WHEN, specDocumentHasContent, nextDocumentDecision, SpecContentKey, specConfigFor, specDocumentState, syncSpecDocument, nextSpecDocument, kiroTaskRequest, kiroRunAllRequest, phasePrompt, taskPrompt, runAllPrompt, SPEC_TURN_KINDS, specTurnDocument, specSiblings, specTurnText, specTurnDisplay, specTurnTitle, specSiblingContexts, SPEC_START_ANY, SPEC_START_NEW, SpecStartGuard, specStartKey, specTabRecord, specTabMatches, normalizeRow, findMatches, markTextNode, pendingApprovalCards, TOOL_CARD_DISPLAY_MODES, DEFAULT_TOOL_CARD_DISPLAY_MODE, toolRowShouldCollapse, findPathLinks, chatHtml, nextTabIndex, tabLabel, TAB_TITLE_MAX, validateTabTitle, sameDir, slotTime, slotActivity, ageLabel, HOOK_FILE_RE, HOOK_TRIGGERS, HOOK_MATCHER_TRIGGERS, HOOK_ACTION_KINDS, hookNameFromPath, parseHookFile, hookRowLabel, hookRowDescription, hookRowIcon, hookContextValue, hookRowTooltip, toggleHookEnabled, HooksTree, toggleHook, HOOK_RUN_COMMAND, HOOK_RUN_CONFIRM, HOOK_RUN_BUTTON, hookRunDisplay, hookTerminalName, hookRunDecision, hookTerminal, runHook, HOOK_TEMPLATE, HOOK_TRIGGER_DESCRIPTIONS, HOOK_FILE_TRIGGERS, HOOK_DEFAULT_FILE_MATCHER, HOOK_FILE_EXT, HOOK_DOCS_URL, HOOK_DOCS_COMMAND, HOOK_VIEW_MESSAGE, HOOK_VIEW_MESSAGE_PLAIN, setHookViewMessage, buildHookFile, serializeHookFile, hookFileName, hookScopePicks, createHookWizard, MCP_CONFIG_FILE, MCP_DOCS_URL, MCP_OPEN_CONFIG_COMMAND, MCP_CONFIG_ABSENT_MESSAGE, parseMcpConfig, mcpUrlHost, mcpRowDescription, mcpRowIcon, mcpRowTooltip, mcpServerLine, McpServersTree, openMcpConfig, STEERING_TEMPLATE, SKILL_TEMPLATE, STEERING_EMPTY_CONTEXT_KEY, STEERING_GENERATE_COMMAND, STEERING_GENERATE_DISPLAY, STEERING_GENERATE_FILES, STEERING_GENERATE_PROMPT, steeringIsEmpty, ensureSteeringDir, generateSteeringDocs, STEERING_REFINE_COMMAND, STEERING_REFINE_PROMPT, isSteeringDocument, steeringNameOf, steeringRefineDisplay, steeringDocLabel, refineSteeringDoc, STEERING_IMPORT_COMMAND, IMPORT_SOURCES, IMPORT_FIND_EXCLUDE, IMPORT_FIND_MAX, importStem, importTargetName, withSteeringFrontMatter, scanImportSources, importSteeringFromAssistants, SKILL_IMPORT_COMMAND, SKILL_FILE, SKILL_IMPORT_ROUTE, SKILL_NAME_RE, parseGithubSkillUrl, skillNameFromText, skillScopePicks, importSkillFolder, importSkillFromGithub, revealSkill, importSkill, AssetTree, mdToHtml, stageOf, specNameOf, continueAction, REVIEW_EXCERPT_MAX, reviewBlockId, reviewExcerpt, buildReviewTurn, SPEC_REVIEW_CONTEXT_KEYS, specEditorHtml, isSpecDocument, SpecEditorProvider, openSpecPreview, specReviewTarget, reviewSpecDocument, markSpecEditor, renderMarkdown, localizeImages, workflowContext, splitOptions, WORKFLOWS, CONTEXT_KINDS, CONTEXT_FILE_KINDS, CONTEXT_PROVIDERS, CONTEXT_CAP, PROVIDER_CAP, TERMINAL_TAIL_LINES, TERMINAL_HISTORY_MAX, FOLDER_FILES_MAX, GIT_ABSENT_MESSAGE, byteLength, capText, tailLines, stripAnsi, formatProblems, formatFolder, formatSpec, formatGitDiff, providerEntry, contextChipLabel, contextChipTooltip, contextChipEcho, providerContext, plainDiagnostic, clipboardVia, trackTerminalOutput, resolveProblems, resolveTerminal, resolveGitDiff, resolveFolder, resolveSpec, pickContext, looksBinary, fileContextEntry, fileContext, sendTerminalToChat, EXPLORER_MAX_ITEMS, explorerSelection, addExplorerToChat, EDITOR_ACTION_IDS, EDITOR_ACTION_TITLES, DEFAULT_ACTION_PROMPTS, SELECTION_GLYPH, actionPrompt, fenceFor, buildSelectionContext, selectionInput, selectionContext, runEditorAction, fencedBlock, addCodeBlockToChat, COMMIT_MESSAGE_COMMAND, COMMIT_MESSAGE_SESSION_TITLE, COMMIT_MESSAGE_TIMEOUT_MS, COMMIT_MESSAGE_GIT_ABSENT, COMMIT_MESSAGE_NOTHING, COMMIT_MESSAGE_PROMPT, pickDiff, commitMessagePrompt, cleanCommitMessage, gitRepository, runBackgroundTurn, generateCommitMessage, DIAGNOSTIC_FIX_COMMAND, DIAGNOSTIC_FIX_TITLE, DIAGNOSTIC_TITLE_MAX, DIAGNOSTIC_GLYPH, DIAGNOSTIC_FIX_PROMPT, diagnosticTitle, plainRange, buildDiagnosticFixContext, diagnosticFixAction, AgentFixCodeActionProvider, runDiagnosticFix, clip, ChatView, Sessions, themeFor, STOCK_THEMES, mergeRosters, agentPicks, activate };
