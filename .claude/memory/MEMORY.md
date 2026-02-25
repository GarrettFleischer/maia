# Maia Project Memory

## Package Manager
- Always use **bun** (not npm or yarn)

## Project
- Next.js 16 app at F:/Development/maia
- React 19, Tailwind v4, TypeScript strict mode
- Path alias: `@/*` → `./src/*`
- Shell: bash on Windows — use `/f/Development/maia` (not `F:\\`)

## Architecture
- Full agentic system: agents, sessions, tools, SSE streaming
- DB: better-sqlite3 (SQLite), no ORM
- See docs/ for full architecture specs
