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
    "engine.port (pin the loopback port), engine.token (true = connection token; breaks embedding)."));

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
  const timer = setInterval(refresh, 15000);
  return () => clearInterval(timer);
}
