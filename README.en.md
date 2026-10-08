# dsh-task-control

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.md)

<p align="center">
  <img src="fig/dsh-task-control-hero-v2.png" alt="dsh-task-control whale-girl hero illustration" width="720">
</p>

Adds task **pause, resume, and cancel** controls to DSH Web. Supports safe and force pause, then resumes from the pause point without repeating completed work.

Currently adapted to DSH v0.1.5-rc.2 and v0.2.0-rc.2 (the `@deepseek-ai/dsh` CLI is 0.1.5-rc.1 / 0.2.0-rc.2, the kernel packages 0.1.5-rc.2 / 0.2.0-rc.2).

## Installation

```bash
dsh plugin --profile web add github:p2coder/dsh-task-control
```

After installation, **fully restart dsh web**, then refresh the browser.

## Quick start

Three persistent buttons appear beside the input box while a task is running:

| Button | Action | Available when |
|---|---|---|
| ⏸ Pause | Pause using the configured default | Running |
| ▶ Resume | Continue from the pause point | Paused |
| ⏹ Cancel | Stop the current turn immediately | Running or paused |

Gray buttons are unavailable; dark buttons are clickable.

![Location and states of the Pause, Resume, and Cancel buttons](fig/button%20illustrate_en.png)

## Pause modes

| Mode | Behavior | Best for |
|---|---|---|
| `safe wait` (default) | Waits for reasoning and tools to finish naturally | Long tasks, migrations, tests |
| `safe stop` | Waits for tools, but may interrupt current reasoning | Faster pauses |
| `force` | Immediately interrupts reasoning and in-flight tools | Emergencies |

Change the default under Settings → Task control. Saving applies it immediately:

![Steps for configuring task pause granularity](fig/Task%20pause%20granularity%20configuration_en.png)

## Commands

| Command | Description |
|---|---|
| `/pause` | Pause using the configured default |
| `/pause force` | Force pause |
| `/pause safe wait` | Safe pause without interrupting reasoning |
| `/pause safe stop` | Safe pause that may interrupt reasoning |
| `/resume` | Resume the task |
| `/resume confirm rerun` | Re-run an interrupted or deferred tool, then resume |
| `/resume confirm skip` | Skip that tool, then resume |
| `/cancel` | Cancel the current turn |

![Using task controls with a slash command](fig/commond%20illustrate_en.png)

## Plugin API

Get the service with `ctx.get("taskControl")`:

| API | Action |
|---|---|
| `pause(sessionId, options?)` | Pause a task |
| `resume(sessionId, options?)` | Resume a task |
| `cancel(sessionId)` | Cancel a task |
| `state(sessionId)` | Read `idle`, `running`, or `offline` status and pause details |

Pause state is stored under `~/.dsh/task-control/` and survives restarts. Tests can override the directory with `DSH_TASK_CONTROL_STATE_DIR`.

## Notes

| Situation | Behavior |
|---|---|
| Force pause | A tool may have partial side effects; choose re-run, skip, or stay paused before resuming |
| Deferred tools under `safe wait` | Resume requires choosing re-run or skip |
| New messages while paused | Start a new turn; pause controls only the current turn |
| Scheduled reminders | Due `dsh-schedule` reminders still wake the session |
| Subagents | Already-dispatched subagents are not interrupted with the parent |
| State sync | The browser polls every 2 seconds while running or paused (no polling when idle and unpaused; polling pauses while the tab is hidden); restart dsh web after plugin changes |

## Test

```bash
node test/run.mjs
```

This repo does **not** vendor the `@deepseek-ai/*` packages (the DSH host provides them at runtime), so the runner first locates an installed profile and then runs each suite in a child process with an ESM resolve hook that redirects `@deepseek-ai/*` there:

| Variable | Effect |
|---|---|
| `DSH_PROFILE_MODULES` | Point at a `profiles/node_modules` directory directly; otherwise the runner probes `$DSH_HOME/profiles/*/node_modules`, `$DSH_HOME/profiles/node_modules`, then the repo's own `node_modules` |

| Suite | Coverage |
|---|---|
| `test/host-smoke.mjs` | Commands, service, routes, durable state, pause-granularity settings (against a contract-faithful session double) |
| `test/host-real-session.mjs` | `/pause` and `/resume confirm rerun\|skip` against a **real kernel `Session`**, guarding the log-reading API against another drift |

> Both suites point `DSH_TASK_CONTROL_STATE_DIR` at a temp directory and never write your `~/.dsh/task-control/`.

## Local development deployment

