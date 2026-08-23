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
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { WebSocket, WebSocketServer } from 'ws'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** This package's manifest (name + version), read from the installed location. */
const OWN_MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Latest published versions per dist-tag (cached 1h; null until first check). */
let latestVersion = null   // dist-tags.latest (stable)
let previewVersion = null  // dist-tags.preview (experimental)
let lastVersionCheck = 0

/** Simple semver compare: 1 when a > b, -1 when a < b, 0 equal. Prerelease < release. */
function semverCompare(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v ?? '')
    return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null } : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1 // release > prerelease
  if (pb.pre === null) return -1
  return pa.pre > pb.pre ? 1 : -1
}

/** Refresh the cached npm dist-tags of this package (offline-safe). */
async function ensureVersionCheck() {
  if ((latestVersion !== null || previewVersion !== null) && Date.now() - lastVersionCheck < 3600_000) return
  lastVersionCheck = Date.now()
  try {
    const res = await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(OWN_MANIFEST.name)}/dist-tags`, {
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const tags = await res.json()
      latestVersion = tags.latest ?? null
      previewVersion = tags.preview ?? null
    }
  } catch { /* offline / registry unreachable — keep whatever we had */ }
}

/** Whether this install is a prerelease (preview line). */
const IS_PREVIEW = OWN_MANIFEST.version.includes('-')

/** The update hint for the current install, or null when up to date. */
function updateHint() {
  if (IS_PREVIEW) {
    if (previewVersion !== null && semverCompare(previewVersion, OWN_MANIFEST.version) > 0) {
      return { kind: 'preview', version: previewVersion, text: `新 preview 版本 ${previewVersion} 可更新（npm 标签 preview；正式版 ${latestVersion ?? '?'} 未受影响）` }
    }
    if (previewVersion === null && latestVersion !== null && semverCompare(latestVersion, OWN_MANIFEST.version) > 0) {
      return { kind: 'stable', version: latestVersion, text: `正式版 ${latestVersion} 已发布，可切回稳定版` }
    }
    return null
  }
  if (latestVersion !== null && semverCompare(latestVersion, OWN_MANIFEST.version) > 0) {
    return { kind: 'stable', version: latestVersion, text: `新版本 ${latestVersion} 可更新` }
  }
  return null
}

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
  '本机已安装 dsh-logcat 插件（DSH Web GUI 的安卓实机调试/逆向工作台）：自动探测本机 adb 并对已连接的调试设备附加 logcat 流；日志自动落盘（~/.dsh/logcat/logs）支持历史回溯，崩溃/ANR 自动截图快照存档（~/.dsh/logcat/crashes，可用 crash_sessions 查阅）；侧边栏「Logcat」入口打开面板（设备切换、级别/多关键词过滤、按测试包名过滤、截图、崩溃高亮、历史回溯、events 事件视图、内存搜索工作台、屏幕实时投屏与远程操控（点击/滑动/输入）、WiFi 无线连接、APK 安装、一键安装 adb）。' +
  '以下 agent 工具均可用（串口为设备 serial，可用 logcat_devices 获取），构建安卓应用/实机调试/逆向分析时请主动调用：' +
  '设备与状态：logcat_devices（列出设备）、device_info（型号/版本/SDK/分辨率/内存/电量）、device_stats（CPU/内存/电量采样）、app_info（已安装应用的版本号/versionCode/APK 路径）；' +
  '屏幕与多模态：screen_capture（截图存档并嵌入对话图片，配合 input_* 做可视化调试循环，多模态模型可直接看图修 bug）；' +
  '部署与执行：adb_install（本地 APK 装真机）、adb_exec（任意 adb shell 命令）、adb_pull（拉文件）、app_launch（启动应用/指定 Activity）、app_stop（停止应用，破坏性先确认）、input_tap/input_swipe/input_text/input_keyevent（模拟点击/滑动/输入/按键）、ui_dump（界面层级 XML）、activity_current（当前前台 Activity）；' +
  '日志与崩溃：logcat_recent（按级别/关键词/包名读实时日志）、logcat_history（磁盘历史日志回溯）、logcat_crash（崩溃/ANR 捕获+上下文）、logcat_events（events 事件缓冲：应用启动/崩溃/生命周期事件）、crash_sessions（崩溃自动快照历史）、logcat_set_package（锁定当前测试包名）；' +
  '逆向与内存：proc_list（进程列表）、proc_maps（内存映射+so 模块基址）、proc_status（进程状态/内存摘要）、proc_smaps（内存占用明细 Top 区域）、mem_dump（指定地址读内存 hex）、mem_search（内存搜 hex 模式/字符串）、frida_server（frida-server 部署/启停）、frida_script（hook/trace/scan/bypass/dump 常用脚本模板）。' +
  '工作流建议：构建安卓应用 → 确认设备在线后 adb_install 部署、app_launch 启动、logcat_set_package 锁包、logcat_recent/logcat_crash 看崩溃（崩溃会自动截图存档，crash_sessions 可查阅）、ui_dump+input_* 做界面自动化；' +
  '逆向分析 → proc_list 找进程、proc_maps 拿模块基址、mem_dump 读内存、frida_server 起 frida。' +
  '限制：需设备开启 USB 调试并授权本机；读其他应用内存/maps 需要 root 或 debuggable 应用（run-as）；logcat 输出可能含敏感信息；' +
  'adb 命令消耗真实设备资源，破坏性操作（卸载/重启/清数据/杀进程/force-stop）先向用户确认再执行。' +
  '用户提到「Logcat / 安卓日志 / 实机调试 / adb 日志 / 逆向 / 读内存 / 抓包定位」时即指本插件，请据此主动协作。'

/** Dynamic model-facing announcement: base guidance plus live device/package/version facts. */
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
    const versionLine = (() => {
      const hint = updateHint()
      if (hint === null) return ''
      const tag = IS_PREVIEW ? 'preview' : 'stable'
      return `dsh-logcat 更新提醒（${tag} 通道）：${hint.text}（升级：dsh plugin --profile web update 或 add @windypro-rourou/dsh-logcat@${hint.kind === 'preview' ? 'preview' : 'latest'}，然后重启 GUI）。`
    })()
    return `${LOGCAT_GUIDANCE}\n${deviceLine}${pkgLine !== '' ? `\n${pkgLine}` : ''}${versionLine !== '' ? `\n${versionLine}` : ''}`
  }
}

/** ---------------------------------------------------------------- adb */

/** Where the plugin can self-install adb platform-tools (~/.dsh/adb). */
function bundledAdbRoot() {
  return join(homedir(), '.dsh', 'adb')
}

/** Candidate adb(.exe) locations, in probe order. */
function adbCandidates() {
  const list = []
  const envs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  for (const root of envs) {
    if (root) list.push(join(root, 'platform-tools', 'adb.exe'), join(root, 'platform-tools', 'adb'))
  }
  const sdk = join(homedir(), 'AppData', 'Local', 'Android', 'Sdk')
  list.push(join(sdk, 'platform-tools', 'adb.exe'))
  list.push(join(sdk, 'platform-tools', 'adb'))
  // Plugin-managed install location (one-click setup on first run).
  list.push(join(bundledAdbRoot(), 'platform-tools', 'adb.exe'))
  list.push(join(bundledAdbRoot(), 'platform-tools', 'adb'))
  return list
}

/** Official platform-tools zip mirrors for this host, in preference order. */
function platformToolsUrls() {
  const file = {
    win32: 'platform-tools-latest-windows.zip',
    darwin: 'platform-tools-latest-darwin.zip',
  }[process.platform] ?? 'platform-tools-latest-linux.zip'
  return [
    'https://mirrors.ustc.edu.cn/android/repository/' + file,
    'https://dl.google.com/android/repository/' + file,
  ]
}

/** Download and unpack platform-tools into ~/.dsh/adb. Resolves the adb path. */
export async function installPlatformTools() {
  const { mkdir, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dest = bundledAdbRoot()
  await mkdir(dest, { recursive: true })
  const zipPath = join(tmpdir(), `platform-tools-${Date.now()}.zip`)
  let downloaded = false
  let lastError = null
  for (const url of platformToolsUrls()) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await writeFile(zipPath, Buffer.from(await response.arrayBuffer()))
      downloaded = true
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!downloaded) throw new Error(`download failed from all mirrors: ${lastError?.message ?? 'unknown'}`)
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  try {
    if (process.platform === 'win32') {
      // PowerShell ships with Windows; Expand-Archive unzips natively.
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${dest}'`], { timeout: 180000, windowsHide: true }, (error) => {
          if (error) reject(new Error('unzip failed: ' + (error.message ?? String(error))))
          else resolve()
        })
      })
    } else {
      await new Promise((resolve, reject) => {
        execFile('unzip', ['-o', zipPath, '-d', dest], { timeout: 180000 }, (error) => {
          if (error) reject(new Error('unzip failed: ' + (error.message ?? String(error))))
          else resolve()
        })
      })
    }
  } finally {
    await rm(zipPath, { force: true })
  }
  return join(dest, 'platform-tools', exe)
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
  constructor(adb, serial, onLine, onExit, extraArgs = []) {
    this.adb = adb
    this.serial = serial
    this.onLine = onLine
    this.onExit = onExit
    this.extraArgs = extraArgs
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
      child = spawn(this.adb, ['-s', this.serial, 'logcat', '-v', 'threadtime', ...this.extraArgs], {
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
export class AdbEngine {
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
    // Persistence + extras:
    this.logRoot = join(homedir(), '.dsh', 'logcat')          // logs/ + crashes/ live here
    this.logStreams = new Map()     // serial -> { date, stream } (daily log files)
    this.eventsBuffers = new Map()  // serial -> ring buffer (logcat -b events)
    this.eventsStreams = new Map()  // serial -> DeviceStream (-b events)
    this.lastCrash = new Map()      // serial -> ms timestamp (snapshot throttle)
    this.screenLoops = new Map()    // serial -> { timer, busy } (1fps screen stream)
  }

  /** Serial -> filesystem-safe directory name. */
  safeName(serial) {
    return String(serial).replace(/[\\/:*?"<>|]/g, '_')
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
    for (const rec of this.logStreams.values()) { try { rec.stream.end() } catch { /* closed */ } }
    this.logStreams.clear()
    for (const stream of this.eventsStreams.values()) stream.stop()
    this.eventsStreams.clear()
    for (const loop of this.screenLoops.values()) clearInterval(loop.timer)
    this.screenLoops.clear()
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
        this.eventsBuffers.delete(serial)
        const stream = this.streams.get(serial)
        if (stream !== undefined) {
          stream.stop()
          this.streams.delete(serial)
        }
        const estream = this.eventsStreams.get(serial)
        if (estream !== undefined) {
          estream.stop()
          this.eventsStreams.delete(serial)
        }
        const sloop = this.screenLoops.get(serial)
        if (sloop !== undefined) {
          clearInterval(sloop.timer)
          this.screenLoops.delete(serial)
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
        const estream = this.eventsStreams.get(serial)
        if (estream !== undefined) {
          estream.stop()
          this.eventsStreams.delete(serial)
        }
        const sloop = this.screenLoops.get(serial)
        if (sloop !== undefined) {
          clearInterval(sloop.timer)
          this.screenLoops.delete(serial)
        }
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
    this.persist(serial, entry)
    if (!entry.cont && /FATAL EXCEPTION|ANR in |AndroidRuntime: FATAL/.test(raw)) this.detectCrash(serial, entry)
  }

  /** Append one entry to the per-device daily log file (~/.dsh/logcat/logs/<serial>/logcat-MM-DD.log). */
  persist(serial, entry) {
    if (entry.ts === '') return
    const date = entry.ts.slice(0, 5) // MM-DD
    let rec = this.logStreams.get(serial)
    if (rec === undefined || rec.date !== date) {
      if (rec !== undefined) { try { rec.stream.end() } catch { /* closed */ } }
      const dir = join(this.logRoot, 'logs', this.safeName(serial))
      try { mkdirSync(dir, { recursive: true }) } catch { return }
      const stream = createWriteStream(join(dir, `logcat-${date}.log`), { flags: 'a' })
      stream.on('error', () => { this.logStreams.delete(serial) })
      rec = { date, stream }
      this.logStreams.set(serial, rec)
    }
    rec.stream.write(entry.raw + '\n')
  }

  /** Read the tail of the on-disk history for a serial (newest-last raw lines). */
  async readDiskTail(serial, capLines) {
    const dir = join(this.logRoot, 'logs', this.safeName(serial))
    if (!existsSync(dir)) return []
    let names
    try { names = (await fsp.readdir(dir)).filter((f) => /^logcat-\d{2}-\d{2}\.log$/.test(f)).sort() } catch { return [] }
    const out = []
    for (let i = names.length - 1; i >= 0 && out.length < capLines; i--) {
      const file = join(dir, names[i])
      let text = ''
      try {
        const stat = await fsp.stat(file)
        const chunk = Math.min(stat.size, Math.max(capLines * 140, 64 * 1024))
        const fd = await fsp.open(file, 'r')
        const buf = Buffer.alloc(chunk)
        await fd.read(buf, 0, chunk, stat.size - chunk)
        await fd.close()
        text = buf.toString('utf8')
        if (stat.size > chunk) {
          const nl = text.indexOf('\n')
          if (nl >= 0) text = text.slice(nl + 1)
        }
      } catch { continue }
      const lines = text.split(/\r?\n/).filter(Boolean)
      for (let j = lines.length - 1; j >= 0 && out.length < capLines; j--) out.unshift(lines[j])
    }
    return out
  }

  /**
   * Historical logcat: disk tail merged with the live ring buffer (deduped by
   * timestamp so nothing overlaps), filtered, newest-last.
   */
  async history(serial, lines = 1000, level = '', filter = '') {
    const disk = await this.readDiskTail(serial, Math.min(lines * 4, 20000))
    const parsed = disk.map((raw) => parseLogcatLine(raw)).filter((e) => e !== null)
    const buffered = this.recent(serial, lines, level, filter)
    const oldest = buffered[0]?.ts ?? ''
    let cut = parsed.length
    if (oldest !== '') {
      while (cut > 0 && parsed[cut - 1].ts >= oldest) cut -= 1
    }
    const merged = parsed.slice(0, cut).concat(buffered)
    const needle = filter.trim().toLowerCase()
    const picked = merged.filter((e) => {
      if (level !== '' && e.level !== '' && e.level !== level) return false
      if (needle === '') return true
      return e.raw.toLowerCase().includes(needle)
    })
    return picked.slice(-lines)
  }

  /** Auto-crash-snapshot: throttle + fire the capture (screenshot + context). */
  detectCrash(serial, entry) {
    const now = Date.now()
    if ((this.lastCrash.get(serial) ?? 0) + 3000 > now) return
    this.lastCrash.set(serial, now)
    void this.captureCrash(serial, entry)
  }

  /** Save screenshot + log context to ~/.dsh/logcat/crashes/<serial>/<stamp>-<kind>/. */
  async captureCrash(serial, entry) {
    const kind = /ANR in /.test(entry.raw) ? 'ANR' : 'FATAL'
    const stamp = entry.ts.replace(/[^\d]/g, '') || String(Date.now())
    const dir = join(this.logRoot, 'crashes', this.safeName(serial), `${stamp}-${kind}`)
    try {
      await fsp.mkdir(dir, { recursive: true })
      const ctxLines = this.recent(serial, 150).map((e) => e.raw).join('\n')
      await fsp.writeFile(join(dir, 'crash.log'), ctxLines + '\n', 'utf8')
      let hasScreenshot = false
      if (this.adb !== null) {
        try {
          const png = await runAdbBinary(this.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], 15000)
          await fsp.writeFile(join(dir, 'screenshot.png'), png)
          hasScreenshot = true
        } catch { /* screenshot is best-effort */ }
      }
      const summary = entry.msg.slice(0, 240)
      await fsp.writeFile(join(dir, 'meta.json'), JSON.stringify({ ts: entry.ts, pid: entry.pid, kind, summary, serial, hasScreenshot }), 'utf8')
      this.broadcast({ type: 'crash', crash: { ts: entry.ts, pid: entry.pid, kind, summary, serial, hasScreenshot } })
    } catch { /* snapshot is best-effort */ }
  }

  /** List saved crash snapshots for a serial (newest first). */
  async listCrashes(serial) {
    const root = join(this.logRoot, 'crashes', this.safeName(serial))
    if (!existsSync(root)) return []
    let names
    try { names = await fsp.readdir(root) } catch { return [] }
    const out = []
    for (const name of names) {
      const m = /^(\d+)-(FATAL|ANR)$/.exec(name)
      if (m === null) continue
      const dir = join(root, name)
      let meta = null
      try { meta = JSON.parse(await fsp.readFile(join(dir, 'meta.json'), 'utf8')) } catch { /* no meta */ }
      out.push({
        id: name,
        ts: m[1],
        kind: m[2],
        serial,
        hasScreenshot: meta?.hasScreenshot === true || existsSync(join(dir, 'screenshot.png')),
        summary: meta?.summary ?? '',
        pid: meta?.pid ?? 0,
      })
    }
    return out.sort((a, b) => b.ts.localeCompare(a.ts))
  }

  /** Start / stop the per-device `logcat -b events` stream (panel-controlled). */
  setEvents(serial, on) {
    const existing = this.eventsStreams.get(serial)
    if (on) {
      if (existing === undefined && this.adb !== null && this.devices.get(serial)?.state === 'device') {
        const stream = new DeviceStream(this.adb, serial, (line) => this.pushEventsLine(serial, line), () => {}, ['-b', 'events'])
        this.eventsStreams.set(serial, stream)
        stream.start()
      }
    } else if (existing !== undefined) {
      existing.stop()
      this.eventsStreams.delete(serial)
    }
  }

  /** Push one events-buffer line into its ring buffer and fan out. */
  pushEventsLine(serial, raw) {
    const entry = parseLogcatLine(raw) ?? { ts: '', pid: 0, tid: 0, level: '', tag: '', msg: raw, raw, cont: true }
    let buffer = this.eventsBuffers.get(serial)
    if (buffer === undefined) { buffer = []; this.eventsBuffers.set(serial, buffer) }
    buffer.push(entry)
    if (buffer.length > this.BUFFER_CAP) buffer.splice(0, buffer.length - this.BUFFER_CAP)
    this.broadcast({ type: 'eline', serial, entry })
  }

  /** Recent entries of the events buffer (newest-last). */
  eventsRecent(serial, lines = 200, filter = '') {
    const buffer = this.eventsBuffers.get(serial) ?? []
    const needle = filter.trim().toLowerCase()
    const picked = buffer.filter((e) => needle === '' || e.raw.toLowerCase().includes(needle))
    return picked.slice(-lines)
  }

  /** Start / stop the screen-stream loop for a device (panel live view). */
  setScreen(serial, on) {
    const existing = this.screenLoops.get(serial)
    if (on) {
      if (existing === undefined && this.adb !== null && this.devices.get(serial)?.state === 'device') {
        const loop = { timer: null, busy: false, lastHash: null }
        this.screenLoops.set(serial, loop)
        const tick = () => {
          if (loop.busy || this.screenLoops.get(serial) !== loop) return
          loop.busy = true
          void this.captureScreenFrame(serial, loop).finally(() => { loop.busy = false })
        }
        // 500ms cadence: screencap itself takes 300-700ms, so the busy flag
        // throttles naturally; static screens are deduped by content hash.
        loop.timer = setInterval(tick, 500)
        tick()
      }
    } else if (existing !== undefined) {
      clearInterval(existing.timer)
      this.screenLoops.delete(serial)
    }
  }

  /** Capture one frame and broadcast it as a binary WS frame (deduped when the picture is unchanged). */
  async captureScreenFrame(serial, loop) {
    try {
      const png = await runAdbBinary(this.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], 8000)
      if (png.length < 100) return
      // Cheap content hash (FNV-1a over the full buffer) — skip broadcasts of
      // identical frames so idle screens cost nothing on the client.
      let hash = 2166136261
      for (let i = 0; i < png.length; i++) {
        hash ^= png[i]
        hash = Math.imul(hash, 16777619)
      }
      if (loop !== undefined && hash === loop.lastHash) return
      if (loop !== undefined) loop.lastHash = hash
      this.broadcastBinary({ type: 'simage', serial, len: png.length, ts: Date.now() }, png)
    } catch { /* frame dropped */ }
  }

  /** Broadcast a binary frame: 4-byte header length + JSON header + payload. */
  broadcastBinary(header, payload) {
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8')
    const frame = Buffer.alloc(4 + headerBuf.length + payload.length)
    frame.writeUInt32BE(headerBuf.length, 0)
    headerBuf.copy(frame, 4)
    payload.copy(frame, 4 + headerBuf.length)
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (ws.bufferedAmount > 4 * 1024 * 1024) continue
      try { ws.send(frame) } catch { /* closed */ }
    }
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

/** Named Android keycodes shared by the input_keyevent tool and panel key buttons. */
const KEYCODES = {
  home: 3, back: 4, dial: 5, endcall: 6, volume_up: 24, volume_down: 25, power: 26, camera: 27, clear: 28,
  dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22, enter: 66, tab: 61, delete: 67, escape: 111,
  space: 62, backspace: 67, menu: 82, recents: 187, app_switch: 187, wakeup: 224, sleep: 223, search: 84,
}

/** Shared `ps -A` listing (used by proc_list tool and the /processes route). */
export async function listProcesses(engine, serial, needle) {
  const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'ps -A -o PID,PPID,USER,NAME'], 20000)
  const processes = []
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line)
    if (m === null) continue
    const name = m[4]
    if (needle !== '' && !name.toLowerCase().includes(needle)) continue
    processes.push({ pid: Number.parseInt(m[1], 10), ppid: Number.parseInt(m[2], 10), user: m[3], name })
  }
  return processes
}

