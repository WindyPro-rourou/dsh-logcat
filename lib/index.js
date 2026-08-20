/**
 * dsh-logcat — host half.
 *
 * Mounts an adb-backed Android Logcat engine:
 *   - probes the adb binary (ANDROID_HOME / SDK defaults / PATH),
 *   - keeps `adb devices` under a 2s poll and AUTO-ATTACHES a `logcat -v
 *     threadtime` stream to every device in debug mode (no GUI needed),
 *   - keeps a per-device ring buffer (2000 lines) and broadcasts new lines
 *     over a WebSocket to every subscribed browser panel,
 *   - exposes /api/dsh-logcat/{status,exec} routes plus the stream upgrade,
 *   - registers the logcat_recent agent tool and a system-prompt section.
 *
 * The browser half (./client) renders the Logcat panel in the web GUI.
 * Everything rides official NPM SDK packages — no dsh source changes.
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { WebSocket, WebSocketServer } from 'ws'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable cordis plugin name. */
export const name = 'logcat'

/** Services required before the logcat surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Services this plugin provides on ctx (ctx.logcat). */
export const provide = ['logcat']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 152

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const LOGCAT_GUIDANCE =
  '本机已安装 dsh-logcat 插件（DSH Web GUI 的安卓实机调试面板）：侧边栏「Logcat」入口；自动探测本机 adb，对已连接的调试设备自动附加 logcat 流（threadtime，每设备 2000 行环形缓冲）；Web 面板支持设备切换、级别/关键词过滤、暂停/清空/导出；agent 工具：logcat_devices（列出已连接设备）、adb_exec（在设备上执行 adb shell：安装/启动/查看日志/截图等）、logcat_recent（读取最近日志）。构建安卓应用时若检测到已连接设备，可先向用户确认后用 adb_exec / logcat_recent 直接实机调试。限制：需设备开启 USB 调试并授权本机；logcat 输出可能含敏感信息；adb 命令消耗真实设备资源，破坏性操作（卸载/重启/清数据）先确认再执行。用户提到「Logcat / 安卓日志 / 实机调试 / adb 日志」时即指本插件，请据此协作。'

/** Dynamic model-facing announcement: base guidance plus currently attached devices. */
function logcatGuidance(engine) {
  return () => {
    const devices = engine.deviceList()
    const live = devices.filter((d) => d.state === 'device')
    const deviceLine = live.length > 0
      ? `当前已连接安卓设备：${live.map((d) => `${d.serial}${d.model !== '' ? `（${d.model}）` : ''}`).join('、')}（已授权，可实机调试：安装 APK / 启动应用 / logcat / 截图等）。`
      : '当前无已连接的安卓设备（插上设备并开启 USB 调试后会自动识别）。'
    const pkgLine = engine.currentPackage !== ''
      ? `当前测试应用包名：${engine.currentPackage}（logcat_recent 默认按它过滤日志）。`
      : ''
    return `${LOGCAT_GUIDANCE}\n${deviceLine}${pkgLine !== '' ? `\n${pkgLine}` : ''}`
  }
}

/** ---------------------------------------------------------------- adb */

/** Candidate adb.exe locations, in probe order. */
function adbCandidates() {
  const list = []
  const envs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  for (const root of envs) {
    if (root) list.push(join(root, 'platform-tools', 'adb.exe'), join(root, 'platform-tools', 'adb'))
  }
  const sdk = join(homedir(), 'AppData', 'Local', 'Android', 'Sdk')
  list.push(join(sdk, 'platform-tools', 'adb.exe'))
  list.push(join(sdk, 'platform-tools', 'adb'))
  return list
}

/** Run one short adb command, returning stdout (or null on failure). */
function runAdb(adb, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(adb, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) resolve(null)
        else resolve(String(stdout))
      })
    } catch {
      // spawn itself threw (EPERM/EACCES/ENOENT at spawn time) — degrade, never crash.
      resolve(null)
    }
  })
}