`dsh plugin` forwards its arguments to pnpm inside the profile directory, then reconciles `dsh.profile.bundles` from the **installed state**: any dependency declaring `dsh.bundle.patch` joins the layer stack. So neither `cordis.patch.yml` nor the profile's `package.json` has to be edited by hand.

```bash
# 1) Back up (pnpm rewrites the profile's package.json / pnpm-lock.yaml)
cd ~/.dsh/profiles/web
cp package.json package.json.bak && cp pnpm-lock.yaml pnpm-lock.yaml.bak

# 2) Install this branch (file: stays local, no push needed)
dsh plugin --profile web add file:/path/to/dsh-task-control
#    or from a remote branch:
dsh plugin --profile web add github:<owner>/dsh-task-control#<branch>

# 3) Self-check (both should mention dsh-task-control)
node -e "const p=require(process.env.HOME+'/.dsh/profiles/web/package.json');console.log(p.dependencies['dsh-task-control'],p.dsh.profile.bundles)"
dsh --profile web --dump-config | grep -A2 dsh-task-control

# 4) Restart dsh web (open the URL it prints, then refresh the browser)
```

`--profile web` must precede `add`; after it, the flag is forwarded to pnpm and fails with `required option '--profile <name>' not specified`.

Field notes:

- **`file:` copies, it does not symlink.** `node_modules/dsh-task-control/` is a real directory, so after every change under `lib/` you must repeat step 2 and restart. For a tight loop use a `github:` spec, or symlink that directory to your working copy yourself.
- **The plugin does not resolve through the profile's own `node_modules`.** The kernel packages live one level up in the flat store (`~/.dsh/profiles/node_modules`), which Node reaches by walking up from `profiles/web/node_modules/dsh-task-control/lib/`. That is why pnpm's `missing peer @deepseek-ai/...` / `react` warnings are this machine's usual noise and do not affect runtime.
- **Installing writes the profile directory.** `dsh web` also rewrites `~/.dsh/profiles/web/cordis.yml` (the composed tree) at startup; if that directory is not writable, `dsh web` / `--dump-config` fail outright with `EACCES`.
- **A restart of `dsh web` is mandatory.** The host composes and loads the profile once at startup and does not hot-reload plugins; refreshing the browser alone is not enough, because only a host restart re-serves `client.js`.

## Rollback

```bash
cd ~/.dsh/profiles/web
cp package.json.bak package.json && cp pnpm-lock.yaml.bak pnpm-lock.yaml
rm -rf node_modules/dsh-task-control
dsh plugin --profile web install     # reconcile dependencies from the restored manifest
# then restart dsh web
```

To keep the install but disable it, set `disabled: true` on the `task-control` row in the profile's `cordis.patch.yml`, or run `dsh plugin --profile web remove dsh-task-control`.

---

## Known issues and limitations

