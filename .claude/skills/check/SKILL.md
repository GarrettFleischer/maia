---
name: check
description: Run TypeScript typecheck, fix errors, build, fix errors, then report on results. Use when the user wants to validate the codebase compiles and builds cleanly.
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

Run the full check pipeline for this Next.js + TypeScript project using **bun**. Work through each phase in order, fixing errors before moving to the next phase.

## Phase 1 — TypeScript Typecheck

```
cd /f/Development/maia && bun run tsc --noEmit 2>&1
```

- Parse all type errors from the output (format: `file(line,col): error TSxxxx: message`)
- Fix every error. Read the relevant files before editing them.
- Re-run typecheck after fixes until it passes with zero errors.

## Phase 2 — Build

```
cd /f/Development/maia && bun run build 2>&1
```

- Parse all build errors (Next.js build errors, module resolution failures, etc.)
- Fix every error. Re-run build after fixes until it succeeds.

## Phase 3 — Report

After both phases pass cleanly, output a structured report:

```
## Check Report

### TypeScript
✓ No type errors

### Build
✓ Build succeeded

### Fixes Applied
- <file>: <description of what was wrong and what was changed>
- (or "None required" if everything passed first try)

### Hypotheses
- <any patterns noticed, e.g. "The zod-to-json converter doesn't handle ZodDefault — worth adding if tools start using default values">
- <any risky areas spotted even if not currently erroring>
- (or "None" if no observations)
```

## Rules

- Always use `bun` — never `npm` or `npx`
- Fix root causes, not symptoms — don't cast to `any` or add `@ts-ignore` unless truly necessary and clearly commented
- If a fix is uncertain, note it in the Hypotheses section
- If errors exceed 20 and seem systematic, identify the pattern first before fixing individually
- Do not run `bun dev` or `bun start` — only typecheck and build
