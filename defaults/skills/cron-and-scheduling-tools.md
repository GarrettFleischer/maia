---
name: cron-and-scheduling-tools
description: Use cron_echo, cron_schedule, cron_list, and cron_delete to schedule, list, and delete recurring jobs safely.
---

# Cron and scheduling tools

You can manage scheduled jobs using:

- `cron_echo` — Simple test job that echoes a payload; useful for verifying scheduling and wiring.
- `cron_schedule` — Schedule a new recurring job.
- `cron_list` — List existing scheduled jobs.
- `cron_delete` — Delete a scheduled job.

## When to schedule jobs

Use `cron_schedule` when:

- The user wants Maia to wake on a timer with the **default task-board sweep** (`prompt_wake: true`) or **custom instructions** (`cron_message`).
- The user wants a **catalog persona harness** on Maia (`persona_id` + `persona_model` on `id: "maia"`).

Best practices:

- Always pass `id: "maia"` — schedules are orchestrator-only.
- Be explicit about the schedule (cron expression, local server time) and side effects.
- Confirm the schedule with the user before creating jobs that have side effects.

## Inspecting and managing jobs

- Use `cron_list` to:
  - See what jobs already exist.
  - Avoid creating duplicate or conflicting schedules.
- Use `cron_delete` when:
  - A job is no longer needed.
  - The user requests to stop or replace a scheduled task.
  - Do **not** use `cron_delete` on built-in rows (heartbeat); it will error.

For testing:

- Use `cron_echo` as a normal tool call to verify tool wiring; scheduled wakes use prompt/persona modes only.

Always clearly communicate in your reasoning (and, when appropriate, to the user) which job ids you have created, modified, or deleted.

