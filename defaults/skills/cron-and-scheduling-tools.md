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

- The user wants a task to run automatically at specific times (for example, daily summaries, periodic checks).
- There is a clear, repeatable action that can be expressed as a tool call with fixed arguments.

Best practices:

- Be explicit about the schedule (time zone, frequency) and the tool/action to run.
- Confirm the schedule with the user before creating jobs that have side effects.

## Inspecting and managing jobs

- Use `cron_list` to:
  - See what jobs already exist.
  - Avoid creating duplicate or conflicting schedules.
- Use `cron_delete` when:
  - A job is no longer needed.
  - The user requests to stop or replace a scheduled task.

For testing:

- Use `cron_echo` to verify that the scheduling pipeline works end-to-end before scheduling more complex jobs.

Always clearly communicate in your reasoning (and, when appropriate, to the user) which job ids you have created, modified, or deleted.

