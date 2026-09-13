/**
 * Build the long-lived input injector into lib/injector-jar.js.
 *
 * Why this exists: the stock `input` command boots a fresh app_process (Java VM) on every
 * call — measured ~480ms on the reference device — which made the panel's touch controls
 * feel sluggish. The injector boots once and streams gestures over stdin instead, at a few
 * milliseconds per gesture. Its dex is embedded as base64 so the host can deploy it with a
 * single shell write (no `adb push`, whose sync protocol drops out on flaky USB links).
 *
 * Requirements: a JDK (`javac`) and Android SDK build-tools (`d8`) plus a platform android.jar.
 * Override discovery with ANDROID_HOME / ANDROID_SDK_ROOT if needed.
 *
 * Usage: node tools/injector/build.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const source = join(root, 'tools', 'injector', 'Injector.java')
const output = join(root, 'lib', 'injector-jar.js')
const work = join(root, 'tmp-injector-build')

const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
  join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'), join(homedir(), 'Android', 'Sdk')].filter(Boolean)
const sdk = sdkRoots.find((dir) => existsSync(join(dir, 'platforms')))
if (sdk === undefined) {
  console.error('Android SDK not found. Set ANDROID_HOME to your SDK root.')
  process.exit(1)
}

const newest = (dir, pattern) => {
  const base = join(sdk, dir)
  if (!existsSync(base)) return null
  const names = readdirSync(base).filter((n) => pattern.test(n)).sort().reverse()
  return names[0] ?? null
}

const platform = newest('platforms', /^android-\d/)
const buildTools = newest('build-tools', /^\d/)
if (platform === null || buildTools === null) {
  console.error('Need both SDK platforms and build-tools installed.')
  process.exit(1)
}
const androidJar = join(sdk, 'platforms', platform, 'android.jar')
const d8 = join(sdk, 'build-tools', buildTools, process.platform === 'win32' ? 'd8.bat' : 'd8')
console.log(`SDK: ${platform} + build-tools ${buildTools}`)

rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'classes'), { recursive: true })

console.log('javac: compiling Injector.java')
execFileSync('javac', ['--release', '8', '-nowarn', '-cp', androidJar, '-d', join(work, 'classes'), source], { stdio: 'inherit' })

console.log('d8: dexing into lib/injector.jar')
const jar = join(root, 'lib', 'injector.jar')
if (existsSync(jar)) unlinkSync(jar)
const d8Args = ['--lib', androidJar, '--min-api', '29', '--output', jar, join(work, 'classes', 'dsh', 'Injector.class')]
// A .bat cannot be spawned directly on Windows (EINVAL) — it has to go through cmd.exe.
if (process.platform === 'win32') {
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/c', d8, ...d8Args], { stdio: 'inherit' })
} else {
  execFileSync(d8, d8Args, { stdio: 'inherit' })
}

const base64 = readFileSync(jar).toString('base64')
const banner = [
  '// Auto-generated - do not edit by hand.',
  '// Base64 of lib/injector.jar (dex of tools/injector/Injector.java): the long-lived',
  '// app_process input injector. Embedded so the host can deploy it with a single shell write,',
  '// without relying on `adb push` (its sync protocol is fragile on flaky USB links).',
  '// Rebuild with: node tools/injector/build.mjs',
].join('\n')
writeFileSync(output, `${banner}\nexport const INJECTOR_JAR_BASE64 = '${base64}'\n`, 'utf8')

rmSync(work, { recursive: true, force: true })
console.log(`wrote ${output} (${base64.length} base64 chars, ${readFileSync(jar).length} jar bytes)`)
