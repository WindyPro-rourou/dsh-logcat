# dsh-logcat

An Android real-device debugging workbench for the DSH Web GUI (an Android Studio-style Logcat view).

[中文](README.md) | **English**

## Features

- **Auto-connect**: probes adb on this machine (`ANDROID_HOME` / `ANDROID_SDK_ROOT` / default `%LOCALAPPDATA%\Android\Sdk` / PATH /
  `~/.dsh/adb`), polls `adb devices -l` every 2s; devices in debug mode get a logcat stream **attached automatically** (`-v threadtime`) — no need to open the panel first.
- **One-click adb install**: when adb is missing, the panel's status bar shows a "One-click install adb" button — it downloads platform-tools from the USTC mirror (Google official fallback), unpacks them to `~/.dsh/adb` and connects automatically (~10MB).
- **Live logs**: WebSocket push, 2000-line ring buffer per device; automatic reconnect with exponential backoff.
- **Logcat panel** (sidebar "Logcat" entry, right-side drawer, **draggable width that is remembered**):
  - Device dropdown (model / serial / state, remembers the last selection)
  - Severity filter (V/D/I/W/E/F single-select, Android Studio colors)
  - Keyword filter (**space-separated keywords = any-match**) and a **test package input** (Enter to set; synced with the agent's `logcat_set_package`; shown live in the status bar)
  - **Screenshot button**: one-click device screen capture and PNG download (`exec-out screencap`)
  - **Crash highlighting**: FATAL EXCEPTION / ANR lines highlighted in red
  - **History button**: loads on-disk persisted logs (survives GUI restarts; merged with the live buffer and deduped by timestamp)
  - **Crash auto-snapshots**: on a FATAL EXCEPTION / ANR in the stream, a screenshot + log context are saved to `~/.dsh/logcat/crashes`; the panel shows a banner and you can inspect the screenshot/log in the "Crash" dialog
  - **Events view**: one-click live `logcat -b events` stream (app start/crash/lifecycle events)
  - **WiFi wireless debugging wizard**: IP/port/pairing-code in, `adb pair` + `adb connect` out — ditch the cable (Android 11+)
  - **Install APK button**: local file picker installs an APK to the current device (streamed upload, 1GB cap)
  - **Quick device keys**: Home / Back / Recents / Wake / Power / Volume ± with one click
  - **Performance sparklines**: CPU / memory / battery sampled every 2s with trend charts in the status bar
  - **Live screen casting + remote control**: the "Screen" tab streams the device display (~1fps over WS binary frames); **click = tap, drag = swipe**, a text input sends keystrokes straight to the phone, quick keys included, one-click download of the current frame — no need to pick up the phone
  - **Reverse-engineering workbench** (Log / Screen / RE tabs): process list → memory hex/string search → match addresses → click to dump 256B
  - Pause/resume (pause buffers new lines, resume replays them), clear, copy, export .txt
  - Windowed rendering + auto-scroll (pauses while you scroll up manually)
  - Unauthorized-device hint ("allow USB debugging on the phone")
- **Agent tools** (30 in total, all exposed to the agent and announced in its system prompt):
  - Device: `logcat_devices` (list devices), `device_info` (model/version/SDK/resolution/memory/battery), `device_stats` (CPU/memory/battery samples), `app_info` (installed version name / versionCode / APK path)
  - Screen / multimodal: `screen_capture` (screenshot saved locally + embedded as an image block so a multimodal model can see it and fix bugs with `input_*`)
  - Execution: `adb_exec` (shell), `adb_install` (install a local APK), `adb_pull` (pull files), `app_launch` (start an app / specific Activity), `app_stop` (force-stop; destructive — confirm first)
  - Input: `input_tap` / `input_swipe` / `input_text` / `input_keyevent` (real-device UI automation), `ui_dump` (UI hierarchy XML), `activity_current` (current foreground Activity)
  - Logs: `logcat_recent` (filter by package/severity/keyword), `logcat_history` (disk history backfill), `logcat_crash` (crash/ANR blocks with context), `logcat_events` (events buffer), `crash_sessions` (crash snapshot history), `logcat_set_package` (lock the package under test)
  - Reverse engineering / memory: `proc_list` (process list), `proc_maps` (memory maps + module bases), `proc_status` (process state / memory summary), `proc_smaps` (top Pss regions), `mem_dump` (read memory at an address as hex), `mem_search` (search memory for hex/string patterns), `frida_server` (deploy/start/stop frida-server), `frida_script` (generate hook/trace/scan/bypass/dump script templates)
- **Real-device debugging workflow**: while building an Android app, the agent's announcement dynamically lists connected devices (serial + model) and the current test package. After confirming with the user: `adb_install` to deploy → `adb_exec`/`app_launch` to start → `logcat_set_package` to lock → `logcat_recent` / `logcat_crash` for crashes → `ui_dump` + `input_*` for UI automation → `adb_pull` for artifacts. A closed loop on real hardware.
- **Reverse-engineering workflow**: `proc_list` to find the process → `proc_maps` for module bases → `mem_dump` at a target address / `mem_search` for signatures → `proc_smaps` for memory detail → `frida_script` + `frida_server` for dynamic instrumentation. Reading another app's memory/maps needs root or a debuggable app (run-as); tools return clear errors otherwise.
- **Extra routes**: `POST /api/dsh-logcat/exec` (shell), `POST /api/dsh-logcat/package` (set package), `GET /api/dsh-logcat/screenshot`, `POST /api/dsh-logcat/install-adb`, `GET /api/dsh-logcat/history`, `GET /api/dsh-logcat/crashes` + `GET /api/dsh-logcat/crash-file`, `POST /api/dsh-logcat/install-apk`, `POST /api/dsh-logcat/keyevent`, `POST /api/dsh-logcat/wifi-connect` / `wifi-disconnect`, `GET /api/dsh-logcat/processes`, `POST /api/dsh-logcat/mem-search`, `GET /api/dsh-logcat/mem-dump`.
- **On-disk data**: logs are written per device per day to `~/.dsh/logcat/logs/<serial>/logcat-MM-DD.log` (raw threadtime lines); crash snapshots live in `~/.dsh/logcat/crashes/<serial>/<timestamp>-<FATAL|ANR>/` (`screenshot.png` + `crash.log` + `meta.json`).

## Installation

```bash
# Recommended (npm install):
dsh plugin --profile web add @windypro-rourou/dsh-logcat

# Update to the latest (no auto-update; older installs show a version hint in the panel/agent prompt):
dsh plugin --profile web update                # latest within the current major
# or force: dsh plugin --profile web add @windypro-rourou/dsh-logcat@latest
# restart the GUI (dsh web) afterwards

# Optional preview channel (frequent small iterations, may be unstable):
dsh plugin --profile web add @windypro-rourou/dsh-logcat@preview
```

## Release policy (main / latest first)

- **`main` branch + npm `latest` tag**: stable releases — the main update channel. Features ship to main/latest as soon as a batch is ready.
- **`preview` branch + npm `preview` tag**: optional early-access channel (frequent small iterations). If there are no experimental features since the last stable release, the preview tag simply stays at an older preview version — ignore it.
- The version self-check notifies per channel only (stable users see `latest`, preview users see `preview`; no cross-talk).

For development you can also link the source directly into the web profile and append the patch row in `~/.dsh/profiles/web/cordis.patch.yml`:

```bash
pnpm --dir "%USERPROFILE%\.dsh\profiles\web" add link:<this-directory>
# then add to ~/.dsh/profiles/web/cordis.patch.yml:
#   - insert:
#       - id: logcat
#         name: '@windypro-rourou/dsh-logcat'
# The patch file is hot-watched by a running GUI; restart it if it does not take effect.
```

> Note: every method inserts the same `logcat` row into the profile tree — never use two of them at once, or the next boot fails on a duplicate plugin id.

Dependency resolution: `ws` / `react` / `react-dom` / `@deepseek-ai/*` resolve through junctions in this directory's `node_modules` pointing at the host's actually-loaded packages (single instance). Re-point the junctions when the host upgrades its dependencies.

## Limitations

- The device must have USB debugging enabled and be authorized on this machine (`unauthorized` state is surfaced).
- logcat output may contain sensitive information; `/api/dsh-logcat/*` routes are loopback-only.
- `adb shell` commands consume real device resources — confirm before running destructive ones.

## Files

- `lib/index.js` — host half: adb engine, polling, logcat child processes, routes, WebSocket, agent tools.
- `lib/client.js` — browser half: sidebar entry + Logcat panel (React, no build step).
- `cordis.patch.yml` — profile bundle patch (applied automatically).