/** Run one adb command and return { ok, code, stdout, stderr }. */
function runAdbFull(adb, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      execFile(adb, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null
          const timedOut = error.killed === true || error.signal === 'SIGTERM'
          resolve({ ok: false, code, timedOut, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        } else {
          resolve({ ok: true, code: 0, timedOut: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        }
      })
    } catch {
      resolve({ ok: false, code: null, timedOut: false, stdout: '', stderr: '' })
    }
  })
}

/** Run one adb command that emits binary (e.g. exec-out screencap), returning a Buffer. */
function runAdbBinary(adb, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    try {
      execFile(adb, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    } catch (error) {
      reject(error)
    }
  })
}

/** threadtime line: "08-18 14:23:45.678  1234  5678 I Tag    : message" */
const THREADTIME_RE = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*?)\s*:\s?(.*)$/

/** Parse one logcat line into an entry (null when not parseable). */
function parseLogcatLine(raw) {
  const match = THREADTIME_RE.exec(raw)
  if (match === null) return null
  return {
    ts: match[1],
    pid: Number.parseInt(match[2], 10),
    tid: Number.parseInt(match[3], 10),
    level: match[4],
    tag: match[5].trim(),
    msg: match[6],
    raw,
    cont: false,
  }
}

/** Parse `adb devices -l` output into serial -> { state, model } map. */
function parseDevices(output) {
  const devices = new Map()
  const lines = String(output ?? '').split(/\r?\n/)
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length < 2 || parts[0] === 'List' || parts[0] === '*') continue
    const serial = parts[0]
    const state = parts[1]
    let model = ''
    for (const field of parts.slice(2)) {
      if (field.startsWith('model:')) model = field.slice('model:'.length)
    }
    devices.set(serial, { serial, state, model })
  }
  return devices
}

/** ------------------------------------------------------------ engine */

/** One attached logcat stream (per device). */
class DeviceStream {
  constructor(adb, serial, onLine, onExit) {
    this.adb = adb
    this.serial = serial
    this.onLine = onLine
    this.onExit = onExit
    this.child = null
    this.restartTimer = null
    this.stopped = false
    this.starts = 0
  }

  start() {
    if (this.stopped || this.child !== null) return
    this.starts += 1
    let child
    try {
      child = spawn(this.adb, ['-s', this.serial, 'logcat', '-v', 'threadtime'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      // spawn threw synchronously (e.g. adb binary vanished / blocked) — back off and retry.
      if (!this.stopped) this.restartTimer = setTimeout(() => this.start(), 5000)
      return
    }
    this.child = child
    child.stderr.on('data', () => { /* adb warnings ignored */ })
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.onLine(String(line))
    })
    child.on('exit', (code) => {
      this.child = null
      if (this.stopped) return
      // Auto-restart with backoff (adb occasionally drops the stream).
      this.restartTimer = setTimeout(() => this.start(), 2500)
      this.onExit(code)
    })
    child.on('error', () => {
      this.child = null
      if (this.stopped) return
      this.restartTimer = setTimeout(() => this.start(), 5000)
    })
  }

  stop() {
    this.stopped = true
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (this.child !== null) {
      try { this.child.kill() } catch { /* gone */ }
      this.child = null
    }
  }
}

/** The adb engine: device poll, per-device ring buffers, ws fan-out. */
class AdbEngine {
  constructor() {
    this.adb = null
    this.adbVersion = null
    this.devices = new Map()      // serial -> { serial, state, model }
    this.buffers = new Map()      // serial -> ring buffer array
    this.streams = new Map()      // serial -> DeviceStream
    this.clients = new Set()      // WebSocket panels
    this.timer = null
    this.polling = false
    this.BUFFER_CAP = 2000
    this.currentPackage = ''   // app package currently under test (agent-set)
  }

