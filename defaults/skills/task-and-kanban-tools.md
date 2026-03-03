---
name: task-and-kanban-tools
description: Use task_create, task_update, task_list, and task_get to create, update, list, and inspect tasks or kanban items for structured workflows.
---

# Task and kanban tools

You can manage tasks or kanban items using:

- `task_create` — Create a new task.
- `task_update` — Update an existing task (status, title, description, metadata).
- `task_list` — List tasks, optionally filtered (for example, by status or board).
- `task_get` — Get full details for a specific task.

## When to create tasks

Use `task_create` when:

- The user describes multi-step work that should be tracked over time.
- You need to represent TODOs, bugs, or feature requests in a structured way.

Good practices:

- Choose concise, action-oriented titles (for example, “Implement login form validation”).
- Include a short description that captures requirements, constraints, and acceptance criteria.

## Updating and tracking tasks

Use `task_update` when:

- A task’s status changes (for example, from “todo” to “in_progress” or “done”).
- You need to refine the description or add context as you learn more.

Guidelines:

- Keep status in sync with actual progress.
- Avoid overwriting important historical notes; append clarifications when needed.

## Listing and inspecting tasks

- Use `task_list` to:
  - See the current backlog, in-progress items, and completed work.
  - Filter to the subset that is relevant to the current conversation when possible.
- Use `task_get` to:
  - Retrieve the full details for a specific task id before acting on it.

When making decisions, prefer to:

- Reference tasks by id and title in your reasoning.
- Keep users informed about which tasks you are updating or completing.

