# KiroCrew IDE — design

Goal: use KiroCrew as the primary IDE. Keep the KiroCrew backend (gateway,
agents, sessions, terminal, files) and put a real VS Code-class editor on top
of it, inside the dashboard.

## Architecture

```
┌ dashboard document ──────────────────────────────────────────┐
│  topbar [⌨ IDE] ← spa part, grafted via surface "topbar"     │
│  ┌ fullscreen overlay (spa part) ──────────────────────────┐ │
│  │ <iframe http://127.0.0.1:<port>/?tkn=…&folder=…>        │ │
│  └──────────────────────────────────────────────────────────┘ │
│  FloofyCrew App page (ui part): controls + embedded fallback  │
└───────────────────────────────────────────────────────────────┘
        │ mod control API (same-origin, dashboard auth)
        ▼
  gateway python-hook: ctx.routes  status / start / stop / engines
        │ subprocess, loopback only, per-start connection token
        ▼
  IDE engine (openvscode-server | code-server | custom command)
        working dir = the workspace folder
```

### Engine choice: measured, not assumed

Three candidates were examined on a real host (Kiro 1.0.337 remote server,
KiroCrew 0.7.0.5):

1. **Kiro IDE desktop** — an Electron app; a desktop window cannot be
   embedded in another app's document. Out.
2. **Kiro's own remote server** (`~/.kiro-server/bin/<commit>/`, installed by
   any Remote-SSH connect) — tempting because it bundles the real Kiro
   extensions including `kiro.kiro-agent` (the spec workflow). Probed: it
   runs under a system node 20 (its bundled node is patchelf'd to a
   `/opt/vsc-sysroot` linker that doesn't exist outside the Remote-SSH flow),
   binds and starts its extension host — but it serves **no browser
   workbench**: every HTTP fetch is refused and the build ships no
   `out/vs/code/browser` assets. It speaks only the remote extension-host
   protocol to a desktop client. Not embeddable as-is.
3. **openvscode-server** (MIT, Gitpod) — the VS Code core packaged exactly
   as a browser workbench over loopback HTTP+WebSocket. This is the engine.

So "porting the vscode core" = openvscode-server for the workbench, and the
**Kiro spec experience is reconstructed on top**, in two increments:
- our own spec support (v0.2 VSIX): `.kiro/specs` tree, format lint for
  requirements.md / design.md / tasks.md, requirements→design→tasks gating,
  per-task dispatch to a KiroCrew spec-agent session (where execution is
  durable — the actual point);
- a spike on side-loading `kiro.kiro-agent` from `~/.kiro-server/extensions`
  into openvscode-server. It may work, but it targets a fork (probe showed
  its sibling extensions pinning fork versions like `^1.110.0-20260204`) and
  may call fork-private APIs — treat as bonus, not the plan.

Resolution order in the hook: `engine.command` config template →
`openvscode-server`/`code-server` on PATH → the mod's own auto-installed
engine. **Auto-install**: if nothing resolves, the App page offers one-click
download of an openvscode-server release from GitHub into the mod's data dir
(hosts declared in `network.hosts[]`, https-only, allowlist re-checked on
every redirect, user-confirmed). Nothing is bundled: licenses stay clean and
the user picks/keeps the build they trust.

### Display strategy: a first-class App

- **The KiroCrew IDE App (primary, since 0.3.0)** — an `app` part installs a
  real App Kit app: "KiroCrew IDE" appears in the sidebar like any other app.
  Up to 0.12 its page held the workbench iframe, and "Fullscreen" was a second
  iframe portalled over the dashboard — so every toggle, and every visit to
  another route, reloaded the workbench. v0.1 had tried a topbar button + fixed
  overlay grafted through the surface registry; it looked foreign and 0.3.0
  dropped the spa part.
- **The IDE layer (0.13.0)** — the spa part is back, for the one thing an App
  page cannot do: outlive its route. `spa/layer.mjs` (runtime activation) owns
  the single workbench iframe as a fixed element of the dashboard document,
  never unmounted, in three modes: `fullscreen` (covering the KiroCrew UI),
  `docked` (0.14.0: positioned over the App page's dock box, following its
  rectangle through a ResizeObserver, scroll/resize listeners and a slow poll —
  the iframe is never reparented, because moving an iframe reloads it) and
  `hidden` (`display:none`). The App page is the controller (start/stop,
  folder, engine install, Fullscreen) and registers its dock box through
  `window.__kirocrewIde.dock(el)` while mounted; leaving fullscreen lands on
  the dock when the page is open; the API's `exitFullscreen()` navigates to
  the page when it is not (history push + popstate, the dashboard router's
  contract) — there is no bar button for it, ◁ KiroCrew is the single exit.
  The layer also carries the two tag stacks: a
  `<host> IDE` chip appended to KiroCrew's `crew-chip-row` (re-inserted after
  every host re-render; the `topbar` surface when no crew bar exists), and the
  layer's own title-bar stack of crew chips. Crew switching from inside a
  remote pane speaks the pane's own protocol to the desktop window
  (`mc-embedded-ready` → `mc-host-model`, `mc-switch-instance`); on a local
  dashboard it clicks the chips KiroCrew paints (the Radix dropdown behind
  them is not scriptable), see `spa/hostmodel.mjs`.
