import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import css from './mint-ledger.css?raw'

function pageHtml(body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root">${body}</div></body></html>`
}

const longToken = 'https://gamma.tailc7a62f.ts.net:4178/session/very-long-token'
const transcript = `
  <div class="maia-transcript" data-testid="transcript">
    <details class="maia-fold"><summary>Thinking</summary><p>Hidden note</p></details>
    ${Array.from({ length: 30 }, (_, index) => `<p class="maia-transcript-body">Line ${index}. Can I open this from my phone?</p>`).join('')}
    <div class="maia-transcript-body"><pre><code>${longToken}-${longToken}-${longToken}</code></pre></div>
  </div>
  <form class="maia-composer" data-testid="composer">
    <div class="maia-composer-box">
      <textarea aria-label="Message"></textarea>
      <div class="maia-composer-row">
        <span class="maia-composer-hint">Enter send</span>
        <button class="maia-btn maia-btn--primary" type="button">Send</button>
      </div>
    </div>
  </form>`

function shell(className: string, main: string, extras = ''): string {
  return `<div class="${className}" data-testid="shell">
    <header class="maia-titlebar"><span class="maia-titlebar-word">Maia</span></header>
    <nav class="maia-nav">Tasks</nav>
    <main class="maia-main">${main}</main>
    <aside class="maia-inspector">Inspector</aside>
    ${extras}
  </div>`
}

const conversationShell = (className: string) =>
  shell(
    className,
    `<section class="maia-conversation" aria-label="Conversation">
      <header class="maia-conv-head"><h1>Router</h1><p>One conversation</p></header>
      ${transcript}
    </section>`,
  )

interface LayoutBox {
  clientWidth: number
  scrollWidth: number
  clientHeight: number
  conversationWidth: number
  shellBottom: number
  composerBottom: number | null
  composerTop: number | null
  transcriptBottom: number | null
  transcriptOverflow: string | null
  transcriptScrolls: boolean
      buttonHeight: number
      summaryHeight: number
      searchHeight: number
      modeLabelHeight: number
  navDisplay: string | null
  offenders: string[]
}

async function measure(page: Page, width: number, height: number, body: string): Promise<LayoutBox> {
  await page.setViewportSize({ width, height })
  await page.setContent(pageHtml(body), { waitUntil: 'load' })
  return page.evaluate(() => {
    const de = document.documentElement
    const shellEl = document.querySelector('.maia-shell')
    const conversation = document.querySelector('.maia-conversation')
    const composer = document.querySelector('.maia-composer')
    const transcriptEl = document.querySelector('.maia-transcript')
    const button = document.querySelector('.maia-btn')
    const nav = document.querySelector('.maia-nav')
    if (!shellEl || !conversation) {
      throw new Error('shell missing')
    }
    const offenders: string[] = []
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect()
      if (rect.width > de.clientWidth + 1 || rect.right > de.clientWidth + 1) {
        const name = String(el.className || el.tagName).slice(0, 48)
        offenders.push(`${name} w=${Math.round(rect.width)} r=${Math.round(rect.right)}`)
      }
    }
    return {
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      clientHeight: de.clientHeight,
      conversationWidth: conversation.getBoundingClientRect().width,
      shellBottom: shellEl.getBoundingClientRect().bottom,
      composerBottom: composer ? composer.getBoundingClientRect().bottom : null,
      composerTop: composer ? composer.getBoundingClientRect().top : null,
      transcriptBottom: transcriptEl ? transcriptEl.getBoundingClientRect().bottom : null,
      transcriptOverflow: transcriptEl ? getComputedStyle(transcriptEl).overflowY : null,
      transcriptScrolls: transcriptEl ? transcriptEl.scrollHeight > transcriptEl.clientHeight + 1 : false,
      buttonHeight: button ? button.getBoundingClientRect().height : 0,
      summaryHeight: document.querySelector('summary')?.getBoundingClientRect().height ?? 0,
      searchHeight: document.querySelector('input[type="search"]')?.getBoundingClientRect().height ?? 0,
      modeLabelHeight: document.querySelector('.maia-brain-toolbar label')?.getBoundingClientRect().height ?? 0,
      navDisplay: nav ? getComputedStyle(nav).display : null,
      offenders,
    }
  })
}