/** Search /proc/<pid>/mem for a byte pattern. Throws Error with a friendly message on failure. */
export async function searchMemory(engine, serial, pid, pattern, max) {
  const bytes = pattern.startsWith('hex:')
    ? pattern.slice(4).replace(/\s+/g, '').match(/[0-9a-f]{2}/gi)?.map((b) => b.toLowerCase()) ?? []
    : [...Buffer.from(pattern, 'utf8')].map((b) => b.toString(16).padStart(2, '0'))
  if (bytes.length === 0) throw new Error('could not parse pattern into bytes')
  const printfArg = "\\x" + bytes.join("\\x")
  const sh = `grep -aob -F "$(printf '${printfArg}')" /proc/${pid}/mem 2>&1 | head -${max}`
  const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', sh], 30000)
  const out = result.stdout ?? ''
  if (!result.ok || /Permission denied|No such file|No such process/.test(out)) {
    throw new Error(`cannot search pid ${pid} memory (need root / debuggable app); output: ${out.slice(0, 200)}`)
  }
  const offsets = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+):/.exec(line)
    if (m !== null) offsets.push(Number.parseInt(m[1], 10))
  }
  return { offsets, truncated: offsets.length >= max }
}

/** Dump raw memory at an address as od hex text. Throws Error with a friendly message on failure. */
export async function dumpMemory(engine, serial, pid, addr, len) {
  const sh = `dd if=/proc/${pid}/mem bs=1 skip=${addr} count=${len} of=/sdcard/dsh-mem.bin 2>/dev/null && od -A x -t x1 -v /sdcard/dsh-mem.bin && rm /sdcard/dsh-mem.bin || echo DSH_MEM_FAIL`
  const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', sh], 20000)
  if (!result.ok || result.stdout.includes('DSH_MEM_FAIL') || result.stdout.trim() === '') {
    throw new Error(`cannot read memory at 0x${addr.toString(16)} (need root / debuggable app); output: ${(result.stdout + result.stderr).slice(0, 200)}`)
  }
  return result.stdout.trim()
}

