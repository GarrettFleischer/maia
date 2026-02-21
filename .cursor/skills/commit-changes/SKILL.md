---
name: commit-changes
description: Commits repository changes with conventional-commit titles and optional bodies. Groups changes by feature or type and creates one commit per logical group; can stage selected files or all changes. Use when the user asks to commit changes, save work, create a commit, or "commit with an appropriate message."
---

# Commit changes

Commit current changes with accurate titles and optional bodies. **Group by logical feature or change type** and make **one commit per group**; use a single commit only when everything clearly belongs together.

## Workflow

1. **Inspect changes**  
   Run `git status` and `git diff` (and `git diff --staged` if needed) to see all modified/added/deleted files and hunks.

2. **Group changes**  
   From the diff, identify logical groups. Examples:
   - One feature (e.g. settings API + settings page + tests) → one commit.
   - Separate features (e.g. agents page + settings page) → one commit per feature.
   - Mixed: new feature + dependency bump + docs → e.g. `feat(...)`, then `chore(deps)`, then `docs(...)`.
   Group by **purpose**, not just by file: related files that implement one change belong in one commit.

3. **For each group (in dependency order if relevant)**  
   - **Stage only that group:**  
     - By path: `git add <path1> <path2> ...` for the files (or directories) that belong to this commit.  
     - If a file contains changes for more than one group, use `git add -p <file>` and stage only the hunks for this group.  
   - **Compose the message** (see below).  
   - **Commit:** `git commit -m "Title" -m "Body"` or `git commit -m "Title"` if no body.  
   Repeat until all groups are committed.

4. **Message format**  
   - **Title (required):** One line, imperative, conventional-commit.  
     Format: `type(scope): short description`  
     Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`, `perf`, `ci`, `build`.  
   - **Body (optional):** Brief summary of what and why; skip if the title is enough.

## Staging options

| Goal | Command |
|------|--------|
| Entire files for one commit | `git add path/to/file1 path/to/file2` |
| Whole directory for one commit | `git add path/to/dir/` |
| Only some hunks in a file | `git add -p path/to/file` (choose y/n per hunk) |
| Everything in one commit | `git add -A` then single `git commit` |

## Title examples

| Change | Example title |
|--------|----------------|
| New API route | `feat(api): add settings GET/POST route` |
| Bug in date display | `fix: correct timezone in report dates` |
| Dependencies only | `chore: update bun and lockfile` |
| Tests for a feature | `test(agents): add page and list tests` |
| Lint/format only | `style: fix lint in agents page` |
| Docs only | `docs: update PLAN.md encryption section` |

## Rules

- **Do not** run `git push` unless the user asks to push.
- **Do not** amend, rebase, or reset; only add and commit.
- Derive messages from the actual diff; no generic or guessed messages.
- **Multiple commits by default:** one commit per logical feature/change group. Use a single commit only when all current changes clearly form one change (e.g. one small fix across two files).
