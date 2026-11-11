import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Exact console lines allowed only after a run shows they are pre-existing and unrelated
 * to pin, archive, or the fixture client. Empty until that evidence exists.
 */
const allowedConsoleNoise: readonly RegExp[] = []

test('unpinned completed row archives on detail close and can be pinned from Archive', async ({ page }) => {
  const observed = observePage(page)
  await openShell(page)
  await expectNoHorizontalOverflow(page)
  await openTaskSurface(page)

  const completed = page.getByRole('region', { name: 'Completed', exact: true })
  const openRow = completed.getByRole('button', { name: 'Open Pin control' })
  await expect(openRow).toBeVisible()
  await expect(openRow).toBeEnabled()
  await expect(page.getByRole('listitem', { name: 'Write the control' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Working', exact: true })).toHaveCount(0)
  await openRow.click()

  const detail = page.getByRole('article', { name: 'Task conversation' })
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Back to chat' })).toBeFocused()
  await expect(detail.getByText('Add a pin control', { exact: true })).toBeVisible()
  await expect(detail.getByRole('list', { name: 'Criteria' })).toContainText('Pin control is visible')
  await expect(detail.getByRole('textbox')).toHaveCount(0)
  await expect(page.locator('textarea#composer-input')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
  await expect(detail.getByRole('button', { name: 'Back to chat' })).toBeEnabled()
  await detail.getByRole('button', { name: 'Back to chat' }).click()
  await expect(detail).toHaveCount(0)

  await expect(page.getByRole('region', { name: 'Completed', exact: true })).toHaveCount(0)
  await expect(page.getByRole('listitem', { name: 'Pin control' })).toHaveCount(0)
  const archive = page.getByRole('region', { name: 'Archive', exact: true })
  await expectArchiveCollapsed(archive)

  await expandArchive(archive)
  await expect(archive.getByRole('button', { name: 'Open Pin control' })).toBeVisible()
  await expectHelperNested(page, archive)

  await expect(archive.getByRole('button', { name: 'Pin Pin control' })).toBeEnabled()
  await archive.getByRole('button', { name: 'Pin Pin control' }).click()
  const pinned = page.getByRole('region', { name: 'Pinned', exact: true })
  await expect(pinned.getByRole('button', { name: 'Open Pin control' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Archive', exact: true })).toHaveCount(0)
  await expectHelperNested(page, pinned)

  await expect(pinned.getByRole('button', { name: 'Unpin Pin control' })).toBeEnabled()
  await pinned.getByRole('button', { name: 'Unpin Pin control' }).click()
  const returned = page.getByRole('region', { name: 'Archive', exact: true })
  await expect(page.getByRole('region', { name: 'Pinned', exact: true })).toHaveCount(0)
  await expectArchiveCollapsed(returned)
  await expandArchive(returned)
  const returnedRow = returned.getByRole('button', { name: 'Open Pin control' })
  await expect(returnedRow).toBeVisible()
  await expect(returnedRow).toBeEnabled()
  await returnedRow.click()
  const reopened = page.getByRole('article', { name: 'Task conversation' })
  await expect(reopened).toBeVisible()
  await expect(reopened.getByRole('button', { name: 'Back to chat' })).toBeFocused()
  await expect(reopened.getByRole('textbox')).toHaveCount(0)
  await reopened.getByRole('button', { name: 'Back to chat' }).click()
  await expect(reopened).toHaveCount(0)
  await expect(returned.getByRole('button', { name: 'Open Pin control' })).toBeVisible()
  await collapseArchive(returned)
  await expect(returned.getByRole('button', { name: 'Open Pin control' })).toHaveCount(0)
  await expandArchive(returned)
  await expect(returned.getByRole('button', { name: 'Open Pin control' })).toBeVisible()
  await expectHelperNested(page, returned)
  await expectSoleRouterComposer(page)
  await expectNoHorizontalOverflow(page)
  expectQuiet(observed)
})

test('pinning from an open detail keeps the row pinned after close', async ({ page }) => {
  const observed = observePage(page)
  await openShell(page)
  await openTaskSurface(page)

  const completed = page.getByRole('region', { name: 'Completed', exact: true })
  await expect(completed.getByRole('button', { name: 'Open Pin control' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: 'Write the control' })).toHaveCount(0)
  await completed.getByRole('button', { name: 'Open Pin control' }).click()

  const detail = page.getByRole('article', { name: 'Task conversation' })
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Back to chat' })).toBeFocused()
  await expect(detail.getByRole('textbox')).toHaveCount(0)
  await expect(detail.getByRole('button', { name: 'Pin this task' })).toBeEnabled()
  await detail.getByRole('button', { name: 'Pin this task' }).click()

  await expect(detail).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Unpin this task' })).toBeVisible()
  await expect(page.locator('textarea#composer-input')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)

  await detail.getByRole('button', { name: 'Back to chat' }).click()
  await expect(detail).toHaveCount(0)
  const pinned = page.getByRole('region', { name: 'Pinned', exact: true })
  await expect(pinned.getByRole('button', { name: 'Open Pin control' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Completed', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Archive', exact: true })).toHaveCount(0)
  await expectHelperNotPromoted(page)
  await expectHelperNested(page, pinned)

  await pinned.getByRole('button', { name: 'Unpin Pin control' }).click()
  const archive = page.getByRole('region', { name: 'Archive', exact: true })
  await expect(page.getByRole('region', { name: 'Pinned', exact: true })).toHaveCount(0)
  await expectArchiveCollapsed(archive)
  await expandArchive(archive)
  await expect(archive.getByRole('button', { name: 'Open Pin control' })).toBeVisible()
  await expectHelperNested(page, archive)
  await expectSoleRouterComposer(page)
  await expectNoHorizontalOverflow(page)
  expectQuiet(observed)
})

function observePage(page: Page) {
  const consoleErrors: string[] = []
  const unexpectedUrls: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (allowedConsoleNoise.some((pattern) => pattern.test(text))) return
    consoleErrors.push(text)
  })
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message)
  })
  page.on('request', (request) => {
    if (isOutsideFixture(request.url())) unexpectedUrls.push(request.url())
  })
  page.on('websocket', (socket) => {
    unexpectedUrls.push(socket.url())
  })
  return { consoleErrors, unexpectedUrls }
}

function isOutsideFixture(url: string): boolean {
  const parsed = new URL(url)
  if (parsed.hostname !== '127.0.0.1') return true
  return parsed.pathname.startsWith('/api/')
}

function expectQuiet(observed: { consoleErrors: string[]; unexpectedUrls: string[] }) {
  expect(observed.unexpectedUrls, observed.unexpectedUrls.join('\n')).toEqual([])
  expect(observed.consoleErrors, observed.consoleErrors.join('\n')).toEqual([])
}

async function openShell(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.removeItem('maia.fixture.v1'))
  await page.reload()
  const backends = page.getByRole('radiogroup', { name: 'Onboarding credential backend' })
  await backends.getByRole('radio', { name: 'native', exact: true }).click()
  await page.getByRole('radiogroup', { name: 'Security profile' }).getByRole('radio', { name: 'Protected' }).click()
  await page.getByRole('button', { name: 'Continue to Maia' }).click()
  await expect(page.getByRole('heading', { name: 'Router', level: 1 })).toBeVisible()
}

async function openTaskSurface(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 728) {
    const openDrawer = page.getByRole('button', { name: 'Open tasks drawer' })
    await expect(openDrawer).toBeVisible()
    await expect(openDrawer).toBeEnabled()
    await openDrawer.click()
    await expect(page.getByRole('dialog', { name: 'Tasks' })).toBeVisible()
  }
}