/** One-shot device info + resource stats for the panel (single adb round-trip). */
async function collectStats(engine, serial) {
  const sh = 'getprop ro.product.model; getprop ro.product.brand; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi; wm size; grep -E "MemTotal|MemFree" /proc/meminfo; dumpsys battery | grep -E "level:|status:"; top -b -n 1 | head -3'
  const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', sh], 20000)
  const lines = (result.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const get = (i) => lines[i] ?? ''
  const field = (prefix) => { const l = lines.find((x) => x.startsWith(prefix)); return l ? l.slice(prefix.length).trim() : undefined }
  const kb = (prefix) => { const v = field(prefix); return v ? Number.parseInt(v, 10) || undefined : undefined }
  const totalMemKb = kb('MemTotal') ?? 0
  const freeMemKb = kb('MemFree') ?? 0
  const usedMemKb = totalMemKb > 0 ? totalMemKb - freeMemKb : 0
  return {
    ready: true,
    serial,
    model: get(0) || undefined,
    brand: get(1) || undefined,
    androidVersion: get(2) || undefined,
    sdk: get(3) || undefined,
    abi: get(4) || undefined,
    resolution: (lines.find((l) => l.startsWith('Physical size')) ?? '').replace('Physical size: ', '') || undefined,
    totalMemKb,
    freeMemKb,
    usedMemKb,
    memPct: totalMemKb > 0 ? Math.round((usedMemKb / totalMemKb) * 100) : undefined,
    batteryLevel: kb('level'),
    batteryStatus: field('status'),
    cpu: lines.find((l) => /%cpu|Cpu\(s\)|CPU:/i.test(l)) ?? undefined,
  }
}

/** Build every /api/dsh-logcat route plus the stream upgrade. */
function makeRoutes(engine) {
  const routes = [
    {
      kind: 'exact',
      path: API_BASE + '/status',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        await ensureVersionCheck()
        const hint = updateHint()
        writeJson(res, 200, {
          adbPath: engine.adb,
          adbVersion: engine.adbVersion,
          ready: engine.adb !== null,
          devices: engine.deviceList(),
          streaming: [...engine.streams.keys()],
          eventsStreaming: [...engine.eventsStreams.keys()],
          screenCapable: true,
          currentPackage: engine.currentPackage,
          currentVersion: OWN_MANIFEST.version,
          latestVersion,
          previewVersion,
          updateAvailable: hint !== null,
          updateKind: hint?.kind ?? null,
          updateTarget: hint?.version ?? null,
          updateHint: hint?.text ?? null,
        })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/install-adb',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        if (engine.adb !== null) { writeJson(res, 200, { ok: true, already: true, adbPath: engine.adb }); return }
        try {
          const adbPath = await installPlatformTools()
          engine.adb = adbPath
          engine.adbVersion = (await runAdb(adbPath, ['version']))?.split(/\r?\n/)[0] ?? ''
          engine.startPolling()
          writeJson(res, 200, { ok: true, already: false, adbPath })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
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
      path: API_BASE + '/stats',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        if (engine.adb === null) { writeJson(res, 200, { ready: false }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const requested = url.searchParams.get('serial') ?? ''
        const serial = requested !== '' && engine.devices.has(requested)
          ? requested
          : [...engine.devices.keys()].find((s) => engine.devices.get(s).state === 'device') ?? ''
        if (serial === '') { writeJson(res, 200, { ready: false }); return }
        try {
          writeJson(res, 200, await collectStats(engine, serial))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
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
    {
      kind: 'exact',
      path: API_BASE + '/history',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const serial = url.searchParams.get('serial') ?? ''
        const target = serial !== '' ? serial : [...engine.devices.keys()][0] ?? ''
        if (target === '') { writeJson(res, 200, { serial: '', entries: [] }); return }
        const lines = Math.min(Math.max(Number(url.searchParams.get('lines') ?? 1000) || 1000, 1), 5000)
        const level = url.searchParams.get('level') ?? ''
        const filter = url.searchParams.get('filter') ?? ''
        try {
          const entries = await engine.history(target, lines, level, filter)
          writeJson(res, 200, { serial: target, entries: entries.map((e) => ({ ts: e.ts, pid: e.pid, tid: e.tid, level: e.level, tag: e.tag, msg: e.msg, raw: e.raw, cont: e.cont })) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/crashes',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const serial = url.searchParams.get('serial') ?? [...engine.devices.keys()][0] ?? ''
        if (serial === '') { writeJson(res, 200, { crashes: [] }); return }
        try {
          writeJson(res, 200, { crashes: await engine.listCrashes(serial) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/crash-file',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const serial = url.searchParams.get('serial') ?? ''
        const id = url.searchParams.get('id') ?? ''
        const file = url.searchParams.get('file') ?? ''
        if (serial === '' || !/^\d+-(FATAL|ANR)$/.test(id) || !/^(screenshot\.png|crash\.log|meta\.json)$/.test(file)) {
          writeJson(res, 400, { error: 'bad params' }); return
        }
        const crashRoot = join(engine.logRoot, 'crashes')
        const full = join(crashRoot, engine.safeName(serial), id, file)
        if (!full.startsWith(crashRoot) || !existsSync(full)) { writeJson(res, 404, { error: 'not found' }); return }
        try {
          const data = await fsp.readFile(full)
          res.writeHead(200, {
            'content-type': file.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': data.length,
          })
          res.end(data)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/install-apk',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        if (engine.adb === null) { writeJson(res, 500, { ok: false, error: 'adb not found' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const serial = url.searchParams.get('serial') ?? ''
        if (serial === '' || engine.devices.get(serial)?.state !== 'device') {
          writeJson(res, 400, { ok: false, error: `device not attached: ${serial || '(none)'}` }); return
        }
        const { tmpdir } = await import('node:os')
        const tmp = join(tmpdir(), `dsh-apk-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`)
        let settled = false
        const send = (code, body) => { if (!settled) { settled = true; writeJson(res, code, body) } }
        try {
          await new Promise((resolve, reject) => {
            const out = createWriteStream(tmp)
            let size = 0
            req.on('data', (chunk) => {
              size += chunk.length
              if (size > 1024 * 1024 * 1024) { out.destroy(); reject(new Error('APK too large (>1GB)')); return }
            })
            req.on('error', (err) => reject(err))
            out.on('error', (err) => reject(err))
            out.on('finish', () => resolve())
            req.pipe(out)
          })
          const result = await runAdbFull(engine.adb, ['-s', serial, 'install', '-r', tmp], 180000)
          send(200, { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr })
        } catch (error) {
          send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          try { await fsp.unlink(tmp) } catch { /* gone */ }
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/keyevent',
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
        const serial = typeof body.serial === 'string' ? body.serial : ''
        const key = typeof body.key === 'string' ? body.key : ''
        const code = Number.isInteger(body.code) ? body.code : KEYCODES[key]
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        if (serial === '' || !engine.devices.has(serial)) { writeJson(res, 400, { error: 'device not attached' }); return }
        if (!Number.isInteger(code) || code <= 0) { writeJson(res, 400, { error: `unknown key: ${key || '(none)'}` }); return }
        const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', `input keyevent ${code}`], 15000)
        writeJson(res, 200, { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/wifi-connect',
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
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        const host = typeof body.host === 'string' ? body.host.trim() : ''
        const port = typeof body.port === 'string' ? body.port.trim() : ''
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        if (host === '' || port === '') { writeJson(res, 400, { error: 'host and port are required' }); return }
        const endpoint = `${host}:${port}`
        const logs = []
        if (code !== '') {
          const pair = await runAdbFull(engine.adb, ['pair', endpoint, code], 30000)
          logs.push(`pair ${endpoint}: ` + ((pair.stdout || pair.stderr).trim() || `exit ${pair.code}`))
          if (!pair.ok) { writeJson(res, 200, { ok: false, output: logs.join('\n') }); return }
        }
        const conn = await runAdbFull(engine.adb, ['connect', endpoint], 30000)
        logs.push(`connect ${endpoint}: ` + ((conn.stdout || conn.stderr).trim() || `exit ${conn.code}`))
        writeJson(res, 200, { ok: conn.ok, output: logs.join('\n') })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/wifi-disconnect',
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
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        const host = typeof body.host === 'string' ? body.host.trim() : ''
        const port = typeof body.port === 'string' ? body.port.trim() : ''
        const endpoint = `${host}:${port}`
        const result = await runAdbFull(engine.adb, ['disconnect', endpoint], 15000)
        writeJson(res, 200, { ok: result.ok, output: (result.stdout || result.stderr).trim() })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/processes',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const serial = url.searchParams.get('serial') ?? [...engine.devices.keys()].find((s) => engine.devices.get(s).state === 'device') ?? ''
        if (serial === '') { writeJson(res, 200, { processes: [] }); return }
        const filter = (url.searchParams.get('filter') ?? '').toLowerCase()
        try {
          writeJson(res, 200, { processes: await listProcesses(engine, serial, filter) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/mem-search',
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
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        const serial = typeof body.serial === 'string' ? body.serial : ''
        const pid = Number(body.pid)
        const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : ''
        const max = Math.min(Math.max(Number(body.maxResults ?? 20) || 20, 1), 200)
        if (serial === '' || !engine.devices.has(serial) || !Number.isInteger(pid) || pid <= 0) {
          writeJson(res, 400, { error: 'serial + valid pid required' }); return
        }
        if (pattern === '') { writeJson(res, 400, { error: 'pattern is required (string or hex:...)' }); return }
        try {
          const result = await searchMemory(engine, serial, pid, pattern, max)
          writeJson(res, 200, { pid, pattern, ...result })
        } catch (error) {
          writeJson(res, 200, { pid, pattern, offsets: [], error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/mem-dump',
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        if (engine.adb === null) { writeJson(res, 500, { error: 'adb not found' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const serial = url.searchParams.get('serial') ?? ''
        const pid = Number(url.searchParams.get('pid'))
        const rawAddr = url.searchParams.get('address') ?? ''
        const addr = Number.parseInt(rawAddr.replace(/^0x/i, ''), 16)
        const len = Math.min(Math.max(Number(url.searchParams.get('length') ?? 256) || 256, 1), 65536)
        if (serial === '' || !engine.devices.has(serial) || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(addr) || addr < 0) {
          writeJson(res, 400, { error: 'serial + valid pid + address required' }); return
        }
        try {
          const hex = await dumpMemory(engine, serial, pid, addr, len)
          writeJson(res, 200, { pid, address: '0x' + addr.toString(16), hex })
        } catch (error) {
          writeJson(res, 200, { pid, address: '0x' + addr.toString(16), error: error instanceof Error ? error.message : String(error) })
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
          eventsStreaming: [...engine.eventsStreams.keys()],
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
          } else if (frame?.type === 'events' && typeof frame.serial === 'string') {
            // Panel toggles the per-device logcat -b events stream.
            engine.setEvents(frame.serial, frame.on === true)
            if (frame.on === true) {
              ws.send(JSON.stringify({ type: 'ehistory', serial: frame.serial, entries: engine.eventsRecent(frame.serial, 500) }))
            }
          } else if (frame?.type === 'screen' && typeof frame.serial === 'string') {
            // Panel toggles the per-device live screen stream (1fps screencap).
            engine.setScreen(frame.serial, frame.on === true)
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

/** The logcat_crash agent tool: find recent crash/ANR blocks with context. */
function logcatCrashTool(engine) {
  return defineTool({
    name: 'logcat_crash',
    description: 'Find recent Android crash/ANR blocks (FATAL EXCEPTION / ANR in / AndroidRuntime) in the buffered logcat, with surrounding context lines. ' +
      'Triggers: check whether the app crashed, get the exception stack for a crash.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      lines: { type: 'integer', description: 'Scan window into the ring buffer (default 2000, max 2000).' },
      context: { type: 'integer', description: 'Lines of context around each crash marker (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          crashes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ts: { type: 'string', required: true },
                pid: { type: 'integer', required: true },
                tag: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                lines: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const crashes = value?.crashes ?? []
        if (crashes.length === 0) return [{ type: 'text', text: '(no crash / ANR found in the scanned window)' }]
        const blocks = crashes.map((c) => `${c.ts} [${c.kind}] pid=${c.pid} ${c.tag}\n  ${c.summary}\n  ` + c.lines.join('\n  '))
        return [{ type: 'text', text: blocks.join('\n\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      if (serial === '') return { crashes: [] }
      const scan = Math.min(Math.max(Number(args.lines ?? 2000) || 2000, 1), 2000)
      const context = Math.min(Math.max(Number(args.context ?? 8) || 8, 0), 40)
      const entries = engine.recent(serial, scan)
      const MARKER = /FATAL EXCEPTION|ANR in |AndroidRuntime:/
      const crashes = []
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (!MARKER.test(e.raw)) continue
        const start = Math.max(0, i - context)
        const end = Math.min(entries.length, i + context + 1)
        const block = entries.slice(start, end)
        const first = block.find((b) => /FATAL EXCEPTION|ANR in /.test(b.raw)) ?? e
        crashes.push({
          ts: first.ts,
          pid: first.pid,
          tag: first.tag,
          kind: /ANR in /.test(first.raw) ? 'ANR' : 'FATAL',
          summary: first.msg.slice(0, 240),
          lines: block.map((b) => b.raw),
        })
        i = end - 1
      }
      return { crashes }
    },
  })
}

/** The device_info agent tool: structured device facts. */
function deviceInfoTool(engine) {
  return defineTool({
    name: 'device_info',
    description: 'Get structured info about an attached Android device (model, brand, Android version, SDK, resolution, ABI, total memory, battery) — ' +
      'for environment/version checks before debugging.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          model: { type: 'string' },
          brand: { type: 'string' },
          androidVersion: { type: 'string' },
          sdk: { type: 'string' },
          resolution: { type: 'string' },
          abi: { type: 'string' },
          totalMemKb: { type: 'integer' },
          batteryLevel: { type: 'integer' },
          batteryStatus: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const rows = ['model', 'brand', 'androidVersion', 'sdk', 'resolution', 'abi', 'totalMemKb', 'batteryLevel', 'batteryStatus']
          .filter((k) => value?.[k] !== undefined && value[k] !== '')
          .map((k) => `${k}: ${value[k]}`)
        return [{ type: 'text', text: rows.length > 0 ? rows.join('\n') : '(no device)' }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      if (serial === '' || engine.adb === null) return { serial: '' }
      const sh = 'getprop ro.product.model; getprop ro.product.brand; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.cpu.abi; wm size; grep MemTotal /proc/meminfo; dumpsys battery | grep -E "level:|status:"'
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', sh], 20000)
      const lines = (result.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const get = (i) => lines[i] ?? ''
      const memMatch = /MemTotal:\s*(\d+) kB/.exec(lines.find((l) => l.startsWith('MemTotal')) ?? '')
      const levelMatch = /level:\s*(\d+)/.exec(lines.find((l) => l.startsWith('level')) ?? '')
      const statusMatch = /status:\s*(\S+)/.exec(lines.find((l) => l.startsWith('status')) ?? '')
      return {
        serial,
        model: get(0) || undefined,
        brand: get(1) || undefined,
        androidVersion: get(2) || undefined,
        sdk: get(3) || undefined,
        abi: get(4) || undefined,
        resolution: (lines.find((l) => l.startsWith('Physical size')) ?? '').replace('Physical size: ', '') || undefined,
        totalMemKb: memMatch ? Number.parseInt(memMatch[1], 10) : undefined,
        batteryLevel: levelMatch ? Number.parseInt(levelMatch[1], 10) : undefined,
        batteryStatus: statusMatch?.[1] || undefined,
      }
    },
  })
}

/** The device_stats agent tool: one-shot CPU / memory / battery sample. */
function deviceStatsTool(engine) {
  return defineTool({
    name: 'device_stats',
    description: 'Take a one-shot sample of device CPU / memory / battery state — for performance and resource checks while debugging an app.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cpu: { type: 'string' },
          memTotalKb: { type: 'integer' },
          memFreeKb: { type: 'integer' },
          batteryLevel: { type: 'integer' },
          batteryStatus: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const rows = ['cpu', 'memTotalKb', 'memFreeKb', 'batteryLevel', 'batteryStatus']
          .filter((k) => value?.[k] !== undefined && value[k] !== '')
          .map((k) => `${k}: ${value[k]}`)
        return [{ type: 'text', text: rows.length > 0 ? rows.join('\n') : '(no device)' }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      if (serial === '' || engine.adb === null) return {}
      const sh = 'top -b -n 1 | head -4; grep -E "MemTotal|MemFree" /proc/meminfo; dumpsys battery | grep -E "level:|status:"'
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', sh], 20000)
      const lines = (result.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const cpu = lines.find((l) => /%cpu|Cpu\(s\)|CPU:/i.test(l)) ?? undefined
      const totalMatch = /MemTotal:\s*(\d+) kB/.exec(lines.find((l) => l.startsWith('MemTotal')) ?? '')
      const freeMatch = /MemFree:\s*(\d+) kB/.exec(lines.find((l) => l.startsWith('MemFree')) ?? '')
      const levelMatch = /level:\s*(\d+)/.exec(lines.find((l) => l.startsWith('level')) ?? '')
      const statusMatch = /status:\s*(\S+)/.exec(lines.find((l) => l.startsWith('status')) ?? '')
      return {
        cpu,
        memTotalKb: totalMatch ? Number.parseInt(totalMatch[1], 10) : undefined,
        memFreeKb: freeMatch ? Number.parseInt(freeMatch[1], 10) : undefined,
        batteryLevel: levelMatch ? Number.parseInt(levelMatch[1], 10) : undefined,
        batteryStatus: statusMatch?.[1] || undefined,
      }
    },
  })
}

/** Shared runner for `adb shell input ...` commands. */
function inputShellTool(engine, name, description, argSpec, buildCommand) {
  return defineTool({
    name,
    description,
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      ...argSpec,
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
        if (parts.length === 0) parts.push(value?.ok ? 'done' : `input failed (exit ${value?.code ?? '?'})`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      if (engine.adb === null) return { ok: false, code: null, stdout: '', stderr: 'adb not found on this host' }
      if (serial === '') return { ok: false, code: null, stdout: '', stderr: 'no attached device; connect and authorize one first' }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', buildCommand(args)], 15000)
      return { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
  })
}

/** The input_tap agent tool: simulate a tap. */
function inputTapTool(engine) {
  return inputShellTool(engine, 'input_tap',
    'Simulate a tap on the device screen at (x, y) — for UI automation flows. Combine with ui_dump to find element coordinates.',
    { x: { type: 'integer', description: 'X coordinate (pixels).' }, y: { type: 'integer', description: 'Y coordinate (pixels).' } },
    (a) => `input tap ${Number(a.x) | 0} ${Number(a.y) | 0}`)
}

/** The input_swipe agent tool: simulate a swipe. */
function inputSwipeTool(engine) {
  return inputShellTool(engine, 'input_swipe',
    'Simulate a swipe/drag on the device screen from (x1,y1) to (x2,y2), optionally with a duration in ms.',
    {
      x1: { type: 'integer', description: 'Start X.' }, y1: { type: 'integer', description: 'Start Y.' },
      x2: { type: 'integer', description: 'End X.' }, y2: { type: 'integer', description: 'End Y.' },
      duration: { type: 'integer', description: 'Duration in ms (optional, default 200).' },
    },
    (a) => `input swipe ${Number(a.x1) | 0} ${Number(a.y1) | 0} ${Number(a.x2) | 0} ${Number(a.y2) | 0} ${Math.max(Number(a.duration ?? 200) || 200, 0)}`)
}

/** The input_text agent tool: type text (spaces become %s, shell chars escaped). */
function inputTextTool(engine) {
  return inputShellTool(engine, 'input_text',
    'Type text into the focused field on the device (adb shell input text). Spaces are sent as %s; escape special characters as needed.',
    { text: { type: 'string', description: 'The text to type, e.g. "hello world".' } },
    (a) => {
      const raw = typeof a.text === 'string' ? a.text : ''
      const safe = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/ /g, '%s')
      return `input text "${safe}"`
    })
}

/** The ui_dump agent tool: dump the current UI hierarchy (uiautomator). */
function uiDumpTool(engine) {
  return defineTool({
    name: 'ui_dump',
    description: 'Dump the current UI hierarchy of the device screen as XML (uiautomator dump) — lets you see buttons/text/coordinates on screen for UI automation.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          xml: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.ok !== true || !value.xml) return [{ type: 'text', text: value?.error ?? '(dump failed)' }]
        const xml = value.xml
        const clipped = xml.length > 6000 ? xml.slice(0, 6000) + `\n… (truncated, full ${xml.length} chars)` : xml
        return [{ type: 'text', text: clipped }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      if (engine.adb === null) return { ok: false, error: 'adb not found on this host' }
      if (serial === '') return { ok: false, error: 'no attached device; connect and authorize one first' }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'uiautomator dump /sdcard/dsh-ui.xml >/dev/null 2>&1; cat /sdcard/dsh-ui.xml'], 30000)
      const xml = result.stdout.trim()
      if (result.ok && xml.startsWith('<?xml')) return { ok: true, xml }
      return { ok: false, error: (result.stderr || result.stdout || `dump failed (exit ${result.code ?? '?'})`).slice(0, 500) }
    },
  })
}

/** --------------------------------------------------- reverse-engineering */

/** The proc_list agent tool: structured process list. */
function procListTool(engine) {
  return defineTool({
    name: 'proc_list',
    description: 'List running processes on the device (pid, ppid, user, name) — find a process by name before reading its maps / memory.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      filter: { type: 'string', description: 'Optional case-insensitive substring to filter process names, e.g. "game" or "com.example".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pid: { type: 'integer', required: true },
                ppid: { type: 'integer' },
                user: { type: 'string' },
                name: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const list = value?.processes ?? []
        if (list.length === 0) return [{ type: 'text', text: '(no processes)' }]
        const lines = list.map((p) => `${String(p.pid).padStart(6)} ${(p.user ?? '?').padEnd(10)} ${p.name}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      if (serial === '' || engine.adb === null) return { processes: [] }
      const needle = (typeof args.filter === 'string' ? args.filter.trim() : '').toLowerCase()
      return { processes: await listProcesses(engine, serial, needle) }
    },
  })
}

/** The proc_maps agent tool: memory maps + module bases (reverse engineering core). */
function procMapsTool(engine) {
  return defineTool({
    name: 'proc_maps',
    description: 'Read /proc/<pid>/maps of a process and list memory-mapped modules (shared libraries, so bases) — ' +
      'the foundation for reverse engineering (find module base addresses, offsets, permissions). ' +
      'Note: reading other apps\' maps needs root or a debuggable/rooted device; own-process reads work via run-as on debuggable apps.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      pid: { type: 'integer', description: 'Process id (from proc_list).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer', required: true },
          modules: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                base: { type: 'string', required: true },
                end: { type: 'string' },
                perms: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const mods = value?.modules ?? []
        if (mods.length === 0) return [{ type: 'text', text: `(pid ${value?.pid ?? '?'}: no file-backed mappings)` }]
        const lines = mods.map((m) => `${m.base}${m.end ? '-' + m.end : ''} ${(m.perms ?? '').padEnd(4)} ${m.path}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      const pid = Number(args.pid)
      if (serial === '' || engine.adb === null || !Number.isInteger(pid) || pid <= 0) return { pid: 0, modules: [], error: 'a valid pid is required' }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', `cat /proc/${pid}/maps 2>&1`], 20000)
      if (!result.ok || result.stderr.includes('Permission denied') || /Permission denied|No such file/.test(result.stdout)) {
        return { pid, modules: [], error: `cannot read /proc/${pid}/maps (need root, or a debuggable app via run-as); output: ${(result.stdout || result.stderr).slice(0, 200)}` }
      }
      const seen = new Set()
      const modules = []
      for (const line of (result.stdout ?? '').split(/\r?\n/)) {
        const m = /^([0-9a-f]+)-([0-9a-f]+)\s+([rwxps-]{4})\s+[0-9a-f]+\s+\S+\s+\d+\s+(.+)$/.exec(line)
        if (m === null) continue
        const path = m[4]
        if (!path.startsWith('/')) continue
        if (seen.has(path)) continue
        seen.add(path)
        modules.push({ base: m[1], end: m[2], perms: m[3], path })
      }
      return { pid, modules }
    },
  })
}

/** The proc_status agent tool: /proc/<pid>/status summary + smaps totals. */
function procStatusTool(engine) {
  return defineTool({
    name: 'proc_status',
    description: 'Read /proc/<pid>/status (state, uid, vm usage, threads) plus smaps Pss totals of a process — memory footprint analysis.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      pid: { type: 'integer', description: 'Process id (from proc_list).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer', required: true },
          name: { type: 'string' },
          state: { type: 'string' },
          uid: { type: 'string' },
          vmSizeKb: { type: 'integer' },
          vmRssKb: { type: 'integer' },
          threads: { type: 'integer' },
          pssKb: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const rows = ['name', 'state', 'uid', 'vmSizeKb', 'vmRssKb', 'threads', 'pssKb']
          .filter((k) => value?.[k] !== undefined)
          .map((k) => `${k}: ${value[k]}`)
        return [{ type: 'text', text: rows.length > 0 ? rows.join('\n') : `(pid ${value?.pid ?? '?'}: no data)` }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      const pid = Number(args.pid)
      if (serial === '' || engine.adb === null || !Number.isInteger(pid) || pid <= 0) return { pid: 0, error: 'a valid pid is required' }
      const sh = `cat /proc/${pid}/status 2>&1; echo ===SMAPS===; awk '/^Pss:/ {s+=$2} END {print s}' /proc/${pid}/smaps 2>/dev/null; true`
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', sh], 20000)
      if (!result.ok || result.stdout.trim() === '' || /No such file|No such process/.test(result.stdout)) {
        return { pid, error: `cannot read /proc/${pid} (need root or debuggable app); output: ${(result.stdout || result.stderr).slice(0, 200)}` }
      }
      const [statusText, , smapsOut] = result.stdout.split(/\r?\n===SMAPS===\r?\n|\n===SMAPS===\n/)
      const field = (k) => { const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(statusText ?? ''); return m ? m[1].trim() : undefined }
      const kb = (k) => { const v = field(k); return v ? Number.parseInt(v, 10) || undefined : undefined }
      return {
        pid,
        name: field('Name'),
        state: field('State'),
        uid: field('Uid'),
        vmSizeKb: kb('VmSize'),
        vmRssKb: kb('VmRSS'),
        threads: kb('Threads'),
        pssKb: Number.parseInt((smapsOut ?? '').trim(), 10) || undefined,
      }
    },
  })
}

/** The mem_dump agent tool: read raw memory at an address (hex). */
function memDumpTool(engine) {
  return defineTool({
    name: 'mem_dump',
    description: 'Dump raw memory of a process at a given address as hex (via /proc/<pid>/mem) — for reverse engineering. ' +
      'Requires root on most devices (or a debuggable app via run-as). Address in hex, length in bytes (max 65536, default 256).',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      pid: { type: 'integer', description: 'Process id (from proc_list).' },
      address: { type: 'string', description: 'Start address in hex, e.g. "0x7a0000" or "7a0000".' },
      length: { type: 'integer', description: 'Bytes to read (default 256, max 65536).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer', required: true },
          address: { type: 'string' },
          hex: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        return [{ type: 'text', text: value?.hex ? `pid ${value.pid} @ ${value.address}:\n${value.hex}` : '(no data)' }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      const pid = Number(args.pid)
      const rawAddr = typeof args.address === 'string' ? args.address.trim() : ''
      const addr = Number.parseInt(rawAddr.replace(/^0x/i, ''), 16)
      const len = Math.min(Math.max(Number(args.length ?? 256) || 256, 1), 65536)
      if (serial === '' || engine.adb === null || !Number.isInteger(pid) || pid <= 0) return { pid: 0, error: 'a valid pid is required' }
      if (!Number.isFinite(addr) || addr < 0) return { pid, error: `invalid address: ${rawAddr}` }
      try {
        const hex = await dumpMemory(engine, serial, pid, addr, len)
        return { pid, address: '0x' + addr.toString(16), hex }
      } catch (error) {
        return { pid, address: '0x' + addr.toString(16), error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The frida_server agent tool: deploy / start / stop frida-server. */
function fridaServerTool(engine) {
  return defineTool({
    name: 'frida_server',
    description: 'Manage frida-server on the device for dynamic instrumentation (reverse engineering): ' +
      'status (is it deployed/running), start (push a local frida-server binary and run it), stop (kill it). ' +
      'The frida-server binary must match the device ABI (arm64/arm/x86) — get it from the frida releases page.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      action: { type: 'string', enum: ['status', 'start', 'stop'], description: 'What to do: status / start / stop.' },
      localPath: { type: 'string', description: 'Absolute local path of the frida-server binary (required for start), e.g. "F:/tools/frida-server-16.5.5-android-arm64".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          running: { type: 'boolean' },
          pid: { type: 'integer' },
          output: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const parts = []
        if (value?.running !== undefined) parts.push(`running: ${value.running}${value.pid ? ` (pid ${value.pid})` : ''}`)
        if (value?.output) parts.push(value.output.trimEnd())
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : `ok: ${value?.ok}` }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const action = typeof args.action === 'string' ? args.action : 'status'
      if (engine.adb === null) return { ok: false, error: 'adb not found on this host' }
      if (serial === '') return { ok: false, error: 'no attached device; connect and authorize one first' }
      if (action === 'start') {
        const localPath = typeof args.localPath === 'string' ? args.localPath.trim() : ''
        if (localPath === '' || !existsSync(localPath)) return { ok: false, error: `frida-server binary not found: ${localPath || '(none given)'}` }
        const push = await runAdbFull(engine.adb, ['-s', serial, 'push', localPath, '/data/local/tmp/frida-server'], 120000)
        if (!push.ok) return { ok: false, error: `push failed: ${(push.stderr || push.stdout).slice(0, 200)}` }
        await runAdbFull(engine.adb, ['-s', serial, 'shell', 'chmod 755 /data/local/tmp/frida-server'], 10000)
        const start = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'nohup /data/local/tmp/frida-server >/dev/null 2>&1 &'], 10000)
        if (!start.ok) return { ok: false, error: `start failed: ${(start.stderr || start.stdout).slice(0, 200)}` }
        const check = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'ps -A | grep frida-server | head -1'], 10000)
        const m = /^\s*(\d+)/.exec(check.stdout ?? '')
        return { ok: true, running: m !== null, pid: m ? Number.parseInt(m[1], 10) : undefined, output: 'frida-server started' }
      }
      if (action === 'stop') {
        const stop = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'pkill -f frida-server; echo stopped'], 10000)
        return { ok: stop.ok, running: false, output: 'frida-server stopped' }
      }
      // status
      const exists = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'ls -l /data/local/tmp/frida-server 2>&1'], 10000)
      const running = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'ps -A | grep frida-server | head -1'], 10000)
      const m = /^\s*(\d+)/.exec(running.stdout ?? '')
      return {
        ok: true,
        running: m !== null,
        pid: m ? Number.parseInt(m[1], 10) : undefined,
        output: `deployed: ${exists.ok ? 'yes' : 'no'}\n` + ((running.stdout ?? '').trim() || 'not running'),
      }
    },
  })
}

/** The mem_search agent tool: search process memory for a byte pattern. */
function memSearchTool(engine) {
  return defineTool({
    name: 'mem_search',
    description: 'Search a process\'s memory for a byte pattern — plain ASCII string or hex bytes ("hex:48656c6c6f") — and return byte offsets. ' +
      'Requires root (or a debuggable app via run-as). Scans with grep -aob over /proc/<pid>/mem; very large processes can be slow.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      pid: { type: 'integer', description: 'Process id (from proc_list).' },
      pattern: { type: 'string', description: 'Pattern to search: ASCII string ("hello") or hex bytes ("hex:48656c6c6f").' },
      maxResults: { type: 'integer', description: 'Max matches to return (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer', required: true },
          pattern: { type: 'string' },
          offsets: { type: 'array', required: true, items: { type: 'integer' } },
          truncated: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const offs = value?.offsets ?? []
        if (offs.length === 0) return [{ type: 'text', text: `(no match for "${value?.pattern ?? ''}" in pid ${value?.pid ?? '?'})` }]
        const hex = offs.map((o) => '0x' + o.toString(16)).join('\n')
        return [{ type: 'text', text: `pattern "${value.pattern}" in pid ${value.pid}:\n${hex}${value.truncated ? '\n(truncated)' : ''}` }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      const pid = Number(args.pid)
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      const max = Math.min(Math.max(Number(args.maxResults ?? 20) || 20, 1), 200)
      if (serial === '' || engine.adb === null || !Number.isInteger(pid) || pid <= 0) return { pid: 0, offsets: [], error: 'a valid pid is required' }
      if (pattern === '') return { pid, offsets: [], error: 'pattern is required (string or hex:...)' }
      try {
        const { offsets, truncated } = await searchMemory(engine, serial, pid, pattern, max)
        return { pid, pattern, offsets, truncated }
      } catch (error) {
        return { pid, pattern, offsets: [], error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The proc_smaps agent tool: per-region memory detail (top Pss regions). */
function procSmapsTool(engine) {
  return defineTool({
    name: 'proc_smaps',
    description: 'Read /proc/<pid>/smaps and return the top memory regions by Pss (size/rss/pss per mapping) — detailed memory footprint analysis. ' +
      'Requires root or matching permissions.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      pid: { type: 'integer', description: 'Process id (from proc_list).' },
      top: { type: 'integer', description: 'Number of top regions to return (default 10, max 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer', required: true },
          regions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                start: { type: 'string', required: true },
                end: { type: 'string' },
                perms: { type: 'string' },
                path: { type: 'string' },
                sizeKb: { type: 'integer' },
                rssKb: { type: 'integer' },
                pssKb: { type: 'integer' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const regs = value?.regions ?? []
        if (regs.length === 0) return [{ type: 'text', text: `(pid ${value?.pid ?? '?'}: no regions)` }]
        const lines = regs.map((r) => `${r.start}${r.end ? '-' + r.end : ''} ${(r.perms ?? '').padEnd(4)} pss=${r.pssKb ?? '?'}kB rss=${r.rssKb ?? '?'}kB ${r.path ?? ''}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      const pid = Number(args.pid)
      const top = Math.min(Math.max(Number(args.top ?? 10) || 10, 1), 50)
      if (serial === '' || engine.adb === null || !Number.isInteger(pid) || pid <= 0) return { pid: 0, regions: [], error: 'a valid pid is required' }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', `cat /proc/${pid}/smaps 2>&1; true`], 30000)
      const text = result.stdout ?? ''
      if (!result.ok || /Permission denied|No such file|No such process/.test(text) || text.trim() === '') {
        return { pid, regions: [], error: `cannot read /proc/${pid}/smaps (need root or matching perms); output: ${text.slice(0, 200)}` }
      }
      const regions = []
      let current = null
      for (const line of text.split(/\r?\n/)) {
        const header = /^([0-9a-f]+)-([0-9a-f]+)\s+([rwxps-]{4})\s+\S+\s+\S+\s+\d+\s*(.*)$/.exec(line)
        if (header !== null) {
          current = { start: header[1], end: header[2], perms: header[3], path: header[4] ?? '', sizeKb: 0, rssKb: 0, pssKb: 0 }
          regions.push(current)
          continue
        }
        if (current === null) continue
        const field = /^(Size|Rss|Pss):\s+(\d+) kB$/.exec(line.trim())
        if (field !== null) {
          if (field[1] === 'Size') current.sizeKb = Number.parseInt(field[2], 10)
          else if (field[1] === 'Rss') current.rssKb = Number.parseInt(field[2], 10)
          else current.pssKb = Number.parseInt(field[2], 10)
        }
      }
      const topRegions = regions
        .filter((r) => r.pssKb > 0)
        .sort((a, b) => b.pssKb - a.pssKb)
        .slice(0, top)
        .map(({ start, end, perms, path, sizeKb, rssKb, pssKb }) => ({ start, end, perms, path, sizeKb, rssKb, pssKb }))
      return { pid, regions: topRegions }
    },
  })
}

/** frida script templates (reverse engineering quick starts). */
const FRIDA_TEMPLATES = {
  hook_method: (target, method) => `// hook_method: log args + return of a Java method
// usage: frida -U -f <package> -l hook.js   (or attach to a running app)
Java.perform(function () {
  var clsName = "${target ?? 'com.example.Class'}";
  var methodName = "${method ?? 'method'}";
  var cls = Java.use(clsName);
  cls[methodName].overloads.forEach(function (ov) {
    ov.implementation = function () {
      var args = Array.prototype.slice.call(arguments).map(String).join(", ");
      console.log("[" + clsName + "." + methodName + "] called(" + args + ")");
      var ret = ov.apply(this, arguments);
      console.log("[" + clsName + "." + methodName + "] => " + ret);
      return ret;
    };
  });
  console.log("[*] hooked " + clsName + "." + methodName);
});`,
  trace_native: (target) => `// trace_native: trace a native export, target "libfoo.so!func"
var spec = "${target ?? 'libfoo.so!func'}";
var sep = spec.indexOf("!");
if (sep < 0) { console.log("usage: lib.so!func"); throw 0; }
var moduleName = spec.slice(0, sep);
var funcName = spec.slice(sep + 1);
var base = Module.findBaseAddress(moduleName);
if (!base) { console.log("[!] module not loaded: " + moduleName); throw 0; }
var addr = Module.findExportByName(moduleName, funcName);
if (!addr) { console.log("[!] export not found: " + funcName); throw 0; }
Interceptor.attach(addr, {
  onEnter: function (args) {
    var a = [];
    for (var i = 0; i < 8; i++) a.push(args[i]);
    console.log("[+] " + funcName + "(" + a.join(", ") + ")");
  },
  onLeave: function (retval) { console.log("[+] " + funcName + " => " + retval); }
});
console.log("[*] tracing " + spec + " @ " + addr);`,
  scan_memory: (target) => `// scan_memory: scan all modules for a hex pattern ("hex:48 65 6c 6c 6f" or raw hex)
var pattern = "${target ?? 'hex:48 65 6c 6c 6f'}";
if (pattern.indexOf("hex:") === 0) pattern = pattern.slice(4);
var bytes = pattern.split(/\\s+/).filter(Boolean).map(function (b) { return parseInt(b, 16); });
if (bytes.some(function (b) { return isNaN(b); })) { console.log("[!] bad hex pattern"); throw 0; }
Process.enumerateModules().forEach(function (m) {
  try {
    Memory.scan(m.base, m.size, bytes, {
      onMatch: function (addr, size) {
        console.log("found @ " + addr + " in " + m.name + " (+0x" + addr.sub(m.base).toString(16) + ")");
      },
      onComplete: function () {}
    });
  } catch (e) {}
});
console.log("[*] scanning " + Process.enumerateModules().length + " modules");`,
  bypass_debug: () => `// bypass_debug: basic anti-debug / anti-frida helpers
// 1) observe ptrace (self-attach tricks), 2) hide common frida markers
var ptrace = Module.findExportByName(null, "ptrace");
if (ptrace) {
  Interceptor.attach(ptrace, {
    onEnter: function (args) { console.log("[*] ptrace called, request=" + args[0]); },
    onLeave: function (retval) { if (retval.toInt32() === -1) console.log("[*] ptrace denied (anti-debug active)"); }
  });
}
try {
  Java.perform(function () {
    // neutralize common "is frida running" checks by spamming hooks is out of scope;
    // this template focuses on ptrace observation.
  });
} catch (e) {}
console.log("[*] basic anti-debug helpers installed (ptrace observer)");`,
  dump_class: (target) => `// dump_class: list methods and fields of a Java class
Java.perform(function () {
  var clsName = "${target ?? 'com.example.Class'}";
  var cls = Java.use(clsName);
  console.log("[*] " + clsName + " methods:");
  cls.class.getDeclaredMethods().forEach(function (m) { console.log("  " + m.toString()); });
  console.log("[*] fields:");
  cls.class.getDeclaredFields().forEach(function (f) { console.log("  " + f.toString()); });
});`,
}

/** The frida_script agent tool: generate ready-to-use frida scripts. */
function fridaScriptTool(engine) {
  return defineTool({
    name: 'frida_script',
    description: 'Generate a ready-to-use frida JavaScript script from a built-in template (hook_method / trace_native / scan_memory / bypass_debug / dump_class) ' +
      'and optionally write it to a local file, then use with frida_server + "frida -U -f <pkg> -l <script>".',
    parameters: {
      template: { type: 'string', enum: ['hook_method', 'trace_native', 'scan_memory', 'bypass_debug', 'dump_class'], description: 'Which template to generate.' },
      target: { type: 'string', description: 'Template-specific target: class name (hook_method/dump_class), "lib.so!func" (trace_native), hex pattern (scan_memory).' },
      method: { type: 'string', description: 'Method name for hook_method (optional; hooks the given method of the target class).' },
      output: { type: 'string', description: 'Optional local file path to write the script to, e.g. "F:/tools/hook.js".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          script: { type: 'string', required: true },
          wroteTo: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        return [{ type: 'text', text: value?.script ?? '' }]
      },
    },
    async execute(args) {
      const template = typeof args.template === 'string' ? args.template : ''
      const target = typeof args.target === 'string' ? args.target.trim() : ''
      const method = typeof args.method === 'string' ? args.method.trim() : ''
      const generator = FRIDA_TEMPLATES[template]
      if (generator === undefined) {
        return { script: '', error: `unknown template: ${template}; pick one of ${Object.keys(FRIDA_TEMPLATES).join(' / ')}` }
      }
      const script = generator(target || undefined, method || undefined)
      const output = typeof args.output === 'string' ? args.output.trim() : ''
      if (output !== '') {
        try {
          const { writeFileSync, mkdirSync } = await import('node:fs')
          mkdirSync(dirname(output), { recursive: true })
          writeFileSync(output, script, 'utf8')
          return { script, wroteTo: output }
        } catch (error) {
          return { script, error: `failed to write ${output}: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      return { script }
    },
  })
}

/** ------------------------------------------------- new tools (0.6.0) */

/** Strip internal raw/cont fields for strict agent output schemas. */
function logEntryToOutput(list) {
  return list.map((e) => ({ ts: e.ts, pid: e.pid, tid: e.tid, level: e.level, tag: e.tag, msg: e.msg }))
}

/** The logcat_history agent tool: read on-disk log history (persistence). */
function logcatHistoryTool(engine) {
  return defineTool({
    name: 'logcat_history',
    description: 'Read historical logcat entries from disk (dsh-logcat persists every line to ~/.dsh/logcat/logs, so history survives GUI restarts and covers time before the plugin attached). ' +
      'Merges disk history with the live ring buffer (no duplicates), newest last. Triggers: logs from earlier / before this session, look back in time.',
    parameters: {
      serial: { type: 'string', description: 'Device serial (may be an offline device with saved history; optional, defaults to the first attached device).' },
      lines: { type: 'integer', description: 'Max entries to return (default 1000, max 5000).' },
      level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: 'Minimum severity filter.' },
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
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const entries = value?.entries ?? []
        if (entries.length === 0) return [{ type: 'text', text: '(no history)' }]
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
      const lines = Math.min(Math.max(Number(args.lines ?? 1000) || 1000, 1), 5000)
      const level = typeof args.level === 'string' ? args.level : ''
      const filter = typeof args.filter === 'string' ? args.filter : ''
      try {
        const entries = await engine.history(serial, lines, level, filter)
        return { entries: logEntryToOutput(entries) }
      } catch {
        return { entries: [], note: 'failed to read history from disk' }
      }
    },
  })
}

/** The crash_sessions agent tool: list auto-captured crash snapshots. */
function crashSessionsTool(engine) {
  return defineTool({
    name: 'crash_sessions',
    description: 'List auto-captured crash/ANR snapshots — dsh-logcat saves a screenshot + log context to ~/.dsh/logcat/crashes whenever a FATAL EXCEPTION / ANR appears in the stream. ' +
      'Use to review crashes that happened while the plugin was attached. Triggers: check crash history, what crashed earlier, get saved crash context.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      limit: { type: 'integer', description: 'Max sessions to return (default 20, max 100).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          crashes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                ts: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                pid: { type: 'integer' },
                summary: { type: 'string' },
                hasScreenshot: { type: 'boolean' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const crashes = value?.crashes ?? []
        if (crashes.length === 0) return [{ type: 'text', text: '(no saved crash snapshots yet)' }]
        const lines = crashes.map((c) => `${c.ts} [${c.kind}] pid=${c.pid ?? '?'} ${c.hasScreenshot ? '[shot]' : '[no shot]'} ${c.summary}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      if (serial === '') return { crashes: [], error: 'no device; pass a serial that has saved snapshots' }
      const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100)
      try {
        const all = await engine.listCrashes(serial)
        return { crashes: all.slice(0, limit).map(({ id, ts, kind, pid, summary, hasScreenshot }) => ({ id, ts, kind, pid, summary, hasScreenshot })) }
      } catch (error) {
        return { crashes: [], error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The logcat_events agent tool: read the Android events buffer. */
function logcatEventsTool(engine) {
  return defineTool({
    name: 'logcat_events',
    description: 'Read the Android events buffer (logcat -b events) — system event tags like am_* (app start/stop/crash), activity lifecycle, input events. ' +
      'Dumps on demand; the Logcat panel\'s events view keeps a live stream. Triggers: app lifecycle events, activity launch/crash events, am_* events.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      lines: { type: 'integer', description: 'Max entries to return (default 200, max 2000).' },
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
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const entries = value?.entries ?? []
        if (entries.length === 0) return [{ type: 'text', text: '(no events entries)' }]
        const lines = entries.map((e) => `${e.ts} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${e.level !== '' ? e.level : ' '} ${e.tag.padEnd(18)} : ${e.msg}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== '' ? args.serial : devices[0]?.serial ?? ''
      if (serial === '' || engine.adb === null) return { entries: [] }
      const lines = Math.min(Math.max(Number(args.lines ?? 200) || 200, 1), 2000)
      const filter = typeof args.filter === 'string' ? args.filter : ''
      let entries = engine.eventsRecent(serial, lines, filter)
      if (entries.length === 0) {
        // No live stream data yet — prime once with a one-shot dump.
        const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', `logcat -d -b events -v threadtime -t ${lines}`], 20000)
        if (result.ok) {
          const parsed = (result.stdout ?? '').split(/\r?\n/).map(parseLogcatLine).filter(Boolean)
          const needle = filter.trim().toLowerCase()
          const picked = parsed.filter((e) => needle === '' || e.raw.toLowerCase().includes(needle))
          entries = picked.slice(-lines)
        }
      }
      return { entries: logEntryToOutput(entries) }
    },
  })
}

/** The app_info agent tool: installed-app version facts. */
function appInfoTool(engine) {
  return defineTool({
    name: 'app_info',
    description: 'Get info about an installed app on a device: version name, version code, APK path (dumpsys package + pm path). ' +
      'Use to check whether the installed build matches the latest one. Triggers: check installed app version, verify deployment.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      package: { type: 'string', description: 'The app package, e.g. "com.example.app".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          installed: { type: 'boolean' },
          versionName: { type: 'string' },
          versionCode: { type: 'integer' },
          path: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const rows = ['versionName', 'versionCode', 'path'].filter((k) => value?.[k] !== undefined && value[k] !== '')
        const text = rows.map((k) => `${k}: ${value[k]}`).join('\n')
        return [{ type: 'text', text: value?.installed ? `installed: yes\n${text}` : 'installed: no' }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const pkg = (typeof args.package === 'string' ? args.package : '').trim().replace(/'/g, '')
      if (engine.adb === null) return { ok: false, error: 'adb not found on this host' }
      if (serial === '') return { ok: false, error: 'no attached device; connect and authorize one first' }
      if (pkg === '') return { ok: false, error: 'package is required' }
      const sh = `dumpsys package '${pkg}' | grep -E "^\\s+versionName=|^\\s+versionCode=" ; pm path '${pkg}'`
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', sh], 20000)
      const out = result.stdout ?? ''
      const pathMatch = /package:(\S+)/.exec(out)
      const codeMatch = /versionCode=(\d+)/.exec(out)
      const nameMatch = /versionName=(\S+)/.exec(out)
      const installed = pathMatch !== null || (result.ok && out.includes(pkg))
      return {
        ok: result.ok,
        installed,
        versionName: nameMatch?.[1] || undefined,
        versionCode: codeMatch ? Number.parseInt(codeMatch[1], 10) : undefined,
        path: pathMatch?.[1] || undefined,
      }
    },
  })
}

/** The activity_current agent tool: currently focused activity. */
function activityCurrentTool(engine) {
  return defineTool({
    name: 'activity_current',
    description: 'Get the currently focused/resumed activity of the device (dumpsys activity activities) — know what screen the app is on for UI automation.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activity: { type: 'string' },
          package: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        return [{ type: 'text', text: value?.activity ? `activity: ${value.activity}${value.package ? `\npackage: ${value.package}` : ''}` : '(no focused activity found)' }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      if (engine.adb === null) return { error: 'adb not found on this host' }
      if (serial === '') return { error: 'no attached device; connect and authorize one first' }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', 'dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -1'], 20000)
      const line = (result.stdout ?? '').split(/\r?\n/).find((l) => /mResumedActivity|topResumedActivity/.test(l)) ?? ''
      const m = /ActivityRecord\{[^}]*\s+u\d+\s+([^\s}]+)/.exec(line)
      if (m === null) return { error: (result.stdout || result.stderr || '(no focused activity)').slice(0, 200) }
      const component = m[1]
      const [pkg, act] = component.split('/')
      return { activity: component, package: pkg ?? undefined }
    },
  })
}

/** The input_keyevent agent tool: send hardware key events. */
function inputKeyeventTool(engine) {
  return defineTool({
    name: 'input_keyevent',
    description: 'Send a hardware key event to the device (adb shell input keyevent) — home / back / recents / enter / volume / power / wakeup etc. ' +
      'For UI automation and screen control. Keys: ' + Object.keys(KEYCODES).join(', ') + '.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      key: { type: 'string', enum: Object.keys(KEYCODES), description: 'Named key to press.' },
      code: { type: 'integer', description: 'Alternative: raw Android keycode integer (overrides key).' },
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
        if (parts.length === 0) parts.push(value?.ok ? `keyevent ${value?.code ?? '?'} sent` : `keyevent failed (exit ${value?.code ?? '?'})`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const key = typeof args.key === 'string' ? args.key : ''
      const code = Number.isInteger(args.code) ? args.code : KEYCODES[key]
      if (engine.adb === null) return { ok: false, code: null, stdout: '', stderr: 'adb not found on this host' }
      if (serial === '') return { ok: false, code: null, stdout: '', stderr: 'no attached device; connect and authorize one first' }
      if (!Number.isInteger(code) || code <= 0) return { ok: false, code: null, stdout: '', stderr: `unknown key: ${key || '(none)'}` }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', `input keyevent ${code}`], 15000)
      return { ok: result.ok, code, stdout: result.stdout, stderr: result.stderr }
    },
  })
}

/** The app_launch agent tool: start an app (resolves the launcher activity). */
function appLaunchTool(engine) {
  return defineTool({
    name: 'app_launch',
    description: 'Launch an installed app on the device (am start). Resolves the launcher activity automatically when not given. ' +
      'Triggers: start the app under test, open an app for UI automation.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      package: { type: 'string', description: 'The app package, e.g. "com.example.app".' },
      activity: { type: 'string', description: 'Optional explicit component "pkg/.Activity" (defaults to the launcher activity).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          component: { type: 'string' },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const parts = []
        if (value?.component) parts.push('component: ' + value.component)
        if (value?.stdout) parts.push(value.stdout.trimEnd())
        if (value?.stderr) parts.push('stderr: ' + value.stderr.trimEnd())
        if (parts.length === 0) parts.push(value?.ok ? 'launched' : `launch failed (exit ${value?.code ?? '?'})`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const pkg = (typeof args.package === 'string' ? args.package : '').trim().replace(/'/g, '')
      let component = (typeof args.activity === 'string' ? args.activity : '').trim().replace(/'/g, '')
      if (engine.adb === null) return { ok: false, stdout: '', stderr: 'adb not found on this host' }
      if (serial === '') return { ok: false, stdout: '', stderr: 'no attached device; connect and authorize one first' }
      if (pkg === '') return { ok: false, stdout: '', stderr: 'package is required' }
      if (component === '' || !component.includes('/')) {
        const res = await runAdbFull(engine.adb, ['-s', serial, 'shell', `cmd package resolve-activity --brief '${pkg}' | tail -1`], 20000)
        const line = (res.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find((l) => l.includes('/'))
        if (line === undefined) return { ok: false, stdout: '', stderr: `cannot resolve launcher activity for ${pkg} (is it installed?)` }
        component = line
      }
      const start = await runAdbFull(engine.adb, ['-s', serial, 'shell', `am start -n '${component}'`], 20000)
      return { ok: start.ok, component, stdout: start.stdout, stderr: start.stderr }
    },
  })
}

/** The app_stop agent tool: force-stop an app. */
function appStopTool(engine) {
  return defineTool({
    name: 'app_stop',
    description: 'Force-stop an app on the device (am force-stop) — ends its process and current state. ' +
      'DESTRUCTIVE to the app\'s runtime state (it restarts cold): confirm intent before use.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      package: { type: 'string', description: 'The app package, e.g. "com.example.app".' },
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
        if (parts.length === 0) parts.push(value?.ok ? 'stopped' : `stop failed (exit ${value?.code ?? '?'})`)
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      const pkg = (typeof args.package === 'string' ? args.package : '').trim().replace(/'/g, '')
      if (engine.adb === null) return { ok: false, code: null, stdout: '', stderr: 'adb not found on this host' }
      if (serial === '') return { ok: false, code: null, stdout: '', stderr: 'no attached device; connect and authorize one first' }
      if (pkg === '') return { ok: false, code: null, stdout: '', stderr: 'package is required' }
      const result = await runAdbFull(engine.adb, ['-s', serial, 'shell', `am force-stop '${pkg}'`], 15000)
      return { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
  })
}

/** The screen_capture agent tool: one-shot screenshot for multimodal flows. */
function screenCaptureTool(ctx, engine) {
  return defineTool({
    name: 'screen_capture',
    description: 'Capture the device screen as a PNG — saved to a local file, and embedded into the conversation as an image block so a multimodal model can see the screen (deployment permitting). ' +
      'Pair with input_tap / input_swipe / input_text / input_keyevent for visual debugging loops. Triggers: see the phone screen, screenshot for bug analysis.',
    parameters: {
      serial: { type: 'string', description: 'Device serial from logcat_devices (optional; defaults to the first attached device).' },
      path: { type: 'string', description: 'Optional local file path to save the PNG (default ~/.dsh/logcat/screens/<serial>-<ts>.png).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          size: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          embedded: { type: 'boolean' },
          embeddedRef: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value?.error) return [{ type: 'text', text: value.error }]
        const blocks = []
        if (value?.embeddedRef !== undefined && value?.embeddedRef !== null) {
          blocks.push({ type: 'image', attachment: value.embeddedRef })
        }
        const parts = [`screen captured: ${value?.path ?? '?'} (${value?.size ?? 0} bytes, ${value?.width ?? '?'}x${value?.height ?? '?'})`]
        if (value?.embedded === true) parts.push('(image embedded in this result)')
        blocks.push({ type: 'text', text: parts.join('\n') })
        return blocks
      },
    },
    async execute(args) {
      const devices = engine.deviceList()
      const serial = typeof args.serial === 'string' && args.serial !== ''
        ? args.serial
        : devices.find((d) => d.state === 'device')?.serial ?? ''
      if (engine.adb === null) return { ok: false, error: 'adb not found on this host' }
      if (serial === '') return { ok: false, error: 'no attached device; connect and authorize one first' }
      try {
        const png = await runAdbBinary(engine.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], 15000)
        const screensRoot = join(engine.logRoot, 'screens')
        mkdirSync(screensRoot, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const rel = `${engine.safeName(serial)}-${stamp}.png`
        const file = typeof args.path === 'string' && args.path.trim() !== ''
          ? args.path.trim()
          : join(screensRoot, rel)
        await fsp.writeFile(file, png)
        // PNG intrinsic dimensions from the IHDR chunk (bytes 16-23).
        let width
        let height
        if (png.length > 24 && png[0] === 0x89) {
          width = png.readUInt32BE(16)
          height = png.readUInt32BE(20)
        }
        // Embed into the conversation through the attachment service when available.
        let embeddedRef = null
        try {
          const store = typeof ctx.attachments?.saveImage === 'function' ? ctx.attachments : null
          if (store !== null) {
            const ref = await store.saveImage({ data: png, mediaType: 'image/png', name: rel })
            embeddedRef = {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
            }
          }
        } catch { /* attachment embed is best-effort */ }
        return {
          ok: true,
          path: file,
          size: png.length,
          width,
          height,
          embedded: embeddedRef !== null,
          embeddedRef,
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
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
      eventsStreaming: [...engine.eventsStreams.keys()],
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
    void ensureVersionCheck()
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
        logcatCrashTool(engine),
        logcatHistoryTool(engine),
        crashSessionsTool(engine),
        logcatEventsTool(engine),
        appInfoTool(engine),
        activityCurrentTool(engine),
        inputKeyeventTool(engine),
        appLaunchTool(engine),
        appStopTool(engine),
        screenCaptureTool(ctx, engine),
        deviceInfoTool(engine),
        deviceStatsTool(engine),
        inputTapTool(engine),
        inputSwipeTool(engine),
        inputTextTool(engine),
        uiDumpTool(engine),
        procListTool(engine),
        procMapsTool(engine),
        procStatusTool(engine),
        memDumpTool(engine),
        fridaServerTool(engine),
        memSearchTool(engine),
        procSmapsTool(engine),
        fridaScriptTool(engine),
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
