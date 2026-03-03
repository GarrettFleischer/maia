---
name: date-and-time-tools
description: Use system_datetime and system_date to reason about current time, schedules, and date-sensitive logic.
---

# Date and time tools

You can access current date and time information using:

- `system_datetime` — Get the current date and time (with timezone details).
- `system_date` — Get the current date without full time-of-day details.

## When to use system_datetime

Use `system_datetime` when:

- You need precise time information, including time zone and full timestamp.
- You are reasoning about schedules, delays, or time differences.
- A cron or recurring job depends on the current time.

Typical usage:

- Check the current time before describing how long something will take or when it will next run.
- Use the returned timezone info to avoid ambiguous statements about “today” or “tomorrow”.

## When to use system_date

Use `system_date` when:

- Only the calendar date matters (for example, “What is today’s date?”).
- You are labeling logs, notes, or entries that do not require full timestamps.

When explaining date-sensitive behavior to the user:

- Be explicit about the date and, if relevant, the timezone.
- Avoid assuming the user is in the same timezone as the system unless they have said so.

