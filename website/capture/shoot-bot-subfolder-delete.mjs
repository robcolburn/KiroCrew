/**
 * Screenshot harness for the Delete folder item on an empty folder inside a
 * Bot's home folder. Component render, not the live page.
 *
 * Serves capture/bot-subfolder-delete.tsx with a programmatic Vite dev server on
 * loopback, answers `/api/chat/folders` with a fixed tree, opens the ⋯ menu of
 * the empty sub-folder and photographs it. It also asserts what the frame must
 * show: a menu on the empty sub-folder holding exactly one item, and no menu on
 * the Bot's home or on the sub-folder that holds an archived session. The run
 * exits non-zero on a mismatch.
 *
 * Usage (from website/): node capture/shoot-bot-subfolder-delete.mjs [outDir]
 */
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromiumExecutable } from '../scripts/lib/chromium-executable.mjs'
import { stubDashboardApi, logPageProblems } from '../scripts/lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '../../temp-screenshots/bot-subfolder-delete')
mkdirSync(OUT, { recursive: true })

const HOME = 'f-radar'
const EMPTY = 'f-pr-review'
const ARCHIVED = 'f-triage'
const FOLDERS = [
  { id: HOME, name: 'Radar', order: 0, collapsed: false, mate_home: true, owner_app: 'member:member-radar-0123', history_count: 0 },
  { id: EMPTY, name: 'PR review', order: 0, parent_id: HOME, owner_app: 'member:member-radar-0123', history_count: 0 },
  { id: ARCHIVED, name: 'Triage', order: 1, parent_id: HOME, owner_app: 'member:member-radar-0123', history_count: 2 },
  { id: 'f-research', name: 'Research', order: 1, history_count: 0 },
]

let failed = false
const check = (label, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failed = true }

const server = await createServer({
  configFile: './vite.config.ts',
  server: { host: '127.0.0.1', port: 5199, strictPort: false },
  logLevel: 'warn',
})
await server.listen()
const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || `http://127.0.0.1:${server.config.server.port}`

const browser = await chromium.launch({ executablePath: chromiumExecutable(), env: { ...process.env, LD_LIBRARY_PATH: '' } })
const page = await browser.newPage({ viewport: { width: 440, height: 360 }, deviceScaleFactor: 2 })
page.on('pageerror', e => { console.log(`FAIL pageerror -- ${e.message}`); failed = true })

let theme = 'dark'
await stubDashboardApi(page, {
  theme: 'dark',
  folders: FOLDERS,
  preserveStorage: true,
  // The dev server also serves `/src/api/*.ts` under a matching path; only gateway paths are stubbed.
  extra: async (path, route) => {
    if (path === '/api/theme/boot') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: theme, theme: '' }) })
      return true
    }
    if (path.startsWith('/api/')) return false
    await route.continue()
    return true
  },
})
logPageProblems(page)

for (const t of ['dark', 'light']) {
  theme = t
  await page.goto(`${base}/capture/bot-subfolder-delete.html?theme=${t}`)
  const trigger = page.locator(`[data-testid="folder-menu-${EMPTY}"]`)
  await trigger.waitFor({ timeout: 20000 })
  check(`${t}: no menu on the Bot's home`, (await page.locator(`[data-testid="folder-menu-${HOME}"]`).count()) === 0)
  check(`${t}: no menu on the sub-folder with archived sessions`, (await page.locator(`[data-testid="folder-menu-${ARCHIVED}"]`).count()) === 0)
  check(`${t}: no new-chat button on the empty sub-folder`, (await page.locator(`[data-testid="folder-new-chat-${EMPTY}"]`).count()) === 0)
  await page.locator(`[data-folder-row="${EMPTY}"]`).hover()
  await trigger.click()
  const menu = page.getByRole('menu')
  await menu.waitFor({ timeout: 5000 })
  check(`${t}: the menu holds one item`, (await menu.getByRole('menuitem').count()) === 1)
  check(`${t}: that item is Delete folder`, (await menu.locator(`[data-testid="folder-delete-${EMPTY}"]`).count()) === 1)
  const path = `${OUT}/after-${t}.png`
  await page.screenshot({ path, animations: 'disabled' })
  console.log('wrote', path)
}

await browser.close()
await server.close()
process.exit(failed ? 1 : 0)