- **Embedded page (fallback/settings)** — the ui part inside the FloofyCrew
  App: same controls, same iframe, still there if the App Kit admission
  refuses the app.
- **Popout window (phase 2)** — a real detached OS window in the KiroCrew
  desktop shell needs an `electron:` patch part (see roadmap).

### One port: the same-origin workbench proxy (0.4.0)

Every host worth using this on is remote, so "forward one more port per
service" is not an acceptable tax. Since 0.4.0 the workbench is served from the
**dashboard's own origin** at `/kirocrew-ide`, and the engine runs with
`--server-base-path /kirocrew-ide` so every URL it emits lands there. The
dashboard port you already forward carries the IDE; the engine's loopback port
never has to leave the host.

Why this is a mod and not an app, measured on 0.7.0.5:

- The workbench's extension host runs over a **WebSocket**. The host's App Kit
  reverse proxy (`apps/routes.py::handle_app_api_proxy`) strips `upgrade` and
  `connection` (`_PROXY_HOP_HEADERS`) and forwards with a plain
  `session.request`, so it cannot carry the workbench — an app is structurally
  incapable of this, regardless of effort.
- FloofyCrew's own mod route API is JSON-in/JSON-out over 1–4 path segments —
  also not enough.
- What works is a **raw aiohttp route** on the gateway's own application, added
  while the router is still open. A `python-hook` with `"early": true` runs
  before the host composes the gateway and registers an `after` hook on
  `kiro_crew.apps.routes:register_app_routes`, which receives the
  `web.Application`; the route is added there, and the handler answers a
  WebSocket upgrade with `web.WebSocketResponse` bridged to the engine, or
  streams plain HTTP both ways.

Consequences worth stating plainly: the route lives behind the dashboard's own
session auth (the iframe is same-origin, so it authenticates for free), the
proxy is registered only while the mod is enabled, and a **gateway restart** is
required after install because early hooks run at process start. Without the
shim the mod degrades to the direct-port mode rather than breaking.

### Security posture

- Engine binds `127.0.0.1` only — reachable by local processes, never the
  network. A connection token is **opt-in** (`engine.token`), not the default:
  measured on openvscode-server 1.109.5, `?tkn=T` answers a 302 that sets
  `vscode-tkn=T; SameSite=Lax`, and because the workbench iframe sits on a
  different port from the dashboard, that Lax cookie is never returned — the
  engine then answers a bare "Forbidden." A token therefore trades away
  embedding, which is the entire product; loopback binding is the control that
  actually holds. This matches the `code-server --auth none` preset.
- The mod's control routes sit behind the dashboard session (Loader routes
  are same-origin, auth'd). `network.hosts` is empty — nothing leaves the box.
- The measured host CSP (dashboard/server.py, build 0.7.0.5) already admits
  loopback frames and websockets: `frame-src … http://127.0.0.1:* http://localhost:*`
  and `connect-src … ws://localhost:* ws://127.0.0.1:*`. No CSP patch needed.

