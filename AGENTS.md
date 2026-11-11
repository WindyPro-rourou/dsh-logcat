# AGENTS.md — dsh-logcat

Instructions for any agent working in this repository. Keep this file in sync with the
release tooling; it must never contain secret values.

## Release & credentials

- Credentials come from the environment (portable DSH launcher injects them) or can be loaded
  on demand: `. "$env:DSH_HOME\env\load-secrets.ps1"`. **Never ask the user for tokens and never
  commit them.**
- The secrets file (`<portable>\data\portable-secrets.env`) is part of the portable tree and
  travels with it. Copy the **whole folder**, not just `data\dsh-home`; never hard-code a drive
  letter — the launcher and loader both resolve by their own location.
- Publish with the scripts — they auto-load credentials when the variables are absent:
  - `./publish-npm.ps1` → npmjs.org (`latest`, primary channel)
  - `./publish-github-packages.ps1` → GitHub Packages (mirror, `latest` only)
- GitHub is unreachable directly from this machine: use the local proxy
  (`git -c http.proxy=http://127.0.0.1:7890 push ...`, `curl -x http://127.0.0.1:7890 ...`).
- One GitHub Release + tag per stable version, always with the **full 40-char SHA** (short SHAs
  are rejected with 422). npm may report "being processed" for a few minutes after publish.
- Bump versions by editing `package.json` as text — PowerShell JSON writes add a BOM that breaks
  the client bundle loader.

## Verification gates (run before every publish)

```sh
node --check lib/index.js lib/client.js
node selfcheck.mjs          # 30 host tools registered
node tmp-bundle-smoke.mjs   # bundle evaluates with NO global React (host-faithful)
node tmp-rendertest.cjs     # drawer renders without a white screen
node tmp-native-test.cjs    # drawer is the default; native panel is opt-in
node tmp-issue2-smoke.mjs   # persistence bounds + injector backoff
node tmp-overlap.cjs        # no control overlaps across drawer widths
node tmp-encoding-audit.mjs .   # every shipped file is valid UTF-8
node tmp-normalize-meta.mjs # package.json/cordis.patch.yml stay ASCII-only
node tmp-stats-route.mjs    # /stats parses memory/battery/cpu on a real device
node tmp-selfheal.cjs       # empty device list recovers without a reload
node tmp-video-isolation.mjs    # screen bytes only reach subscribed panels
node tmp-video-e2e.mjs          # late subscriber still gets svideo-init (needs a device)
```

- `tmp-video-isolation.mjs` / `tmp-video-e2e.mjs` exist because 0.9.5 fixed a
  nasty coupling: H.264 frames (~1.75 MB/s) were broadcast to **every** panel, so a
  panel on the log tab still swallowed megabytes per second; once `bufferedAmount`
  passed the drop threshold in `broadcast()`, **log frames were dropped too** —
  mirroring and logs broke together. Screen bytes now go only to clients that sent
  `{type:"video"|"screen", on:true}` (`ws.__screenSubscribed`), and the last
  `svideo-init` is cached per device and replayed to late subscribers (a panel that
  joined mid-stream used to get frames but no decoder config => black screen).

- `tmp-stats-route.mjs` and `tmp-selfheal.cjs` exist because 0.9.4 fixed two
  user-visible bugs: `collectStats` never stripped the `:` separator (so memory,
  battery and CPU were always blank — `"status: 2".slice(6)` is `": 2"`), and a
  panel opened before the host/device was ready stayed on "无设备" forever because
  nothing re-sent the roster. `tmp-selfheal.cjs` reproduces that exact screen and
  proves the 3-second `/status` re-poll recovers it with no reload.

- `tmp-encoding-audit.mjs` + `tmp-normalize-meta.mjs` exist because issue #4 reported
  garbled text in the published metadata. Anything a UI may truncate by **bytes**
  (package description, bundle patch) must stay pure ASCII so a slice can never split a
  multibyte character; Chinese belongs in the README/docs, which are read as UTF-8.
- `tmp-overlap.cjs` exists because issue #3 was a layout defect that no screenshot-free
  review caught by eye: `input[type=text]` defaults to `content-box` while
  `input[type=search]` is `border-box`, so one control rendered 10px taller than its row.
  Form controls are now normalised to `border-box` with one shared 26px height.

- `tmp-bundle-smoke.mjs` exists because 0.9.1 shipped `React.memo` without binding
  `React`: the old harness loaded the React UMD build, which sets `window.React`, so the
  stray reference resolved in tests and only failed in the real host. **Never reintroduce a
  global `React`/`window.React` in a harness** — the host injects `react` through the module
  loader's `require` and exposes no global. Same rule for any other host-provided global.

## UI

- The **right-hand drawer is the default surface**; the native `main` + `sidebar.panellist`
  panel is opt-in via `window.__DSH_LOGCAT_NATIVE_PANEL__ = true`.
- Design language: host tokens first (`--dsw-*`), one accent colour, bundled SVG icons
  (no emoji), monospace + tabular-nums log rows, dense but calm chrome.
- Keep the drawer overlay-based: it must not push the conversation layout.