  /** Probe and warm the adb server. Returns true when usable. */
  async init() {
    for (const candidate of adbCandidates()) {
      if (!existsSync(candidate)) continue
      const version = await runAdb(candidate, ['version'])
      if (version !== null && version.includes('Android Debug Bridge')) {
        this.adb = candidate
        this.adbVersion = version.split(/\r?\n/)[0] ?? ''
        break
      }
    }
    if (this.adb === null) {
      // Last resort: adb on PATH.
      const version = await runAdb('adb', ['version'])
      if (version !== null && version.includes('Android Debug Bridge')) {
        this.adb = 'adb'
        this.adbVersion = version.split(/\r?\n/)[0] ?? ''
      }
    }
    if (this.adb === null) return false
    await runAdb(this.adb, ['start-server'], 15000)
    return true
  }

  startPolling() {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.poll() }, 2000)
    void this.poll()
  }

  stopPolling() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const stream of this.streams.values()) stream.stop()
    this.streams.clear()
  }

  dispose() {
    this.stopPolling()
    for (const ws of this.clients) {
      try { ws.close(1001, 'plugin disposed') } catch { /* closed */ }
    }
    this.clients.clear()
  }

  async poll() {
    if (this.polling) return
    this.polling = true
    try {
      const output = await runAdb(this.adb, ['devices', '-l'], 8000)
      if (output === null) return
      const next = parseDevices(output)
      const changed = this.syncDevices(next)
      if (changed) this.broadcast({ type: 'devices', devices: this.deviceList() })
    } finally {
      this.polling = false
    }
  }

  /** Sync device map with a fresh poll; attach/detach streams. Returns true when the list changed. */
  syncDevices(next) {
    let changed = false
    // Detach disappeared devices.
    for (const serial of [...this.devices.keys()]) {
      if (!next.has(serial)) {
        this.devices.delete(serial)
        this.buffers.delete(serial)
        const stream = this.streams.get(serial)
        if (stream !== undefined) {
          stream.stop()
          this.streams.delete(serial)
        }
        changed = true
      }
    }
    // Attach new devices / update state.
    for (const [serial, info] of next) {
      const prev = this.devices.get(serial)
      if (prev === undefined || prev.state !== info.state || prev.model !== info.model) changed = true
      this.devices.set(serial, info)
      if (info.state === 'device' && !this.streams.has(serial)) {
        const stream = new DeviceStream(
          this.adb,
          serial,
          (line) => this.pushLine(serial, line),
          () => { /* restart handled inside the stream */ },
        )
        this.streams.set(serial, stream)
        stream.start()
      } else if (info.state !== 'device' && this.streams.has(serial)) {
        const stream = this.streams.get(serial)
        stream.stop()
        this.streams.delete(serial)
        this.broadcast({ type: 'device-state', serial, state: info.state })
      }
    }
    return changed
  }

  /** Push one raw line into the device ring buffer and fan out. */
  pushLine(serial, raw) {
    const entry = parseLogcatLine(raw) ?? { ts: '', pid: 0, tid: 0, level: '', tag: '', msg: raw, raw, cont: true }
    let buffer = this.buffers.get(serial)
    if (buffer === undefined) {
      buffer = []
      this.buffers.set(serial, buffer)
    }
    buffer.push(entry)
    if (buffer.length > this.BUFFER_CAP) buffer.splice(0, buffer.length - this.BUFFER_CAP)
    this.broadcast({ type: 'line', serial, entry })
  }

  /** Snapshot of the device list (for routes and the browser). */
  deviceList() {
    return [...this.devices.values()]
  }

  /** Recent buffered entries of a device, newest-last. */
  recent(serial, lines = 200, level = '', filter = '') {
    const buffer = this.buffers.get(serial) ?? []
    const needle = filter.trim().toLowerCase()
    const picked = buffer.filter((entry) => {
      if (level !== '' && entry.level !== '' && entry.level !== level) return false
      if (needle === '') return true
      return entry.raw.toLowerCase().includes(needle)
    })
    return picked.slice(-lines)
  }

  /** Map a package name to its running pids on a device ([] when not running). */
  async pidsOfPackage(serial, packageName) {
    if (this.adb === null || packageName === '') return []
    const output = await runAdb(this.adb, ['-s', serial, 'shell', 'pidof', packageName], 8000)
    if (output === null) return []
    return output.split(/\s+/).map((s) => Number.parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0)
  }

  /** Broadcast one frame to every open panel socket. */
  broadcast(frame) {
    const payload = JSON.stringify(frame)
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (ws.bufferedAmount > 1024 * 1024) continue // slow client: drop rather than stall
      try { ws.send(payload) } catch { /* closed */ }
    }
  }
}

