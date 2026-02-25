# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

**Maia** is a personal AI agent system built with Next.js 16 (App Router), React 19, Tailwind CSS v4, TypeScript 5, and SQLite (better-sqlite3). It uses **Bun** as its package manager (`bun.lock`).

Pages: Chat (`/`), Agents (`/agents`), Tasks (`/tasks`), Settings (`/settings`).

### Running services

- **Dev server**: `bun run dev` starts Next.js on port 3000 with hot reload. The SQLite database is auto-created in the `data/` directory on first request.
- **Docker sandbox** (`docker compose up -d`): Optional — only needed for terminal/file CRUD tool execution inside a sandboxed container. Not required for dev server, tests, or most UI work.

### Environment

Copy `.env.example` to `.env` and fill in `CREDENTIAL_MASTER_KEY` (generate via `openssl rand -hex 32`). The `SANDBOX_CONTAINER_NAME` defaults to `maia-sandbox`.

### Lint, Typecheck, Test

- **Lint**: `bun run lint`. Pre-existing lint errors exist in auto-generated `types/` files and some pre-existing warnings/errors in the app code — these are not regressions.
- **Typecheck**: `bunx tsc --noEmit` — run by itself, never pipe or redirect output.
- **Unit tests**: `bun test` (396 tests across 57 files). Tests use happy-dom and temp data dirs — no external services needed.
- **E2E tests**: `bun run test:e2e` (Playwright + Chromium). Requires the dev server or lets Playwright start one.
- **Fix workflow** (per `.cursor/skills/fix/SKILL.md`): typecheck -> build -> tests, in order.

### Gotchas

- Bun must be installed (`~/.bun/bin/bun`). The update script handles install if missing.
- The chat "Error: fetch failed" when sending messages is expected without a running LLM backend (Ollama/OpenRouter). The session/message storage still works correctly.
- The `types/` directory contains auto-generated Next.js files — do not edit them manually.
- An unhandled happy-dom error about relative URLs in page tests is a known non-fatal issue (does not cause test failures).
- Per user rules: never run `supabase migrate`, never run builds unless asked, never use the `any` TypeScript type, treat lint warnings during build as critical errors.
