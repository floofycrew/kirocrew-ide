// KiroCrew IDE — the mod's page inside the FloofyCrew App.
//
// Settings and engine status ONLY. The workbench itself is the "KiroCrew IDE"
// App in the sidebar (the mod installs it through the host App Kit); this page
// tells the user so rather than embedding a second copy, and stays useful when
// the App is disabled: engine install, default folder, start/stop, the
// same-origin proxy state.

export default async function mount(container, api) {
  container.innerHTML = "";
  const root = document.createElement("div");
  root.style.cssText = "display:flex;flex-direction:column;gap:12px;font:13px/1.5 system-ui;max-width:720px;";
  container.appendChild(root);

  const el = (tag, css, text) => {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, onClick, primary) => {
    const node = el("button", primary
      ? "padding:4px 12px;border-radius:6px;border:1px solid var(--accent,#7c5cff);background:var(--accent,#7c5cff);color:#fff;cursor:pointer;"
      : "padding:4px 12px;border-radius:6px;border:1px solid var(--border-color,#4443);background:transparent;color:inherit;cursor:pointer;", label);
    node.addEventListener("click", onClick);
    return node;
  };
  const card = (title) => {
    const box = el("div", "border:1px solid var(--border-color,#4443);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;");
    box.appendChild(el("strong", "", title));
    root.appendChild(box);
    return box;
  };

  // --- where the IDE is
  const where = card("Open the IDE");
  where.appendChild(el("div", "opacity:.85;",
    "The workbench is the \u201cKiroCrew IDE\u201d entry under Apps in the sidebar. " +
    "Open it there; this page only manages the engine behind it."));
  const openRow = el("div", "display:flex;gap:8px;align-items:center;");
  openRow.appendChild(button("Open KiroCrew IDE", () => {
    // The dashboard is a SPA; a history push + popstate is how its router follows an in-page navigation.
    history.pushState({}, "", "/apps/kirocrew-ide");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, true));
  const appHint = el("span", "opacity:.6;", "");
  openRow.appendChild(appHint);
  where.appendChild(openRow);

  // --- engine
  const engine = card("Engine");
  const status = el("div", "", "loading\u2026");
  engine.appendChild(status);
  const detail = el("div", "opacity:.6;font-size:12px;white-space:pre-wrap;", "");
  engine.appendChild(detail);
  const row = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:center;");
  engine.appendChild(row);
  const startButton = button("Start", async () => {
    status.textContent = "starting\u2026";
    const reply = await api.routes.fetch("start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(folderInput.value ? { folder: folderInput.value } : {}),
    });
    const data = await reply.json();
    if (!reply.ok) await api.dialog.alert(data.error || "start failed");
    await refresh();
  }, true);
  const stopButton = button("Stop", async () => {
    const sure = await api.dialog.confirm(
      "Stop the IDE engine? Open editors reconnect when it starts again; unsaved changes are kept by the browser session.",
      { danger: true, okLabel: "Stop it" });
    if (!sure) return;
    await api.routes.fetch("stop", { method: "POST" });
    await refresh();
  });
  const installButton = button("Install engine (~100 MB)", async () => {
    const sure = await api.dialog.confirm(
      "Download openvscode-server (MIT, ~100 MB) from GitHub releases into this mod's data directory and use it as the IDE engine?",
      { okLabel: "Download" });
    if (!sure) return;
    await api.routes.fetch("engines/install", { method: "POST", body: "{}" });
    installButton.style.display = "none";
    const poll = setInterval(async () => {
      await refresh();
      const engines = await (await api.routes.fetch("engines")).json();
      if (!["resolving", "downloading", "extracting"].includes((engines.install || {}).state)) clearInterval(poll);
    }, 2000);
  }, true);
  row.appendChild(startButton);
  row.appendChild(stopButton);
  row.appendChild(installButton);
  row.appendChild(button("Refresh", () => refresh()));

  // --- settings
  const settings = card("Settings");
  const folderLabel = el("label", "display:flex;flex-direction:column;gap:4px;");
  folderLabel.appendChild(el("span", "opacity:.7;", "Default workspace folder (the App's folder picker starts here)"));
  const folderInput = el("input", "padding:4px 8px;border-radius:6px;border:1px solid var(--border-color,#4443);background:transparent;color:inherit;");
  folderInput.placeholder = "~ (home)";
  folderLabel.appendChild(folderInput);
  settings.appendChild(folderLabel);
  const config = await api.config.get();
  if (config.default_folder) folderInput.value = config.default_folder;
  folderInput.addEventListener("change", () => api.config.set({ default_folder: folderInput.value || null }));
  settings.appendChild(el("div", "opacity:.6;font-size:12px;",
    "Advanced keys (mod config): engine.command (custom engine template with {port} {token} {folder} {auth} {basepath}), " +
    "engine.port (pin the loopback port), engine.token (true = connection token; breaks embedding), " +
    "kas.idle_minutes (minutes an idle kiro-cli child lives, default 30), kas.kiro_cli (path of the kiro-cli to run)."));

  // --- Kiro modes (kiro-cli): the sessions the hook's kiro-cli children ran, read-only.
  // These live in kiro-cli's own store (~/.kiro/sessions) and the hook's relay log, never in
  // KiroCrew's session store, so the dashboard's own session list does not show them.
  const kas = card("Kiro modes (kiro-cli)");
  kas.appendChild(el("div", "opacity:.85;",
    "Kiro's Spec, Quick Spec, Bug Fix and Plan run in a kiro-cli child the hook owns per workspace; " +
    "their sessions are kept by kiro-cli itself and relayed by the hook. Read-only here: nothing is written to KiroCrew's session store."));
  const kasStatus = el("div", "opacity:.7;font-size:12px;", "loading\u2026");
  kas.appendChild(kasStatus);
  const kasTable = el("table", "border-collapse:collapse;width:100%;font-size:12px;");
  kas.appendChild(kasTable);
  const kasTranscript = el("pre", "display:none;max-height:360px;overflow:auto;white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace;border:1px solid var(--border-color,#4443);border-radius:6px;padding:8px 10px;margin:0;", "");
  kas.appendChild(kasTranscript);
  const kasRow = el("div", "display:flex;gap:8px;");
  kasRow.appendChild(button("Refresh", () => refreshKas()));
  kas.appendChild(kasRow);

  const age = (seconds) => {
    if (!seconds) return "";
    const diff = Math.max(0, Date.now() / 1000 - Number(seconds));
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.round(diff / 60) + " min ago";
    if (diff < 86400) return Math.round(diff / 3600) + " h ago";
    return Math.round(diff / 86400) + " d ago";
  };
  // One line per relayed frame of the hook's log: the shapes hook/kas.py buffers (userPrompt,
  // update with KAS's session/update, ask, askResolved, turnEnd, error, clear).
  const transcriptText = (frames) => {
    const lines = [];
    let agent = "";
    const flush = () => { if (agent.trim()) lines.push("assistant: " + agent.trim()); agent = ""; };
    for (const f of frames || []) {
      if (f.kind === "userPrompt") { flush(); lines.push("user: " + String(f.text || "")); continue; }
      if (f.kind === "update") {
        const u = f.update || {};
        const text = u.content && u.content.type === "text" ? String(u.content.text || "") : "";
        if (u.sessionUpdate === "user_message_chunk") { flush(); if (text) lines.push("user: " + text); }
        else if (u.sessionUpdate === "agent_message_chunk") agent += text;
        else if (u.sessionUpdate === "agent_thought_chunk") { flush(); if (text) lines.push("thinking: " + text.slice(0, 200)); }
        else if (u.sessionUpdate === "tool_call") { flush(); lines.push("tool: " + (u.title || u.kind || "tool") + (u.status ? " [" + u.status + "]" : "")); }
        else if (u.sessionUpdate === "tool_call_update" && (u.status === "completed" || u.status === "failed")) { flush(); lines.push("tool " + (u.toolCallId || "") + " " + u.status); }
        continue;
      }
      if (f.kind === "ask") { flush(); lines.push((f.ask === "permission" ? "permission asked: " + (f.title || "tool") : "question: " + String(f.question || "")) + " (#" + f.requestId + ")"); continue; }
      if (f.kind === "askResolved") { flush(); lines.push("answered #" + f.requestId + ": " + (f.cancelled ? "cancelled" : f.optionId || f.answer || "")); continue; }
      if (f.kind === "turnEnd") { flush(); lines.push("\u2014 turn ended: " + (f.stopReason || "end_turn") + " \u2014"); continue; }
      if (f.kind === "error") { flush(); lines.push("error: " + String(f.message || "")); continue; }
    }
    flush();
    return lines.join("\n");
  };
  async function showTranscript(row) {
    kasTranscript.style.display = "";
    kasTranscript.textContent = "loading transcript of " + row.sessionId + "\u2026";
    try {
      const doc = await (await api.routes.fetch("kas/sessions/" + encodeURIComponent(row.sessionId) + "/transcript")).json();
      const frames = Array.isArray(doc.frames) ? doc.frames : [];
      kasTranscript.textContent = frames.length ? "session " + row.sessionId + " (" + frames.length + " relayed frames, read-only)\n\n" + transcriptText(frames)
        : "session " + row.sessionId + ": " + (doc.reason || "no transcript") + ". Open it from the IDE's History (Kiro modes) to load it from kiro-cli's store.";
    } catch (err) {
      kasTranscript.textContent = "transcript unavailable (" + err + ")";
    }
  }
  async function refreshKas() {
    let st, doc;
    try {
      [st, doc] = await Promise.all([api.routes.fetch("kas/status").then((r) => r.json()), api.routes.fetch("kas/sessions").then((r) => r.json())]);
    } catch (err) {
      kasStatus.textContent = "kas routes unreachable (" + err + ") \u2014 the hook predates this feature; restart the gateway once";
      return;
    }
    const cli = st.kiroCli || {};
    const children = (st.workspaces || []).map((w) => (w.folder || "").split("/").pop() + " (pid " + w.pid + ", " + (w.sessions || []).length + " session" + ((w.sessions || []).length === 1 ? "" : "s") + ")");
    kasStatus.textContent = (st.available ? (/^kiro-cli/.test(cli.version || "") ? cli.version : "kiro-cli " + (cli.version || "")) + (st.login && st.login.loggedIn === false ? " \u2014 not logged in" : "") : "unavailable: " + (st.reason || "")) +
      " \u00b7 idle stop after " + st.idleMinutes + " min \u00b7 " + (children.length ? "running for " + children.join(", ") : "no kiro-cli child running");
    kasTable.innerHTML = "";
    const rows = Array.isArray(doc.sessions) ? doc.sessions : [];
    if (!rows.length) { kasTable.appendChild(el("caption", "text-align:left;opacity:.6;", "No Kiro-mode sessions yet \u2014 pick a Kiro mode in the IDE's agent picker.")); return; }
    const head = el("tr", "");
    for (const h of ["Title", "Mode", "Spec", "State", "Last activity", "Workspace", "Source"]) head.appendChild(el("th", "text-align:left;padding:3px 6px;border-bottom:1px solid var(--border-color,#4443);opacity:.7;font-weight:600;", h));
    kasTable.appendChild(head);
    for (const r of rows.slice(0, 100)) {
      const tr = el("tr", "cursor:pointer;");
      tr.title = r.sessionId + " \u2014 click for the read-only transcript";
      const cells = [r.title || r.sessionId, r.mode || "", r.feature || "", r.state + (r.pendingAsks ? " (waiting)" : ""), age(r.lastActivity), (r.folder || "").split("/").pop(), r.source === "kas" ? "kiro-cli store" : "hook relay"];
      for (const c of cells) tr.appendChild(el("td", "padding:3px 6px;border-bottom:1px solid var(--border-color,#4442);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;", c));
      tr.addEventListener("click", () => showTranscript(r));
      kasTable.appendChild(tr);
    }
  }

  async function refresh() {
    let data;
    try {
      data = await (await api.routes.fetch("status")).json();
    } catch (err) {
      status.textContent = "backend unreachable (" + err + ")";
      return;
    }
    const proxied = data.proxy && data.proxy.inUse;
    if (data.running) {
      status.textContent = "running: " + data.server.engine + " \u2014 folder " + data.server.folder;
      detail.textContent = proxied
        ? "served same-origin at " + data.proxy.base + " through the dashboard port; nothing extra to forward"
        : "engine on 127.0.0.1:" + data.server.port + "; same-origin proxy " +
          (data.proxy && data.proxy.error ? "failed: " + data.proxy.error : "not armed (restart the gateway once after installing this mod)");
      startButton.style.display = "none";
      stopButton.style.display = "";
      installButton.style.display = "none";
      appHint.textContent = "engine running \u2014 the App will show the workbench";
    } else {
      startButton.style.display = data.engine ? "" : "none";
      stopButton.style.display = "none";
      appHint.textContent = data.engine ? "the App can start the engine too" : "install an engine first";
      if (!data.engine) {
        const engines = await (await api.routes.fetch("engines")).json();
        const install = engines.install || {};
        if (["resolving", "downloading", "extracting"].includes(install.state)) {
          const mb = ((install.bytes || 0) / 1048576).toFixed(1);
          status.textContent = "installing engine\u2026 " + install.state + (install.state === "downloading" ? " (" + mb + " MB)" : "");
          installButton.style.display = "none";
        } else {
          status.textContent = install.state === "error" ? "engine install failed" : "no engine installed";
          detail.textContent = (install.state === "error" ? install.error + "\n\n" : "") + (engines.hint || "");
          installButton.style.display = "";
        }
      } else {
        status.textContent = "stopped (engine: " + data.engine + ")";
        detail.textContent = data.proxy && data.proxy.registered
          ? "same-origin proxy armed at " + data.proxy.base
          : "same-origin proxy not armed yet \u2014 the engine will need its own port forward until the gateway restarts";
        installButton.style.display = "none";
      }
    }
  }

  await refresh();
  refreshKas().catch(() => undefined);
  const timer = setInterval(refresh, 15000);
  const kasTimer = setInterval(() => refreshKas().catch(() => undefined), 30000);
  return () => { clearInterval(timer); clearInterval(kasTimer); };
}
