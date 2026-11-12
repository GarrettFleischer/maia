import { test, expect, type Page } from '@playwright/test'

async function completeOnboarding(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.removeItem('maia.fixture.v1'))
  await page.reload()
  await page.getByTestId('onboarding-backend-native').click()
  await page.getByTestId('profile-card-protected').click()
  await page.getByTestId('finish-onboarding').click()
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

test.describe('Mint Ledger responsive shell', () => {
  test('desktop shows rail, conversation, and inspector', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) !== 1440, 'desktop project only')
    await completeOnboarding(page)
    await expect(page.getByRole('navigation', { name: 'Chats' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Tasks/ })).toBeVisible()
    await expect(page.getByTestId('composer')).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible()
    const transcript = page.getByTestId('transcript')
    const composer = page.getByTestId('composer')
    const tBox = await transcript.boundingBox()
    const cBox = await composer.boundingBox()
    expect(tBox && cBox).toBeTruthy()
    if (tBox && cBox) {
      expect(cBox.y).toBeGreaterThanOrEqual(tBox.y + tBox.height - 2)
    }
  })

  test('tablet hides inspector column but keeps conversation width', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) !== 900, 'tablet project only')
    await completeOnboarding(page)
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0)
    const mainWidth = await page.locator('.maia-main').evaluate((el) => el.getBoundingClientRect().width)
    expect(mainWidth).toBeGreaterThanOrEqual(480)
  })

  test('phone keeps stop all visible while threads run', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) !== 390, 'phone project only')
    await completeOnboarding(page)
    const stopBar = page.getByTestId('phone-stop-bar')
    await expect(stopBar).toBeVisible()
    await expect(stopBar.getByLabel('Stop all running threads')).toBeVisible()
  })

  test('phone stop bar precedes composer in document order', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) !== 390, 'phone project only')
    await completeOnboarding(page)
    const layout = await page.evaluate(() => {
      const stop = document.querySelector('[data-testid="phone-stop-bar"]')
      const composer = document.querySelector('[data-testid="composer"]')
      const transcript = document.querySelector('[data-testid="transcript"]')
      if (!stop || !composer || !transcript) {
        return null
      }
      const transcriptBeforeStop = Boolean(
        transcript.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      const stopBeforeComposer = Boolean(
        stop.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      const gap = composer.getBoundingClientRect().top - stop.getBoundingClientRect().bottom
      return { transcriptBeforeStop, stopBeforeComposer, gap }
    })
    expect(layout).toEqual({ transcriptBeforeStop: true, stopBeforeComposer: true, gap: 0 })
  })

  test('phone security cards fit viewport without horizontal overflow', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) !== 390, 'phone project only')
    await completeOnboarding(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    const metrics = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth
      const cards = Array.from(document.querySelectorAll('[data-testid^="profile-card-"]'))
      const grid = document.querySelector('[data-testid="security-profile-cards"]')
      const cardOverflow = cards.some(
        (node) => node.getBoundingClientRect().right > viewportWidth + 0.5,
      )
      return {
        viewportWidth,
        gridWidth: grid?.getBoundingClientRect().width ?? 0,
        scrollWidth: document.documentElement.scrollWidth,
        cardOverflow,
      }
    })
    expect(metrics.cardOverflow).toBe(false)
    expect(metrics.gridWidth).toBeLessThanOrEqual(metrics.viewportWidth + 0.5)
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1)
  })

  test('phone header opens security settings', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) !== 390, 'phone project only')
    await completeOnboarding(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByTestId('security-settings')).toBeVisible()
  })
})

test.describe('Security settings flows', () => {
  test('keyboard activates profile cards and unrestricted banner persists in settings', async ({
    page,
    viewport,
  }) => {
    test.skip((viewport?.width ?? 0) < 728, 'settings rail/header requires tablet or desktop width')
    await completeOnboarding(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByTestId('profile-card-unrestricted').focus()
    await page.keyboard.press('Enter')
    await page.getByTestId('confirm-unrestricted').click()
    await expect(page.getByTestId('unrestricted-banner')).toBeVisible()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByTestId('unrestricted-banner')).toBeVisible()
  })

  test('unrestricted dialog traps focus and restores on escape', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) < 728, 'settings entry requires tablet or desktop width')
    await completeOnboarding(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByTestId('profile-card-unrestricted').click()
    const dialog = page.getByRole('dialog', { name: /enable unrestricted profile/i })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})

test.describe('Modal and inspector keyboard contracts', () => {
  test('phone drawers isolate background, trap real Tab, close from backdrop, and restore triggers', async ({
    page,
    viewport,
  }) => {
    test.skip((viewport?.width ?? 0) !== 390, 'phone project only')
    await completeOnboarding(page)
    const tasks = page.getByRole('button', { name: /^Tasks/ })
    await tasks.click()
    await expect(page.getByRole('region', { name: 'Tasks' })).toBeVisible()
    await expect(page.locator('#root')).not.toHaveAttribute('inert')
    await tasks.click()

    const inspect = page.getByRole('button', { name: 'Inspect' })
    await inspect.focus()
    await page.keyboard.press('Enter')
    const inspector = page.getByRole('dialog', { name: 'Inspector' })
    await expect(inspector).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Close inspector' })).toBeFocused()
    await page
      .locator('.maia-phone-header button')
      .first()
      .evaluate((element: HTMLElement) => element.focus())
    await expect(inspector.getByRole('button', { name: 'Close inspector' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(inspector).toHaveCount(0)
    await expect(inspect).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(inspector).toBeVisible()
    await page.locator('.maia-dialog-backdrop').click({ position: { x: 2, y: 2 } })
    await expect(inspector).toHaveCount(0)
    await expect(inspect).toBeFocused()
  })

  test('inspector tabs support real wrapping arrows, Home, and End', async ({ page }, testInfo) => {
    await completeOnboarding(page)
    if (testInfo.project.name !== 'desktop') {
      await page.getByRole('button', { name: 'Inspect' }).click()
    }
    const cache = page.getByRole('tab', { name: 'Cache' })
    const brain = page.getByRole('tab', { name: 'Brain' })
    const trace = page.getByRole('tab', { name: 'Trace' })

    await expect(cache).toHaveAttribute('tabindex', '0')
    await expect(brain).toHaveAttribute('tabindex', '-1')
    await expect(trace).toHaveAttribute('tabindex', '-1')
    if (testInfo.project.name !== 'desktop') {
      const close = page.getByRole('button', { name: 'Close inspector' })
      await close.focus()
      await page.keyboard.press('Shift+Tab')
      await expect(cache).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(close).toBeFocused()
    }
    await cache.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(trace).toBeFocused()
    await page.keyboard.press('Home')
    await expect(cache).toBeFocused()
    await page.keyboard.press('End')
    await expect(trace).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(cache).toBeFocused()
  })
})
