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

E2E tests hit the real app and API. When started via `test:e2e` or Playwright's built-in webServer, the app runs with **MAIA_DATA_DIR=data-e2e**, so a separate DB and data folder are used and dev data is never overwritten. The `data-e2e/` directory is gitignored.

To run Playwright against an already-running dev server (e.g. on port 3001), set the base URL and skip the script: `PLAYWRIGHT_BASE_URL=http://localhost:3001 bunx playwright test`. That server will use whatever data dir it was started with (e.g. default `data/`).