describe('phone layout at 390px', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    })
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('fills a 390px screen when the shell is still marked tablet', async () => {
    const box = await measure(page, 390, 844, conversationShell('maia-shell maia-shell--tablet'))
    expect(box.clientWidth).toBeLessThanOrEqual(390)
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
    expect(box.offenders).toEqual([])
    expect(box.conversationWidth).toBeGreaterThanOrEqual(box.clientWidth - 1)
    expect(box.transcriptOverflow).toBe('auto')
    expect(box.transcriptScrolls).toBe(true)
    expect(box.composerTop).toBeGreaterThanOrEqual((box.transcriptBottom ?? 0) - 1)
    expect(box.composerBottom).toBeGreaterThanOrEqual(box.shellBottom - 2)
    expect(box.composerBottom).toBeLessThanOrEqual(box.shellBottom + 1)
    expect(box.summaryHeight).toBeGreaterThanOrEqual(44)
  })

  it('keeps phone controls at least 44px and the brain screen inside the viewport', async () => {
    const box = await measure(
      page,
      390,
      844,
      `<div class="maia-shell maia-shell--phone">
        <header class="maia-phone-header">
          <button class="maia-btn" type="button">Agents</button>
          <strong>Router</strong>
          <div class="maia-phone-header-actions">
            <button class="maia-btn" type="button">Inspect</button>
            <button class="maia-btn" type="button">Brain</button>
            <button class="maia-btn" type="button">Settings</button>
          </div>
        </header>
        <main class="maia-main">
          <section class="maia-conversation maia-phone-screen" aria-label="Brain">
            <header class="maia-conv-head">
              <button class="maia-btn" type="button">Chat</button>
              <h1>Brain</h1>
            </header>
            <div class="maia-main-body">
              <section class="maia-brain">
                <div class="maia-brain-toolbar">
                  <input type="search" aria-label="Search the brain" />
                  <label>Explore<input type="radio" /></label>
                  <button class="maia-btn" type="button">Zoom in</button>
                </div>
                <div class="maia-brain-layout">
                  <svg class="maia-brain-svg" viewBox="0 0 960 640"></svg>
                  <div class="maia-brain-side"><p>Select a fact</p></div>
                </div>
              </section>
            </div>
          </section>
        </main>
      </div>`,
    )
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
    expect(box.offenders).toEqual([])
    expect(box.conversationWidth).toBeGreaterThanOrEqual(box.clientWidth - 1)
    expect(box.buttonHeight).toBeGreaterThanOrEqual(44)
    expect(box.searchHeight).toBeGreaterThanOrEqual(44)
    expect(box.modeLabelHeight).toBeGreaterThanOrEqual(44)
  })

  it('keeps a settings table inside the 390px screen', async () => {
    const box = await measure(
      page,
      390,
      844,
      `<div class="maia-shell maia-shell--phone">
        <main class="maia-main">
          <section class="maia-conversation" aria-label="Settings">
            <div class="maia-main-body">
              <table class="maia-table">
                <thead>
                  <tr><th>Target</th><th>Capability</th><th>Agent</th><th>Enabled</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td><div>tailscale.md</div><div class="maia-mono">allow-very-long-entry-id</div></td>
                    <td>read</td>
                    <td>All agents</td>
                    <td><button class="maia-btn" type="button">Enabled</button></td>
                    <td><button class="maia-btn" type="button">Edit</button><button class="maia-btn" type="button">Revoke</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>`,
    )
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1)
    expect(box.offenders).toEqual([])
  })

  it('keeps the desktop three columns and the tablet conversation', async () => {
    const desktop = await measure(page, 1440, 900, conversationShell('maia-shell'))
    expect(desktop.scrollWidth).toBeLessThanOrEqual(desktop.clientWidth + 1)
    expect(desktop.navDisplay).not.toBe('none')
    expect(desktop.conversationWidth).toBeLessThan(desktop.clientWidth - 400)
    expect(desktop.conversationWidth).toBeGreaterThan(480)
    expect(desktop.buttonHeight).toBeLessThan(44)

    const tablet = await measure(page, 900, 800, conversationShell('maia-shell maia-shell--tablet'))
    expect(tablet.scrollWidth).toBeLessThanOrEqual(tablet.clientWidth + 1)
    expect(tablet.navDisplay).not.toBe('none')
    expect(tablet.conversationWidth).toBeGreaterThanOrEqual(480)
    expect(tablet.conversationWidth).toBeLessThan(tablet.clientWidth - 200)

    const tabletFloor = await measure(page, 728, 800, conversationShell('maia-shell maia-shell--tablet'))
    expect(tabletFloor.scrollWidth).toBeLessThanOrEqual(tabletFloor.clientWidth + 1)
    expect(tabletFloor.navDisplay).not.toBe('none')
    expect(tabletFloor.conversationWidth).toBeGreaterThanOrEqual(480)
    expect(tabletFloor.conversationWidth).toBeLessThan(tabletFloor.clientWidth - 100)
  })
})
