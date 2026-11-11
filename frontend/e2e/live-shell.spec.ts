import { expect, test } from '@playwright/test'

function applicationOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  return url.origin
}

async function transcriptMetrics(page: import('@playwright/test').Page) {
  return page.getByRole('log', { name: 'Router transcript' }).evaluate((element) => {
    const composer = document.querySelector('[data-testid="composer"]')
    if (!(composer instanceof HTMLElement)) throw new Error('composer is missing')
    const composerBox = composer.getBoundingClientRect()
    return {
      scrollTop: element.scrollTop,
      bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      composerBottom: composerBox.bottom,
      viewportHeight: window.innerHeight,
    }
  })
}

test('live shell renders API state without fixture surfaces and exposes safe provider failure', async ({
  page,
}, testInfo) => {
  let submitted = false
  let sends = 0
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('live-shell project requires a baseURL')
  const previewOrigin = new URL(baseURL).origin
  const externalTraffic: string[] = []
  const apiOrigins = new Set<string>()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (applicationOrigin(request.url()) !== previewOrigin) externalTraffic.push(request.url())
    if (url.pathname.startsWith('/api/')) apiOrigins.add(url.origin)
  })
  page.on('websocket', (socket) => {
    if (applicationOrigin(socket.url()) !== previewOrigin) externalTraffic.push(socket.url())
  })
  await page.route('**/*', async (route) => {
    if (applicationOrigin(route.request().url()) !== previewOrigin) {
      externalTraffic.push(route.request().url())
      await route.abort()
      return
    }
    await route.continue()
  })
  await page.route(`${previewOrigin}/api/super-agent/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/super-agent/sidebar') {
      await route.fulfill({ json: { rows: [] } })
      return
    }
    if (path === '/api/super-agent/transcript') {
      await route.fulfill({
        json: {
          messages: submitted
            ? [
                { message_id: 'm-owner', role: 'owner', text: 'Route from deterministic browser' },
                {
                  message_id: 'm-router',
                  role: 'router',
                  text: 'The model provider is unavailable.',
                },
              ]
            : [{ message_id: 'm-initial', role: 'router', text: 'Live API transcript' }],
        },
      })
      return
    }
    if (path === '/api/super-agent/messages' && request.method() === 'POST') {
      submitted = true
      sends += 1
      await route.fulfill({
        status: 200,
        json: {
          admission: 'admitted',
          message_id: 'm-owner',
          outcome: {
            kind: 'routing_failed',
            reason: 'model_provider_unavailable',
            detail: 'private upstream provider detail',
          },
        },
      })
      return
    }
    await route.fulfill({ status: 404, json: { error: 'unknown_route' } })
  })

  await page.goto('/')

  const transcript = page.getByRole('log', { name: 'Router transcript' })
  await expect(transcript.getByText('Live API transcript')).toBeVisible()
  await expect(page.getByTestId('activity-counts')).toHaveCount(0)
  await expect(page.getByTestId('needs-human-banner')).toHaveCount(0)
  await expect(page.getByText('Persona · Scout')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0)

  if (testInfo.project.name === 'desktop') {
    await expect(page.getByText('Inspector data is not available from the live API.')).toBeVisible()
  } else {
    await page.getByRole('button', { name: 'Inspect' }).click()
    await expect(page.getByText('Inspector data is not available from the live API.')).toBeVisible()
    await page.getByRole('button', { name: 'Close inspector' }).click()
  }

  if (testInfo.project.name === 'phone') {
    await page.getByRole('button', { name: 'Open tasks drawer' }).click()
    const drawer = page.getByRole('dialog', { name: 'Tasks' })
    await expect(drawer.getByTestId('activity-counts')).toHaveCount(0)
    await expect(drawer.getByRole('button', { name: 'Settings' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  }

  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Route from deterministic browser')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(transcript.getByText('The model provider is unavailable.')).toBeVisible()
  await expect(page.getByText('The model provider is unavailable.', { exact: true })).toHaveCount(1)
  await expect(transcript.getByText('The router could not be reached.')).toHaveCount(0)
  await expect(composer).toHaveValue('')
  await expect(composer).toBeEnabled()
  await expect(page.locator('body')).not.toContainText('private upstream provider detail')
  expect(sends).toBe(1)
  expect([...apiOrigins]).toEqual([previewOrigin])
  expect(externalTraffic).toEqual([])
})

test('unknown admitted outcome clears once and refreshes once', async ({ page }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('live-shell project requires a baseURL')
  const previewOrigin = new URL(baseURL).origin
  let sends = 0
  let transcriptReads = 0
  await page.route(`${previewOrigin}/api/super-agent/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/super-agent/sidebar') {
      await route.fulfill({ json: { rows: [] } })
      return
    }
    if (path === '/api/super-agent/transcript') {
      transcriptReads += 1
      await route.fulfill(
        transcriptReads === 1
          ? { json: { messages: [] } }
          : { status: 500, json: { error: 'task_store_unavailable' } },
      )
      return
    }
    if (path === '/api/super-agent/messages' && request.method() === 'POST') {
      sends += 1
      await route.fulfill({
        json: {
          admission: 'admitted',
          message_id: 'm-future',
          outcome: {
            kind: 'future_outcome',
            detail: 'private upstream detail',
          },
        },
      })
      return
    }
    await route.fulfill({ status: 404, json: { error: 'unknown_route' } })
  })

  await page.goto('/')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('Future admitted result')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(
    page.getByText('The message was accepted, but its outcome is unavailable.').first(),
  ).toBeVisible()
  await expect(
    page.getByText('The message was accepted, but its outcome is unavailable.', {
      exact: true,
    }),
  ).toHaveCount(1)
  await expect(composer).toHaveValue('')
  await expect(composer).toBeEnabled()
  await expect(page.locator('body')).not.toContainText('private upstream detail')
  expect(sends).toBe(1)
  expect(transcriptReads).toBe(2)
})

