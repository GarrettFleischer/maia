# E2E tests (Playwright)

Run the full E2E suite:

```bash
bun run test:e2e
```

This runs `scripts/start-e2e-server.ts`, which finds the first free port (3000, 3001, … up to 3010), starts the Next.js dev server on it, then runs Playwright with that base URL so E2E work even when the default port is in use.

**First-time setup:** Install browsers once:

```bash
bunx playwright install
```

For interactive UI mode:

```bash
bun run test:e2e:ui
```

E2E tests hit the real app and API. Use a test-friendly environment (e.g. test DB or in-memory) so runs don’t corrupt dev data.

To run Playwright against an already-running dev server (e.g. on port 3001), set the base URL and skip the script: `PLAYWRIGHT_BASE_URL=http://localhost:3001 bunx playwright test`.
