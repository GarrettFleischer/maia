import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import css from '@/styles/mint-ledger.css?raw'

const TABS = ['Memory', 'Search', 'Review', 'Timeline', 'Graph']

function pageHtml(): string {
  const tabs = TABS.map(
    (name) => `<button class="maia-btn" type="button" role="tab">${name}</button>`,
  ).join('')
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root">
    <div class="maia-shell maia-shell--phone">
      <main class="maia-main">
        <section class="maia-conversation maia-phone-screen" aria-label="Brain">
          <div class="maia-main-body">
            <section class="maia-brain" aria-label="Memory">
              <div class="maia-brain-toolbar maia-brain-tabs" role="tablist" aria-label="Brain views">${tabs}</div>
              <div class="maia-brain-toolbar">
                <input type="search" aria-label="Search the brain" placeholder="Search the brain" />
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  </div></body></html>`
}

describe('brain tabs at 412px', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3.5,
    })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('keeps five tabs on one row without horizontal page overflow', async () => {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.setContent(pageHtml(), { waitUntil: 'load' })
    const box = await page.evaluate(() => {
      const de = document.documentElement
      const tablist = document.querySelector('[role="tablist"]')
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      if (!tablist || tabs.length === 0) throw new Error('tabs missing')
      const tops = tabs.map((tab) => tab.getBoundingClientRect().top)
      const heights = tabs.map((tab) => tab.getBoundingClientRect().height)
      const lefts = tabs.map((tab) => tab.getBoundingClientRect().left)
      const rights = tabs.map((tab) => tab.getBoundingClientRect().right)
      const style = getComputedStyle(tablist)
      const list = tablist.getBoundingClientRect()
      return {
        clientWidth: de.clientWidth,
        scrollWidth: de.scrollWidth,
        tops,
        heights,
        lefts,
        rights,
        flexWrap: style.flexWrap,
        overflowX: style.overflowX,
        labels: tabs.map((tab) => tab.textContent),
        tablistLeft: list.left,
        tablistRight: list.right,
        tablistScroll: tablist.scrollWidth,
        tablistClient: tablist.clientWidth,
      }
    })
    expect(box.labels).toEqual(TABS)
    expect(box.clientWidth).toBeLessThanOrEqual(412)
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
    expect(box.tablistRight).toBeLessThanOrEqual(box.clientWidth + 1)
    expect(box.tablistScroll).toBeGreaterThanOrEqual(box.tablistClient)
    for (const left of box.lefts) expect(left).toBeGreaterThanOrEqual(box.tablistLeft - 1)
    for (const right of box.rights) expect(right).toBeLessThanOrEqual(box.tablistRight + 1)
    expect(Math.max(...box.tops) - Math.min(...box.tops)).toBeLessThan(2)
    expect(box.flexWrap).toBe('nowrap')
    expect(box.overflowX === 'auto' || box.overflowX === 'scroll').toBe(true)
    for (const height of box.heights) expect(height).toBeGreaterThanOrEqual(44)
  })
})