### Lifecycle

`start` records `{pid, port, token, folder, workspaces}` in the mod data dir; a
gateway restart **adopts** a still-live server (pid+port probe) instead of
killing the editor. `deactivate` deliberately leaves the engine running; `stop`
is the only off switch. Engine stdout/err goes to `<data>/engine.log`.

**Workspaces (0.15.0).** One engine, many folders: the engine serves whatever
`?folder=` a workbench document asks for, so a second workspace is a second
embed URL, not a second process (`status.workspaces[]` = `{folder, name,
embedUrl}`; `workspaces/open` / `workspaces/close`; `start` on a running engine
with a folder opens it). The open set rides in the engine's persisted state so
it lives and dies with the engine. The browser side (spa/layer.mjs) keeps one
iframe per workspace, created when first shown, only the active one displayed —
switching never reloads, and the manager is the dropdown behind the `IDE`
segment of the bar (open folders, ×, and an in-menu folder picker over
`browse`).

**Profile list (0.15.0).** The web workbench owns the profile LIST in the
browser (`localStorage.userDataProfiles`, per origin); the engine's
`storage.json` only mirrors it, so a profile imported in one client was missing
in another while its data sat under `data/User/profiles/<id>/`. The proxy seeds
each client's list from the mirror (profiles whose folder exists, never
removing, ahead of the activity-order seed that reads the same list).

## Why this must be a FloofyCrew mod, not a plain KiroCrew App

An App Kit app runs third-party Python in the gateway and an ES module in the
dashboard document — so an app *could* spawn a server and even render an
iframe **inside its own page container**. That gets you exactly the squashed
panel the request rules out. Everything that makes this an IDE replacement
rather than a widget needs seams only FloofyCrew has:

1. **Host chrome takeover.** The launch button lives in the host's own topbar
   and the overlay must win against host z-indexes and survive host route
   changes. App Kit gives an app **no handle on host UI** — no surface
   registry, no stable selectors, no notification when the shell re-renders.
   FloofyCrew's `ctx.surfaces` locates `topbar`/`shell.root` by content
   fingerprints, re-resolves on DOM mutation, and the Forge re-tests those
   fingerprints on every host release (compat matrix). An app doing raw
   `querySelector` on minified class names breaks silently on the next build;
   the mod is quarantined-with-a-reason instead of broken.
2. **The desktop-shell popout (phase 2) is categorically out of an app's
   reach.** Apps exist in gateway + dashboard. A real detached IDE window —
   own zoom, own shortcuts, no dashboard tab — means editing the Electron
   shell's `app.asar` members. Only the Patcher's `electron:` patch side does
   that (precedent in this repo: `mochi-pet-zoom-fix`), with fingerprint
   gates, backups, and re-application after every host update. There is no
   App Kit permission that touches the shell at all.
3. **Deep host integration (phase 2) needs the hook registry.** "Open in
   IDE" from the built-in file browser, or routing the host terminal's file
   links into the editor, means wrapping host route handlers
   (`ctx.hooks.after("route:GET /api/files/…")`) or host functions by import
   path. App Kit deliberately has no mechanism to wrap host internals; the
   Loader's per-mod, fail-open, reversible hook registry is the only
   sanctioned way in.
4. **First-frame boot (phase 3).** An `/ide` deep link that paints the IDE
   before React hydrates requires a `spa` part with `activation: "boot"` —
   `index.html` injection the Patcher owns. Apps cannot touch `index.html`.
5. **Update survival with a verdict.** Every seam above is re-applied,
   fingerprint-gated and reporter-tested on host updates, and `floofy restore
   --all` returns the host to vanilla. An app hand-rolling ANY of 1–4 would
   be an unaudited host patch with no rollback story — precisely the thing
   the App admission model does not cover and FloofyCrew was built to make
   safe.

Honest boundary: pieces 1 (partially), and the plain iframe-in-a-page, are
approximable by an app; pieces 2–4 are not possible from App Kit at all. The
product — full-viewport IDE, popout window, host-wide entry points — needs
2–4, so it needs the mod.

