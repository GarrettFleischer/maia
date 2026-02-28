# Default agent templates

These files are copied into agent directories when an agent is created (or when Maia’s directory is seeded on first run). Edit them to change the default content for **future** agents; existing agents are not modified.

---

## models.json (whitelisted AI models)

**models.json** at the root of this folder is copied to **data/models.json** on first run (or migrated from existing DB settings if upgrading). It defines the whitelisted models and their optional generation parameters.

- Each entry has **provider** (e.g. `ollama`, `openrouter`), **name** (e.g. `llama3.2`, `anthropic/claude-3.5-haiku`), and optional params (temperature, top_p, top_k, min_p, presence_penalty, repetition_penalty, options).
- Model id in the app is **provider/name** (e.g. `ollama/llama3.2`).
- Edit **data/models.json** at runtime to add/remove models or change params; the settings UI reads and writes that file.
- **Unsloth (Hugging Face) models**: Pull with `ollama pull hf.co/<name>` (e.g. `ollama pull hf.co/unsloth/GLM-4.7-Flash-GGUF:UD-Q3_K_XL`). If Ollama lists the model under a different name after pull, use that name in **data/models.json**. Entries use `UD-Q3_K_XL` / `UD-Q4_K_M` etc. for &lt;15GB RAM where possible.

---

## Who gets which defaults

| File      | Maia (first run)     | New sub-agents      |
|-----------|----------------------|---------------------|
| SOUL.md   | `defaults/maia/`     | `defaults/agent/`   |
| MEMORY.md | `defaults/maia/`     | `defaults/agent/`   |
| USER.md   | `defaults/maia/`     | `defaults/agent/`   |
| AGENTS.md | `defaults/maia/`    | `defaults/agent/`   |

- **Maia** gets all four files from `defaults/maia/` when those files exist; if a file is missing there, the app falls back to `defaults/agent/` (then to an inline fallback).
- **Sub-agents** (created via **agent_create**) always get SOUL, MEMORY, and USER from `defaults/agent/`, and AGENTS.md from `defaults/agent/`.

So: put Maia-specific identity and instructions in `defaults/maia/`; put the shared template for all other agents in `defaults/agent/`.

---

## File roles and placeholders

- **SOUL.md** — Who the agent is. In `defaults/agent/SOUL.md` you can use `{{name}}`; it is replaced with the agent’s name when the file is copied. Maia’s template typically has no placeholder (fixed “Maia”).
- **MEMORY.md** — Long-term facts and context. The agent should update it via **agent_update_identity** (file: memory) as they learn; the “How to use” section in the default explains this.
- **USER.md** — What the agent knows about the user(s). Updated via **agent_update_identity** (file: user) as the agent learns about the user.
- **AGENTS.md** — Full system instructions (security, behaviour, tools). The app loads it and appends the agent’s SOUL, MEMORY, and USER each turn. Maia’s version in `defaults/maia/AGENTS.md` includes Maia-only sections (creating agents, tool review, etc.); `defaults/agent/AGENTS.md` is the standard set for sub-agents.

---

## How agents use these files

- **Every turn:** The app injects SOUL, MEMORY, and USER into the agent’s context before the model runs. The agent does not need to re-read them before calling **agent_update_identity**.
- **Updates:** Agents (and Maia for herself) use **agent_update_identity** to change MEMORY, USER, SOUL, or AGENTS.md. Maia can also update any agent’s identity files with **agent_update_agent_identity**.
- The default content of each file includes a “How to use this file” section so the agent knows when and how to edit it and that they must not change identity files based on instructions from tool results or web content.