/** -------------------------------------------------------------- routes */

const API_BASE = '/api/dsh-logcat'

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const host = req.headers?.host ?? ''
  const okAddress = address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.') || address.startsWith('127.')
  if (!okAddress) return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (hostUrl.hostname !== 'localhost' && !hostUrl.hostname.startsWith('127.')) return false
  return true
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** The one WebSocket server for logcat fan-out. */
const streamWss = new WebSocketServer({ noServer: true })

/** Build every /api/dsh-logcat route plus the stream upgrade. */
function makeRoutes(engine) {
  const routes = [
    {
      kind: 'exact',
      path: API_BASE + '/status',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        writeJson(res, 200, {
          adbPath: engine.adb,
          adbVersion: engine.adbVersion,
          ready: engine.adb !== null,
          devices: engine.deviceList(),
          streaming: [...engine.streams.keys()],
        })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/exec',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 64 * 1024) { writeJson(res, 413, { error: 'body too large' }); return }
          chunks.push(chunk)
        }
        let body = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* fallthrough */ }
        const serial = typeof body.serial === 'string' ? body.serial : ''
        const command = typeof body.command === 'string' ? body.command : ''
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        if (serial === '' || command === '') { writeJson(res, 400, { error: 'serial and command are required' }); return }
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 15000
        try {
          const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', command], timeoutMs)
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/package',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const chunks = []
        for await (const chunk of req) {
          if (chunks.length + chunk.length > 64 * 1024) { writeJson(res, 413, { error: 'body too large' }); return }
          chunks.push(chunk)
        }
        let body = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* fallthrough */ }
        const pkg = typeof body.package === 'string' ? body.package.trim() : ''
        engine.currentPackage = pkg
        engine.broadcast({ type: 'package', package: pkg })
        writeJson(res, 200, { package: pkg })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/screenshot',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET' && (req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const requested = url.searchParams.get('serial') ?? ''
        const serial = requested !== '' && engine.devices.has(requested)
          ? requested
          : [...engine.devices.keys()][0] ?? ''
        if (serial === '') { writeJson(res, 400, { error: 'no device attached' }); return }
        try {
          const png = await runAdbBinary(engine.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], 20000)
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'no-store',
            'content-length': png.length,
            'content-disposition': `inline; filename="logcat-${serial}-${Date.now()}.png"`,
          })
          res.end(png)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  const upgrade = {
    path: API_BASE + '/stream',
    handler: (req, socket, head) => {
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      streamWss.handleUpgrade(req, socket, head, (ws) => {
        engine.clients.add(ws)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const serial = url.searchParams.get('serial') ?? ''
        // Send the current snapshot, then a history replay for the requested
        // device (or the first attached one), then live lines keep flowing.
        ws.send(JSON.stringify({
          type: 'ready',
          adbPath: engine.adb,
          devices: engine.deviceList(),
          streaming: [...engine.streams.keys()],
        }))
        const target = serial !== '' && engine.devices.has(serial)
          ? serial
          : engine.devices.get([...engine.devices.keys()][0])?.serial ?? ''
        if (target !== '') {
          ws.send(JSON.stringify({ type: 'history', serial: target, entries: engine.recent(target, 500) }))
        }
        // Client-driven replay (device switch, pause resume).
        ws.on('message', (data) => {
          let frame
          try { frame = JSON.parse(String(data)) } catch { return }
          if (frame?.type === 'replay' && typeof frame.serial === 'string') {
            const entries = engine.devices.has(frame.serial) ? engine.recent(frame.serial, 500) : []
            ws.send(JSON.stringify({ type: 'history', serial: frame.serial, entries }))
          }
        })
        ws.on('close', () => { engine.clients.delete(ws) })
        ws.on('error', () => { engine.clients.delete(ws) })
      })
    },
  }

  return { routes, upgrade }
}