## The point of the merger: IDE ergonomics on Crew durability

The reason to bring Kiro IDE and KiroCrew together is not the editor — it is
that the two halves each own what the other lacks:

| | Kiro IDE (remote-ssh) | KiroCrew |
|---|---|---|
| editing, file browsing, diffs | native, excellent | clunky built-ins |
| spec coding workflow | native (`.kiro/specs`) | agent-driven, no UI |
| survives ssh/laptop disconnect | **no — session dies** | **yes — gateway-resident** |
| progress visibility | only while connected | dashboard, transcripts, status |

Today's workaround (KiroCrew spawns tmux → `kiro-cli --v3` with a spec agent
→ a second tmux session monitors/nudges it) buys durability by giving up all
visibility: progress is invisible unless you attach, ask, or poll on a
schedule. The fix is structural, not more polling: **spec runs become
KiroCrew sessions** — gateway-resident, disconnect-proof, with structured
status/transcript/approval state — and the IDE becomes a *view* over them.
Kill the tmux layer entirely.

Measured host enablers (0.7.0.5 payload): the gateway exposes the full
session API the dashboard itself runs on (`dashboard/handlers/sessions.py`:
create, message, transcript, status, control), `SubagentManager`
(`subagent.py`) for spawning agent turns, an ACP layer (`acp/client.py` — the
protocol Kiro IDE already speaks), and an auth-exempt OpenAI-compat
`/v1/chat/completions`. A python-hook runs in-process with all of it.

### Bridge architecture (shipped in 0.6.0)

```
┌ IDE workbench (openvscode-server), served SAME-ORIGIN as the dashboard ─┐
│  editor / native file browser / diffs                                    │
│  KiroCrew extension (extension/, a WEB extension provisioned per start):  │
│    · Chat view (webview): one KiroCrew session per chat, agent picker,    │
│      live streaming, inline Approve/Reject cards                          │
│    · Sessions view: every session in the "KiroCrew IDE" dashboard folder  │
│      with running / waiting-for-approval / idle, live                     │
│    · Specs view: .kiro/specs/<name>/{requirements,design,tasks}.md,       │
│      phase commands, ▶ per task, run-all                                  │
│    · approvals as native notifications; status bar "N running / waiting"  │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ fetch(self.origin + "/api/…") + WebSocket /api/ws
                │ — the user's own dashboard session cookie, same Origin
┌ gateway ──────▼──────────────────────────────────────────────────────────┐
│  the dashboard's own API: POST /api/chat/slots (folder at birth),         │
│  POST /api/chat?ws=1, /api/ws frames chat_chunk·chat_message·chat_done,   │
│  POST …/approve, GET /api/agents, /api/chat/folders                       │
│  python-hook (this mod): engine supervisor, same-origin proxy,            │
│  extension provisioning (+ extensions.json registry), folder browse        │
└──────────────────────────────────────────────────────────────────────────┘
```

**The design pivot.** An earlier draft had a loopback bridge with a per-boot
token file and in-process calls into the host's session machinery. The
survey killed it: `api_chat` alone is ~300 lines of ownership, binding and
relay gates that a mod would have to re-implement to call the runner
directly, and every bypass of the dashboard credential is a second identity
to mint and protect. The same-origin proxy (0.4.0) made both unnecessary:
the workbench page IS a dashboard-origin document, so a *web* extension
(browser extension host) fetching `self.origin + "/api/…"` carries the
user's own session cookie and satisfies the dashboard's Origin check. The
IDE user is the dashboard user; there is nothing to broker. (The worker runs
on a `blob:` URL, so URLs must be prefixed with `self.origin` — a relative
`/api/...` fails to parse there.)

**Why a web extension.** Only the browser host shares the page origin; a
node extension host runs server-side with no cookie. Everything the bridge
needs is available in the web host: `vscode.workspace.fs` (real disk via the
remote file system), webviews, tree views, notifications, quick picks.
`capabilities.untrustedWorkspaces.supported: true` so the views appear before
the user answers the workspace-trust prompt.

