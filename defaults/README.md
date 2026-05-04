# Default agent templates

These files seed **future** agents when Maia creates them or when her directory is filled on first run. Editing templates here changes defaults only for **new** agents; existing agent folders are not rewritten.

---

## models.json (whitelisted AI models)

**models.json** at the root of this folder is copied to **data/models.json** on first run (or migrated from existing DB settings if upgrading). It defines the whitelisted models and their optional generation parameters.

- Each entry has **provider** (e.g. `ollama`, `openrouter`), **name** (e.g. `llama3.2`, `anthropic/claude-3.5-haiku`), and optional params (temperature, top_p, top_k, min_p, presence_penalty, repetition_penalty, options).
- Model id in the app is **provider/name** (e.g. `ollama/llama3.2`).
- Edit **data/models.json** at runtime to add/remove models or change params; the settings UI reads and writes that file.
- **Unsloth (Hugging Face) models**: Pull with `ollama pull hf.co/<name>` (e.g. `ollama pull hf.co/unsloth/GLM-4.7-Flash-GGUF:UD-Q3_K_XL`). If Ollama lists the model under a different name after pull, use that name in **data/models.json**. Entries use `UD-Q3_K_XL` / `UD-Q4_K_M` etc. for &lt;15GB RAM where possible.

---

## Who gets which defaults

| Item | Maia (first run) | Other agents (`agent_create`) |
|------|------------------|-------------------------------|
| **PERSONA.md** | `defaults/maia/` then `defaults/agent/` | `defaults/agent/` |
| **USER.md** | `defaults/maia/` then `defaults/agent/` | `defaults/agent/` |

- Maia pulls missing files from `defaults/maia/` first, then falls back to `defaults/agent/` (then inline fallbacks in code).
- New agents receive **`PERSONA.md`** and **`USER.md`** from `defaults/agent/` after substitution.

Put orchestrator-specific prose in **`defaults/maia/PERSONA.md`**; put the shared agent shell in **`defaults/agent/`**.

---

## File roles

- **PERSONA.md** — Behavioral shell and evolving guidance for this agent (who they are, how they work inside Maia). Long-lived facts belong under **`memory/`** and **`user/`** with **knowledge_search** / layered-memory tools rather than endless persona prose.
- **USER.md** — What this agent knows about the user(s). Updated through normal file tools as the relationship evolves.

Skills under **`defaults/skills/`** ship guidance copied into **`data/skills/`** on bootstrap; routing matches snippets against the active prompt.

---

## How agents use these files

- **Each turn**: `buildSystemPrompt` injects trimmed **`PERSONA.md`** (plus security preamble, agent id, optional project-root **`PERSONA.md`**, and matched skills). Facts under **`memory/`** / **`user/`** stay on disk until retrieval tools pull them in.
- **Updates**: Agents edit **`PERSONA.md`** and **`USER.md`** with **`file_write`** / **`file_patch`** scoped to their agent directory (Maia can manage her own tree or coordinate updates for others via **`agent_management`**).
