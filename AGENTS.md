# AGENTS.md — dsh-logcat

Instructions for any agent working in this repository. Keep this file in sync with the
release tooling; it must never contain secret values.

## Release & credentials

- Credentials come from the environment (portable DSH launcher injects them) or can be loaded
  on demand: `. "$env:DSH_HOME\env\load-secrets.ps1"`. **Never ask the user for tokens and never
  commit them.**
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
node tmp-rendertest.cjs     # drawer renders without a white screen
node tmp-native-test.cjs    # drawer is the default; native panel is opt-in
```

## UI

- The **right-hand drawer is the default surface**; the native `main` + `sidebar.panellist`
  panel is opt-in via `window.__DSH_LOGCAT_NATIVE_PANEL__ = true`.
- Design language: host tokens first (`--dsw-*`), one accent colour, bundled SVG icons
  (no emoji), monospace + tabular-nums log rows, dense but calm chrome.
- Keep the drawer overlay-based: it must not push the conversation layout.
