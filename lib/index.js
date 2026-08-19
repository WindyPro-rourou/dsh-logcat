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
  '本机已安装 dsh-logcat 插件（DSH Web GUI 的安卓实机调试面板）：侧边栏「Logcat」入口；自动探测本机 adb（ANDROID_HOME / 默认 SDK 路径），对处于调试模式的已连接设备自动附加 logcat 流（threadtime 格式，每设备保留最近 2000 行环形缓冲）；Web 面板支持设备切换、级别/关键词过滤、暂停/清空/导出；agent 可用 logcat_recent 工具读取最近日志。限制：需设备开启 USB 调试并授权本机；logcat 输出可能含敏感信息；执行 adb 命令消耗真实设备资源，先确认再操作。用户提到「Logcat / 安卓日志 / 实机调试 / adb 日志」时即指本插件，请据此协作。'

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
      return { entries: engine.recent(serial, lines, level, filter) }
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
        text: LOGCAT_GUIDANCE,
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
      const disposers = [logcatRecentTool(engine)].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-logcat: tools')
    initOnce()
  }

  ctx.effect(() => () => {
    engine.dispose()
  }, 'dsh-logcat: engine')

  sync()
}
