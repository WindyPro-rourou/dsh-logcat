// Headless Edge: open drawer, verify handle, simulate a real drag resize.
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

await page.goto('http://127.0.0.1:3080', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(8000)

const entry = await page.$('[data-dsh-logcat-entry]')
if (!entry) { console.log('RESULT: entry NOT FOUND'); await browser.close(); process.exit(0) }
await entry.click()
await page.waitForTimeout(1500)

const before = await page.evaluate(() => {
  const view = document.querySelector('.dsh-logcat-view')
  const handle = view?.querySelector('.dsh-logcat-resize')
  if (!handle) return { handle: null, width: view?.getBoundingClientRect().width }
  const hr = handle.getBoundingClientRect()
  return {
    handle: { x: hr.x, y: hr.y, w: hr.width, h: hr.height, cursor: getComputedStyle(handle).cursor },
    width: view.getBoundingClientRect().width,
  }
})
console.log('before:', JSON.stringify(before))

if (before.handle) {
  const hx = before.handle.x + before.handle.w / 2
  const hy = before.handle.y + before.handle.h / 2
  await page.mouse.move(hx, hy)
  await page.waitForTimeout(200)
  await page.mouse.down()
  await page.mouse.move(hx - 250, hy, { steps: 12 })
  await page.waitForTimeout(200)
  await page.mouse.up()
  await page.waitForTimeout(300)

  const after = await page.evaluate(() => {
    const view = document.querySelector('.dsh-logcat-view')
    const stored = (() => { try { return localStorage.getItem('dsh-logcat-width') } catch { return null } })()
    return { width: view?.getBoundingClientRect().width, storedWidth: stored }
  })
  console.log('after drag:', JSON.stringify(after))
  console.log('RESULT:', before.width && after.width && after.width < before.width - 100 ? 'DRAG WORKS' : 'DRAG FAILED')
} else {
  console.log('RESULT: handle still missing')
}

await page.screenshot({ path: 'F:/dsh-logcat/tmp-dragtest.png' })
console.log('page errors:', errors.join('\n') || '(none)')
await browser.close()
console.log('TEST DONE')
