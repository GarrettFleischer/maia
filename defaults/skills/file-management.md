---
name: workspace-and-file-management
description: Work safely in the workspace (~), navigate to the agent root, and use file tools without breaking project conventions.
---

# Workspace and file management

From your perspective:

- `~` is your **workspace directory** where you run commands and edit working files.
- The **agent root** is `..` from `~`; it contains:
  - `PERSONA.md` (identity / persona prose).
  - `memory/` and `user/` (long-term facts and user context).

Always be explicit about where you are operating:

- Treat relative paths as relative to `~` unless specifically going up to the agent root.
- Use `../` when you intentionally need to reach identity or memory files.

## Reading before writing

Before changing any file:

- **Read the file first** using the appropriate file tool from `~`.
- Look for existing patterns, conventions, and comments that describe constraints.
- Respect generated files and user rules (for example, do not edit auto-generated types or database schema snapshots).

Avoid creating duplicate components or utilities:

- Prefer using existing components and helpers when they already implement the needed behavior.
- Search the codebase or use knowledge tools before introducing new files with overlapping responsibilities.

## Editing files safely

When you modify files:

- Keep changes focused and minimal; avoid unrelated refactors in the same edit.
- Follow project coding standards and commenting style (including any @fileoverview, @module, and param/returns documentation requirements).
- For TypeScript, avoid `any`; choose precise types aligned with existing patterns.

If you need to create new files:

- Place them in the appropriate directory under `~` according to project structure.
- Add a short header or comment block if the project expects it (for example, @fileoverview and @module).

## Navigating between workspace and agent root

Use the directory structure intentionally:

- Work primarily in `~` for implementation files, tests, and temporary artifacts.
- Go up one level to the agent root when you need to:
  - Inspect or update `PERSONA.md`.
  - Add or read facts in `memory/` and `user/`.

Do not assume paths contain a folder literally named `data`; refer instead to:

- `~` for the current workspace.
- `..` for the agent root where identity and memory live.