test('long transcript follows hydration and pinned appends while preserving older history', async ({
  page,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('live-shell project requires a baseURL')
  const previewOrigin = new URL(baseURL).origin
  let sendCount = 0
  const longToken = `TOKEN-${'A'.repeat(10_000)}-END`
  const graphemeToken = `GRAPHEME-${'e\u0301'.repeat(5_000)}-END`
  let messages = Array.from({ length: 80 }, (_, index) => ({
    message_id: `m-${index + 1}`,
    role: index % 2 === 0 ? ('owner' as const) : ('router' as const),
    text:
      index === 39
        ? longToken
        : index === 40
          ? graphemeToken
          : `History ${index + 1} ${'overflow text '.repeat(4)}`,
  }))

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route(`${previewOrigin}/api/super-agent/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/super-agent/sidebar') {
      await route.fulfill({ json: { rows: [] } })
      return
    }
    if (path === '/api/super-agent/transcript') {
      await route.fulfill({ json: { messages } })
      return
    }
    if (path === '/api/super-agent/messages' && request.method() === 'POST') {
      sendCount += 1
      messages = [
        ...messages,
        {
          message_id: `m-owner-${sendCount}`,
          role: 'owner',
          text: `Owner append ${sendCount}`,
        },
        {
          message_id: `m-router-${sendCount}`,
          role: 'router',
          text: `Router append ${sendCount}`,
        },
      ]
      await route.fulfill({
        json: {
          admission: 'admitted',
          message_id: `m-owner-${sendCount}`,
          outcome: { kind: 'routed', route: 'admit' },
        },
      })
      return
    }
    await route.fulfill({ status: 404, json: { error: 'unknown_route' } })
  })

  await page.goto('/')
  const transcript = page.getByRole('log', { name: 'Router transcript' })
  const composer = page.getByRole('textbox', { name: 'Message' })
  await expect(transcript.getByText(/History 80/)).toHaveCount(1)
  await expect(transcript.getByText(longToken, { exact: true })).toHaveCount(1)
  await expect(transcript.getByText(graphemeToken, { exact: true })).toHaveCount(1)
  await expect.poll(async () => (await transcriptMetrics(page)).bottomGap).toBeLessThanOrEqual(1)
  const overflow = await page.evaluate(() => {
    const transcriptElement = document.querySelector('[data-testid="transcript"]')
    if (!(transcriptElement instanceof HTMLElement)) throw new Error('transcript is missing')
    return {
      transcript: transcriptElement.scrollWidth - transcriptElement.clientWidth,
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  expect(overflow.transcript).toBeLessThanOrEqual(1)
  expect(overflow.document).toBeLessThanOrEqual(1)
  await expect(composer).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  expect((await transcriptMetrics(page)).composerBottom).toBeLessThanOrEqual(
    (await transcriptMetrics(page)).viewportHeight,
  )

  await transcript.evaluate((element) => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2)
  })
  const olderHistoryTop = (await transcriptMetrics(page)).scrollTop
  await composer.fill('Owner append 1')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByText('Router append 1')).toHaveCount(1)
  await expect.poll(async () => (await transcriptMetrics(page)).scrollTop).toBe(olderHistoryTop)

  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await composer.fill('Owner append 2')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByText('Router append 2')).toHaveCount(1)
  await expect.poll(async () => (await transcriptMetrics(page)).bottomGap).toBeLessThanOrEqual(1)

  const viewport = page.viewportSize()
  if (!viewport) throw new Error('viewport is missing')
  await page.setViewportSize({ width: viewport.width, height: viewport.height - 120 })
  await expect.poll(async () => (await transcriptMetrics(page)).bottomGap).toBeLessThanOrEqual(1)

  messages = [{ message_id: 'm-short', role: 'router', text: 'Short history' }]
  await page.reload()
  await expect(transcript.getByText('Short history')).toBeVisible()
  const short = await transcriptMetrics(page)
  expect(short.scrollHeight).toBeLessThanOrEqual(short.clientHeight)
  expect(short.scrollTop).toBe(0)
  expect(short.composerBottom).toBeLessThanOrEqual(short.viewportHeight)
  expect(sendCount).toBe(2)
})
