---
name: fix
description: Verifies a fix by running typecheck, compile, unit tests, then e2e tests in order. Use when the user asks to verify a fix, run the fix workflow, or after making code changes to confirm nothing is broken (TDD: run tests as part of completing any implementation). When fixing unused variables or parameters, remove them or migrate usages—do not hide warnings with underscores.
---

# Fix verification workflow

Run these four steps **in order**. Run each command **by itself**—do not redirect output or pipe one command into another. Stop at the first failure and report the error.

## Step 1: Typecheck

```bash
bun run typecheck
```

(Equivalent to `bunx tsc --noEmit`.)

If this fails, fix TypeScript errors before proceeding.

## Handling unused code (params, variables)

When typecheck or lint reports **unused** parameters, variables, or imports:

1. **Do not silence with an underscore.** Do not rename to `_param` or `_unused` just to hide the warning.
2. **Actually remove or use them:**
   - If a parameter/variable is truly unused: remove it from the signature or delete the declaration, and update all call sites (e.g. remove the argument, or use a rest param if the API requires the slot).
   - If it *should* be used: add the proper usage (e.g. pass it through, log it, or use it in logic).
3. **Migrate existing underscore-prefixed names:** When touching code that already has `_param` or `_foo`:
   - If the value is never used: remove the parameter/variable and fix call sites (same as above).
   - If the value is used elsewhere (e.g. in a type, or passed to another function): keep it but consider renaming to a meaningful name; only keep a leading underscore if the API (e.g. callback signature) requires the parameter to be present but unused.

Treat unused-code warnings as real issues to fix, not to hide.

## Step 2: Build

```bash
bun run compile
```

If this fails, fix the build before proceeding.

## Step 3: Unit tests

```bash
bun test
```

If this fails, fix failing tests before proceeding.

## Step 4: E2E tests

```bash
bun run test:e2e
```

If this fails, fix failing e2e tests before proceeding.

## Summary

| Step   | Command              | Stop on failure |
|--------|----------------------|-----------------|
| 1      | `bun run typecheck`  | Yes             |
| 2      | `bun run compile`    | Yes             |
| 3      | `bun test`           | Yes             |
| 4      | `bun run test:e2e`   | Yes             |

Only report success when all four steps complete without errors.
