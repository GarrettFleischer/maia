---
name: user-question-and-ask-user-tool
description: Use ask_user to ask the user structured questions with choices and an Other field, then continue with their answers instead of guessing.
---

# User questions and the `ask_user` tool

You can pause your work and ask the user **structured questions** using the `ask_user` tool.

This is useful when:

- The request is **underspecified** and you would otherwise have to guess.
- You need the user to **choose between clear options** (for example, environment, framework, strategy).
- Multiple answers depend on each other and you want them **all at once** before acting.

`ask_user` shows the user a small form with questions and returns:

- The original `questions` you sent (including `id`, `prompt`, any `choices`, and `allowOther`).
- An `answers` object mapping each question `id` to the user’s answer string.

> “Other” answers are returned as `\"Other: <user text>\"`.

## How to call `ask_user`

**Important:** Pass `questions` as a **JSON array of objects**, not as a string. The tool expects the `questions` argument to be an array; do not stringify it.

Each question object has:

- `id` — A short, stable key (for example, `"env"`, `"framework"`, `"scope"`).
- `prompt` — What you want to ask the user in plain language.
- `choices?` — Optional array of option strings (for example, `["staging", "production"]`).
- `allowOther?` — Optional boolean:
  - When `true` and `choices` exist, the user sees an **Other** field for a custom answer.
  - When omitted and `choices` exist, `allowOther` defaults to **true**.
  - When no `choices` are provided, the question is treated as **free text**.

Correct tool call (single question with choices):

```json
{
  "questions": [
    {
      "id": "env",
      "prompt": "Which environment should I operate on?",
      "choices": ["development", "staging", "production"],
      "allowOther": true
    }
  ]
}
```

Correct tool call (multiple questions):

```json
{
  "questions": [
    {
      "id": "framework",
      "prompt": "Which frontend framework should I assume?",
      "choices": ["Next.js", "Remix", "Create React App"],
      "allowOther": true
    },
    {
      "id": "constraints",
      "prompt": "Any important constraints or preferences I should know about?",
      "allowOther": true
    }
  ]
}
```

Wrong: do **not** pass `questions` as a string (e.g. a JSON string of the array). Pass the array directly.

The result from `ask_user` will look like:

```json
{
  "questions": [
    { "id": "framework", "...": "..." },
    { "id": "constraints", "...": "..." }
  ],
  "answers": {
    "framework": "Next.js",
    "constraints": "Prefer minimal new dependencies."
  }
}
```

## When to use `ask_user` vs. regular clarification

Use `ask_user` when:

- The user’s request **depends on discrete choices** (for example, pick one environment, one framework, one deployment target).
- You need to gather **several related decisions at once** before you can design a plan or safely run tools.
- You want to reduce back-and-forth by presenting **clear options plus an Other field** the user can fill in.

Prefer **normal conversational clarification** (plain messages) when:

- You only have **one or two simple follow-up questions** that do not benefit from structured choices.
- The user is already in the middle of a conversation and a short, free-form answer is enough.

Good pattern:

1. Briefly summarize what is unclear and what decisions are needed.
2. Group related questions into a **single** `ask_user` call with 1–5 questions.
3. For each question, provide 2–4 good defaults via `choices`, plus `allowOther` when appropriate.
4. After receiving `answers`, restate the key decisions in 1–2 sentences before proceeding.

## Safety and UX considerations

- Keep prompts and choices **short and scannable**; avoid long paragraphs in options.
- Only ask for information you **truly need** to proceed; avoid overwhelming the user.
- When an action might be destructive or hard to undo (for example, deleting resources, large refactors), use `ask_user` to **confirm scope and intent** first.
- If the user’s answers still leave something important ambiguous, you may follow up with **another small `ask_user` call** or a simple clarifying message.