function archiveDisclosure(archive: Locator) {
  return archive.getByRole('group', { name: 'Archive', exact: true })
}

async function expectArchiveCollapsed(archive: Locator) {
  await expect(archiveDisclosure(archive)).not.toHaveAttribute('open')
  await expect(archive.getByRole('button', { name: 'Open Pin control' })).toHaveCount(0)
}

async function expandArchive(archive: Locator) {
  // Chrome exposes summary as DisclosureTriangle, which Playwright does not map to button.
  await archive.getByText('Archive', { exact: true }).click()
  await expect(archiveDisclosure(archive)).toHaveAttribute('open')
}

async function collapseArchive(archive: Locator) {
  await archive.getByText('Archive', { exact: true }).click()
  await expect(archiveDisclosure(archive)).not.toHaveAttribute('open')
}

async function expectHelperNotPromoted(page: Page) {
  await expect(page.getByRole('listitem', { name: 'Write the control' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Expand Pin control' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Working', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Needs you', exact: true })).toHaveCount(0)
}

async function expectHelperNested(page: Page, scope: Locator) {
  const toggle = scope.getByRole('button', { name: /^(Expand|Collapse) Pin control$/ })
  await expect(toggle).toBeVisible()
  await expect(toggle).toBeEnabled()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click()
  }
  const helpers = scope.getByRole('list', { name: 'Helpers for Pin control' })
  await expect(helpers.getByRole('listitem', { name: 'Write the control' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: 'Write the control' })).toHaveCount(1)
  await expect(page.getByRole('listitem', { name: 'Pin control' })).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Working', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Needs you', exact: true })).toHaveCount(0)
}

async function expectSoleRouterComposer(page: Page) {
  await expect(page.locator('textarea#composer-input')).toHaveCount(1)
  await expect(page.locator('textarea#composer-input')).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0)
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1)
}