/** The logcat_recent agent tool. */
function logcatRecentTool(engine) {
  return defineTool({
    name: 'logcat_recent',
    description: 'Read recent Android logcat entries from an attached adb device (dsh-logcat plugin). ' +
      'Triggers: check android logcat, read device logs, debug the app on the phone, view crash logs.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      lines: { type: 'integer', description: 'Max entries to return (default 200, max 2000).' },
      level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: 'Minimum severity filter (V=verbose … F=fatal).' },
      filter: { type: 'string', description: 'Substring to filter the raw line (case-insensitive).' },
      package: { type: 'string', description: 'App package to filter by (pid of the running app); falls back to the package set via logcat_set_package.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ts: { type: 'string', required: true },
                pid: { type: 'integer', required: true },
                tid: { type: 'integer', required: true },
                level: { type: 'string', required: true },
                tag: { type: 'string', required: true },
                msg: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const entries = value?.entries ?? []
        if (entries.length === 0) return [{ type: 'text', text: '(no logcat entries)' }]
        const levels = ['V', 'D', 'I', 'W', 'E', 'F']
        const lines = entries.map((e) => {
          const level = e.level !== '' ? e.level : '?'
          const min = levels.indexOf(level)
          const shown = min >= 2 ? level : (min >= 0 ? '·' : ' ')
          return `${e.ts} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${shown} ${e.tag.padEnd(16)} : ${e.msg}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      if (serial === '') return { entries: [] }
      const lines = Math.min(Math.max(Number(args.lines ?? 200) || 200, 1), 2000)
      const level = typeof args.level === 'string' ? args.level : ''
      const filter = typeof args.filter === 'string' ? args.filter : ''
      const pkg = (typeof args.package === 'string' ? args.package.trim() : '') || engine.currentPackage
      // The declared output schema is strict (additionalProperties: false), so strip the
      // internal raw/cont fields before returning — otherwise DSH rejects the result.
      const toOutput = (list) => list.map((e) => ({ ts: e.ts, pid: e.pid, tid: e.tid, level: e.level, tag: e.tag, msg: e.msg }))
      const picked = engine.recent(serial, lines, level, filter)
      if (pkg === '') return { entries: toOutput(picked) }
      const pids = await engine.pidsOfPackage(serial, pkg)
      if (pids.length === 0) {
        return { entries: [], note: `package ${pkg} is not running on ${serial} — start it first (adb_exec: am start -n ...) or pass another package` }
      }
      const byPid = picked.filter((e) => e.pid > 0 && pids.includes(e.pid))
      return byPid.length > 0
        ? { entries: toOutput(byPid) }
        : { entries: [], note: `no buffered logcat lines for package ${pkg} (pids ${pids.join(', ')}); the app may not have logged yet` }
    },
  })
}

/** The logcat_set_package agent tool: set/clear the app package currently under test. */
function logcatSetPackageTool(engine) {
  return defineTool({
    name: 'logcat_set_package',
    description: 'Set (or clear) the Android app package currently under test, so logcat_recent filters by it. ' +
      'Call after installing/starting the app you are debugging (e.g. via adb_exec). ' +
      'Pass an empty string to clear the filter. Triggers: focus logs on one app, filter logcat by package.',
    parameters: {
      package: { type: 'string', description: 'The app package to track, e.g. "com.example.app"; an empty string clears it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          package: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.package ? `tracking package: ${value.package}` : 'package filter cleared' }],
    },
    async execute(args) {
      const pkg = typeof args.package === 'string' ? args.package.trim() : ''
      engine.currentPackage = pkg
      // Let open panels reflect the current test package immediately.
      engine.broadcast({ type: 'package', package: pkg })
      return { package: pkg }
    },
  })
}

/** The logcat_devices agent tool: list attached adb devices for on-device debugging. */
function logcatDevicesTool(engine) {
  return defineTool({
    name: 'logcat_devices',
    description: 'List currently attached Android devices (serial, model, state) for on-device debugging. ' +
      'Triggers: check adb devices, see which phones are connected, decide whether to debug a build on a real device.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          devices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                serial: { type: 'string', required: true },
                model: { type: 'string', required: true },
                state: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const devices = value?.devices ?? []
        if (devices.length === 0) return [{ type: 'text', text: '(no devices attached)' }]
        const lines = devices.map((d) => `${d.state.padEnd(11)} ${(d.model || '?').padEnd(22)} ${d.serial}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return { devices: engine.deviceList().map(({ serial, model, state }) => ({ serial, model, state })) }
    },
  })
}

/** The adb_exec agent tool: run one adb shell command on a device. */
function adbExecTool(engine) {
  return defineTool({
    name: 'adb_exec',
    description: 'Run one adb shell command on an attached Android device — e.g. install an APK (pm install -r <path>), ' +
      'start an activity (am start -n pkg/.Activity), list processes, take a screenshot (screencap -p /sdcard/x.png), ' +
      'or dump UI (uiautomator dump). NOTE: executes real commands on the user\'s device and consumes device resources — ' +
      'confirm intent before destructive actions (uninstall, reboot, clear data, factory reset).',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      command: { type: 'string', description: 'The shell command to run without the "adb shell" prefix, e.g. "pm list packages | grep com.example" or "am start -n com.example/.MainActivity".' },
      timeoutMs: { type: 'integer', description: 'Command timeout in ms (default 15000, max 120000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'integer' },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const out = value?.stdout ?? ''
        const err = value?.stderr ?? ''
        const parts = []
        if (out !== '') parts.push(out.trimEnd())
        if (err !== '') parts.push('stderr: ' + err.trimEnd())
        if (parts.length === 0) parts.push(`(exit ${value?.code ?? '?'}, no output)`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (engine.adb === null) return { ok: false, code: null, stdout: '', stderr: 'adb not found on this host' }
      if (serial === '') return { ok: false, code: null, stdout: '', stderr: 'no attached device; connect and authorize one first' }
      if (command === '') return { ok: false, code: null, stdout: '', stderr: 'command is required' }
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 15000) || 15000, 1000), 120000)
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', command], timeoutMs)
      return { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
  })
}

/** The adb_install agent tool: install a local APK onto a device (adb install -r). */
function adbInstallTool(engine) {
  return defineTool({
    name: 'adb_install',
    description: 'Install a local APK file onto an attached Android device (adb install -r). ' +
      'Use after building an APK to deploy it to the real device for debugging. ' +
      'The apkPath is a LOCAL path on this host (e.g. a build output).',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      apkPath: { type: 'string', description: 'Absolute local path to the APK, e.g. "F:/app/build/outputs/apk/debug/app-debug.apk".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'integer' },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const parts = []
        if (value?.stdout) parts.push(value.stdout.trimEnd())
        if (value?.stderr) parts.push('stderr: ' + value.stderr.trimEnd())
        if (parts.length === 0) parts.push(value?.ok ? 'installed' : `install failed (exit ${value?.code ?? '?'})`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const apkPath = typeof args.apkPath === 'string' ? args.apkPath.trim() : ''
      if (engine.adb === null) return { ok: false, code: null, stdout: '', stderr: 'adb not found on this host' }
      if (serial === '') return { ok: false, code: null, stdout: '', stderr: 'no attached device; connect and authorize one first' }
      if (apkPath === '') return { ok: false, code: null, stdout: '', stderr: 'apkPath is required' }
      if (!existsSync(apkPath)) return { ok: false, code: null, stdout: '', stderr: `APK not found: ${apkPath}` }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'install', '-r', apkPath], 120000)
      return { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
  })
}

/** The adb_pull agent tool: copy a file from the device to this host (adb pull). */
function adbPullTool(engine) {
  return defineTool({
    name: 'adb_pull',
    description: 'Copy a file from an attached Android device to this host (adb pull) — ' +
      'e.g. pull a screenshot saved via adb_exec (screencap -p /sdcard/x.png), a log file, or a bugreport.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      remotePath: { type: 'string', description: 'Path on the device, e.g. "/sdcard/screen.png".' },
      localPath: { type: 'string', description: 'Absolute local destination path, e.g. "F:/shots/screen.png".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'integer' },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          localPath: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const parts = []
        if (value?.ok && value?.localPath) parts.push(`pulled to ${value.localPath}`)
        if (value?.stdout) parts.push(value.stdout.trimEnd())
        if (value?.stderr) parts.push('stderr: ' + value.stderr.trimEnd())
        if (parts.length === 0) parts.push(`pull failed (exit ${value?.code ?? '?'})`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const remotePath = typeof args.remotePath === 'string' ? args.remotePath.trim() : ''
      const localPath = typeof args.localPath === 'string' ? args.localPath.trim() : ''
      if (engine.adb === null) return { ok: false, code: null, stdout: '', stderr: 'adb not found on this host' }
      if (serial === '') return { ok: false, code: null, stdout: '', stderr: 'no attached device; connect and authorize one first' }
      if (remotePath === '' || localPath === '') return { ok: false, code: null, stdout: '', stderr: 'remotePath and localPath are required' }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'pull', remotePath, localPath], 120000)
      return { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr, localPath: result.ok ? localPath : '' }
    },
  })
}

/** ------------------------------------------------------------------ */

/** Mount the adb engine, routes, tool, and announcement. */
export function apply(ctx, config) {
  const resolve = () => ({
    enabled: config?.enabled ?? true,
    announceToAgent: config?.announceToAgent ?? true,
  })

  const engine = new AdbEngine()
  // Observable handle for diagnostics and self-checks. Real cordis contexts
  // reject bare property assignment ("cannot set property without provide"),
  // so publish through ctx.provide when available and fall back to direct
  // assignment for the plain-object stub used by selfcheck.mjs.
  const logcatHandle = {
    engine,
    status: () => ({
      adbPath: engine.adb,
      adbVersion: engine.adbVersion,
      ready: engine.adb !== null,
      devices: engine.deviceList(),
      streaming: [...engine.streams.keys()],
      bufferSizes: Object.fromEntries([...engine.buffers.entries()].map(([s, b]) => [s, b.length])),
      currentPackage: engine.currentPackage,
    }),
  }
  if (typeof ctx.provide === 'function') ctx.provide('logcat', logcatHandle)
  else ctx.logcat = logcatHandle
  let inited = false
  const initOnce = () => {
    if (inited) return
    inited = true
    void engine.init().then((ok) => {
      if (ok) engine.startPolling()
    })
  }

  const { routes, upgrade } = makeRoutes(engine)
  let disposeRoutes
  let disposeTools
  let disposeSection

  const sync = () => {
    const value = resolve()
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-logcat',
        order: SECTION_ORDER,
        text: logcatGuidance(engine),
      })
    }
    disposeRoutes = ctx.effect(() => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
      return () => {
        for (const dispose of disposers) dispose()
        upgradeDisposer()
      }
    }, 'dsh-logcat: routes')
    disposeTools = ctx.effect(() => {
      const disposers = [
        logcatRecentTool(engine),
        logcatDevicesTool(engine),
        adbExecTool(engine),
        logcatSetPackageTool(engine),
        adbInstallTool(engine),
        adbPullTool(engine),
      ].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-logcat: tools')
    initOnce()
  }

  ctx.effect(() => () => {
    engine.dispose()
  }, 'dsh-logcat: engine')

  sync()
}