**Provisioning.** `extension/` is copied on every engine start into
`<data>/extensions/<publisher>.<name>-<version>/` and handed to the engine
with `--extensions-dir`. Measured gotcha: the workbench loads only folders
listed in that dir's `extensions.json` and drops anything in `.obsolete`; the
first copy got registered by the scanner, every later version was "Marked
extension as removed". The hook therefore writes the registry entry itself
and clears its `.obsolete` verdict (`_register_extension`). The state file
records the provisioned version; an adopted engine running an older bridge
is relaunched (`_mode_mismatch`), like a proxy-mode mismatch.

Pain points → mechanisms:

- **Durable spec coding** — on a `tasks.md`, Run all tasks (the editor's
  → Continue, the ⏵⏵ on the spec) creates ONE KiroCrew session in the
  "KiroCrew IDE" folder with Autopilot on and runs every remaining required
  task back to back; ▶ Start task on a row runs that one task. The session
  lives in the gateway: laptop sleeps, ssh drops, browser closes — it keeps
  running; reopen it from the Sessions view, the dashboard or a phone. The
  tmux + kiro-cli workaround has no equivalent left to do.
- **Kiro's task grammar** — `extension.js` carries a port of @kiro/agent's
  tasks.md parser (states ` `/`~`/`-`/`x`, optional `*`, numbered hierarchy,
  details and sub-tasks, a task's id = its full text) and of its `<task>`
  serializer, so the IDE shows the tasks Kiro's orchestrator will run and the
  marks it writes back, and can hand it the same task block.
- **Visibility without polling** — the `slots` frame on `/api/ws` drives the
  Sessions view and status bar; `tasks.md` is watched, so the `[~]` / `[-]` /
  `[x]` marks appear as the agent makes them.
- **Approve from the editor** — a `chat_message` with role `permission`
  raises a notification (Approve / Reject / Open session) and an inline card
  in the chat; both POST `…/approve {action, request_id}`.
- **Spec agent** — with the kiro-spec-plan mod (KAS backend), the Spec /
  Quick Spec / Bug Fix / Plan agents are Kiro's own bundled modes, and a task
  run sends the request Kiro's IDE sends its engine ("Run all tasks for this
  spec." + resume suffix; "Execute the following task from the spec at …" +
  task block + Task ID + Spec path), which the engine's spec sub-intent router
  hands to its Task Orchestrator. Without it, the flow is carried by prompts
  (requirements → design → tasks with the Kiro artifact shapes, EARS
  criteria, checkbox plan; task prompts carrying the same `<task>` block) sent
  to whichever crew agent `kirocrew.specAgent` / `kirocrew.agent` names.
- **File browsing / diffs** — native workbench on the same folder the agent
  edits; changes show as ordinary git diffs.

Why this is still mod-territory: the same-origin proxy that makes the cookie
model work is a raw WebSocket-capable route on the dashboard app (hook seam),
the extension is provisioned by the engine supervisor the hook runs, and the
App is installed through the mod. App Kit reaches none of it (proof above).

## Roadmap

- **v0.1–0.5 (done)**: engine supervisor + control API; the App with folder
  picker and cover-KiroCrew overlay; same-origin proxy; engine auto-install;
  settings-only mod page.
- **v0.6 (done)**: the bridge extension — chat, sessions, approvals, specs.
- **v0.13–0.15 (done)**: the persistent layer (fullscreen / docked / hidden),
  host switcher and `[host]IDE]` tag stacks, several workspaces on one engine,
  origin-independent profile list.
- **next**: transcript deep links into editor tabs; ask-question cards;
  "Open in KiroCrew IDE" hooks on the host file browser; `electron:` popout.

## Naming caveat

`kirocrew-ide` trips the official registry's reserved-names gate
(`kirocrew` is a leading token → masquerade), by design. This mod is
publishable as **unlisted** (an install line pointing at its own repository) or kept
first-party in this repo; listing it on the registry would need a rename
(e.g. `crew-ide` also trips `crew`… `floofy-ide` trips `floofy` — something
like `foxide` / `den-ide` works) or a maintainer exception.
