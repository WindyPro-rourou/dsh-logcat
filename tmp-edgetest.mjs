// Headless Edge test: open the DSH GUI, open the Logcat drawer, inspect the resize handle.
import { chromium } from 'playwright-core'

const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browser = await chromium.launch({ channel: 'msedge', executablePath: edgePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const logs = []
page.on('console', (m) => { if (m.type() === 'error') logs.push('console.error: ' + m.text().slice(0, 300)) })
page.on('pageerror', (e) => logs.push('pageerror: ' + String(e).slice(0, 300)))

console.log('navigating to GUI...')
await page.goto('http://127.0.0.1:3080', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(8000)

// find the logcat sidebar entry
const entry = await page.$('[data-dsh-logcat-entry]')
if (!entry) {
  console.log('RESULT: sidebar entry NOT FOUND')
  console.log('page errors:', logs.join('\n') || '(none)')
  await page.screenshot({ path: 'F:/dsh-logcat/tmp-noentry.png' })
  await browser.close()
  process.exit(0)
}
console.log('sidebar entry found:', await entry.textContent())
await entry.click()
await page.waitForTimeout(2000)

// inspect the drawer and handle
const inspect = await page.evaluate(() => {
  const view = document.querySelector('.dsh-logcat-view')
  if (!view) return { view: null }
  const handle = view.querySelector('.dsh-logcat-resize')
  const rect = view.getBoundingClientRect()
  const out = {
    view: { hidden: view.hidden, display: getComputedStyle(view).display, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } },
    handle: null,
  }
  if (handle) {
    const hr = handle.getBoundingClientRect()
    const cs = getComputedStyle(handle)
    out.handle = {
      rect: { x: hr.x, y: hr.y, w: hr.width, h: hr.height },
      cursor: cs.cursor,
      display: cs.display,
      pseudoBefore: getComputedStyle(handle, '::before').width + 'x' + getComputedStyle(handle, '::before').height,
    }
  }
  return out
})
console.log('inspect:', JSON.stringify(inspect, null, 1))

await page.screenshot({ path: 'F:/dsh-logcat/tmp-panel.png' })
console.log('page errors:', logs.join('\n') || '(none)')
await browser.close()
console.log('TEST DONE')
