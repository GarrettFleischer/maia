---
name: agent-creation-and-lifecycle
description: Full process for creating a new agent (Maia only): instantiate with agent_create, set soul, create an initial task, and schedule a cron job for the agent so it can review tasks and continue work or alert the user when done.
---

# Agent creation and lifecycle (Maia only)

Use this skill when you need to create a new agent and wire it into the task board and cron so it can run on a schedule. Only Maia should perform this workflow.

## 1. Instantiate the agent

Use **`agent_create`** with:

- `name` — display name for the agent
- `model` — model id from the whitelist (e.g. from `data/models.json` or `defaults/models.json`); if not whitelisted, a default is used
- `soul` (optional) — initial SOUL.md content; if omitted, defaults are copied from `defaults/agent/`
- `extra` (optional) — additional system instructions (stored as `system_prompt_extra`)

This creates the agent record, creates `data/agents/<id>/`, and copies default template files (SOUL.md, AGENTS.md, workspace, memory, user). If you pass `soul`, it overwrites SOUL.md.

## 2. Soul

Either pass `soul` into `agent_create` or edit `data/agents/<id>/SOUL.md` after creation (e.g. via file tools) to define who the agent is.

## 3. Initial task on the task board

Use **`task_create`** to add at least one task for the new agent. Optionally use **`task_update`** with `assign` to assign it to the new agent so they have work from the start.

## 4. Schedule a cron job for the agent

**You decide the time and frequency.** There is no automatic scheduling.

- Use **`cron_schedule`** to create a job for the new agent:
  - Target agent id (the new agent)
  - Cron expression (e.g. `0 */2 * * *` for every 2 hours)
  - Tool: `cron_echo`
  - Args: e.g. `{ msg: "Review your tasks and continue work." }`
- Use **`cron_list`** to see existing jobs and choose times that **do not overlap** with other agents so they run at different times.

Create or adjust these jobs as needed; Maia is responsible for ensuring each active agent has an appropriate cron job.

## 5. What the cron run does

When the job fires, the runner invokes the scheduled tool (typically `cron_echo` with your message) and the agent sees `[CRON]` plus the tool result. The intent of these runs is for the agent to:

- **Review their tasks** and **continue work**, or
- If they have **no tasks**: **create an appropriate new task** or **alert the user** that their job is done.

## Heartbeat (brief)

Maia’s heartbeat assigns unassigned tasks and messages agents with no tasks to create tasks and mark one in progress. Agents actually run when their cron jobs fire (created by you via `cron_schedule`).