| Item | Detail | Status |
|---|---|---|
| **Kernel API drift** (`Session.events` removed) | DSH ≤ 0.1.1-rc.2 published a public `events` getter on `Session`; 0.1.5-rc.2 replaced it with `snapshotEvents()` / `ownEvents()` / `eventAt(seq)`. The plugin read `agent.session.events` in two places, so on the newer kernel that value was `undefined` and **every `/pause` (including the composer pause button) and `/resume` threw `TypeError`**. Because the throw happened before `clearPaused()`, the durable state stayed `paused: true` — the dock kept re-offering the resume menu on every poll while every click failed. | Fixed: all reads go through one `sessionEvents()` helper (prefers `ownEvents()`, falls back to `snapshotEvents()` then the legacy `events`), with `test/host-real-session.mjs` as the regression guard |
| **Plugin routes bypass Web authentication** | The plugin's own `/task-control/*` routes, registered through `ctx.webServer.register({kind:'prefix'})`, sit outside the DSH auth gate (which only wraps the index and `/api`). Measured without a cookie: `/`, `/index.html`, `/api/session/list` all return 401, while `/task-control/settings` returns 200. Any local process can therefore read and write the pause-granularity settings and query `paused` / `forced` / `interruptedTool` / `resumeContent` for an arbitrary session id — and `resumeContent` holds **the last user prompt's content**. | Open (existing behavior). Low risk on a trusted single machine; if the port is ever exposed to a LAN or container, validate the request cookie/authority or move the state channel onto the `/api` remote face |
| **`dsh.client.inject` listed an unresolvable package** | It named `@deepseek-ai/dsh-client-runtime`, which the client half never imports and which is not a loadable client plugin package in 0.1.5. In 0.1.5 `inject` is informational metadata for preflight/HMR display (the real module edges come from `dsh.client.external` plus the shell's static table), so it never broke loading — but it was misleading. | Removed |
| **`peerDependencies` gated nothing** | The ranges were `^0.1.0-rc.6`, which per semver allows `0.1.0-*` prereleases only and **cannot match `0.1.5-rc.2`**. Since `dsh plugin add` only forwards to pnpm and performs no host-version check, no version gate existed at all. | Tightened to `^0.1.5-rc.2`, and the kernel packages the plugin actually imports are now declared |
| **0.2.0 added a host-version gate, which silently skipped the whole plugin** | 0.2.0 introduced `dsh-app-boot`'s `evaluatePluginCompatibility()`: at profile load it reads `package.json` `peerDependencies`, keeps only the `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` entries, and requires `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`. A mismatch `throw`s, and `loadProfileDirectory()` catches that into `skippedBundles` — so the bundle is **skipped, not crashed**. Every dsh peer here was pinned to `^0.1.5-rc.2`, and for a `0.x` version a caret pins the minor line (`>=0.1.5-rc.2 <0.2.0`), so **0.2.0-rc.2 fell outside it** and the entire plugin (`/pause`, `/resume`, `/cancel`, the composer controls, the settings page) never loaded on 0.2.0. | Fixed: every `@deepseek-ai/dsh*` peer is now `^0.1.5-rc.2 \|\| ^0.2.0-rc.2` (covers both lines without admitting 0.3.x). `test/plugin-compatibility.mjs` calls the **kernel's own** `evaluatePluginCompatibility()` to assert both lines, and re-runs it against the pre-fix range to prove the assertion has teeth. Note the gate runs at profile load, so **restart dsh web** after updating to remount the plugin |
| **0.2.0 reshaped the session events (silent mis-read risk)** | The `tool/result` payload changed from "a `tool-result` CONTENT BLOCK nested in `message.content` (carrying `isError`/`content`)" to "`message` IS the `ToolResultMessage` (`toolCallId` / `source.callId` / `isError` on the message, and no `tool-result` block type at all)". `user/message` data is now the `UserMessage` itself, and `assistant/message` carries an `AssistantMessage`. The old reader does not throw — it **reads a failed/interrupted tool as "already completed"** and skips re-running it, which is worse than throwing. | Fixed: `findToolOutcome()` / `handleSessionToolEvent()` recognise both shapes. `test/host-real-session.mjs` now builds events with the **kernel's own constructors** (`createToolResultMessage()` / `createAssistantMessage()` / `createUserMessage()`) and adds assertions such as "a failed result is never mistaken for a completed one" and "`safe wait` records undispatched tools from the assistant message" — that file previously appended 0.1.5-shaped events, which still passed on 0.2.0 and therefore covered nothing |
| **0.2.0 rebuilt the icon set from `*16` weights to `Regular`/`Medium`** | `@deepseek-ai/dsh-client-ui-primitives` no longer exports `IconPauseOutline16` / `IconPlayOutline16` / `IconStopFill16`; the names now carry a `Regular`/`Medium` weight suffix. `TaskControlDock` rendered `<IconPauseOutline16/>` etc., which destructure to `undefined` on 0.2.0, so React threw Minified React error #130 ("Element type is invalid ... got: undefined") and the slot machinery abdicated the entry — the composer row silently swept the dock under the rug, which is why the first restart brought no buttons back. | Fixed: switched to `IconPauseOutlineRegular` / `IconPlayOutlineRegular` / `IconStopFillRegular` (commit ed9f31d); the deploy was verified end-to-end by mounting the real page in a headless Chromium drive (`test/browse-check.py`) plus the user's visual confirmation |
| **The repo's `node_modules` was a broken symlink** | It pointed at another machine's `/Users/wx/.dsh/profiles/node_modules`, so `node test/host-smoke.mjs` failed with `ERR_MODULE_NOT_FOUND`. | Removed; resolution now happens in `test/run.mjs` (see Test) |
| **A `file:` install does not track edits** | See Local development deployment. | By design; reinstall |
| **Browser-half regression** | The host half and the browser mounts (`conversation.input.right` / `settings.section`) were verified against the installed 0.2.0-rc.2 deployment: a headless-Chromium drive of the real page confirmed the bundle is served and listed in `window.__DSH_BOOT__` and captured the slot-crash evidence that led to the icon fix, and the restarted UI shows the dock. `test/browse-check.py <url-with-token>` repeats the check (note the web token rotates on every dsh restart). | Closed for 0.2.0-rc.2 |
