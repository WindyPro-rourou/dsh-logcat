/**
 * dsh-logcat self-check: imports the host half, mounts it on a stub cordis
 * context, waits for the adb probe, and reports the engine status.
 *
 * Run: node selfcheck.mjs
 */
import { apply, name, inject } from './lib/index.js'

const routes = []
const upgrades = []
const tools = []
const sections = []

const ctx = {
  webServer: {
    register: (route) => { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } },
    registerUpgrade: (upgrade) => { upgrades.push(upgrade); return () => { const i = upgrades.indexOf(upgrade); if (i >= 0) upgrades.splice(i, 1) } },
  },
  tools: {
    register: (tool) => { tools.push(tool); return () => { const i = tools.indexOf(tool); if (i >= 0) tools.splice(i, 1) } },
  },
  systemPrompt: {
    section: (section) => { sections.push(section); return () => { const i = sections.indexOf(section); if (i >= 0) sections.splice(i, 1) } },
  },
  effect: (fn) => { const dispose = fn(); return dispose ?? (() => {}) },
}

console.log(`plugin name: ${name}, inject: ${JSON.stringify(inject)}`)
apply(ctx, {})
await new Promise((resolve) => setTimeout(resolve, 2500))

const status = ctx.logcat.status()
console.log('status:', JSON.stringify(status, null, 2))
console.log(`routes registered: ${routes.length} (${routes.map((r) => r.path).join(', ')})`)
console.log(`upgrade routes: ${upgrades.length} (${upgrades.map((u) => u.path).join(', ')})`)
console.log(`tools registered: ${tools.length} (${tools.map((t) => t.name).join(', ')})`)
console.log(`system-prompt sections: ${sections.length}`)

// Exercise a few tools (no device attached -> graceful empty results).
const EXERCISE = ['logcat_recent', 'logcat_history', 'logcat_events', 'crash_sessions', 'app_info', 'activity_current', 'input_keyevent', 'app_launch', 'app_stop', 'screen_capture']
for (const toolName of EXERCISE) {
  const tool = tools.find((t) => t.name === toolName)
  if (tool === undefined) { console.log(`MISSING TOOL: ${toolName}`); continue }
  const result = await tool.execute({ lines: 5, package: 'com.android.settings', key: 'home' })
  console.log(`${toolName} execute:`, JSON.stringify(result).slice(0, 200))
}

// Critical tool count check.
const EXPECTED = 30
if (tools.length !== EXPECTED) {
  console.log(`FAIL: expected ${EXPECTED} tools, got ${tools.length}`)
  process.exitCode = 1
}

if (status.ready) {
  console.log('SELFCHECK OK — adb found, engine polling')
} else {
  console.log('SELFCHECK PARTIAL — adb not found (plugin still mounts; panel will show "未找到 adb")')
}

// Tear down the engine so a live logcat stream does not keep the process alive.
ctx.logcat.engine.dispose()
console.log('engine disposed — exiting')
