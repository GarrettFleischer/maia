# Ollama Modelfile updates for Unsloth models

The script `update-ollama-modelfiles.ps1` updates Modelfiles for Unsloth models so they support **tools** and **reasoning** in Ollama (and in Maia).

## What the script does

- **Qwen3.5** models: If you have **qwen3.5** installed, the script **merges** the official Modelfile with your Unsloth model: it keeps your model's `FROM` (blob) lines and uses everything else (template, parameters, PARSER/RENDERER) from the official model. That makes Ollama mark the model as thinking-capable so `think: true` no longer returns 400. If qwen3.5 is not installed, it falls back to a built-in template and adds PARSER/RENDERER (thinking may still return 400 until you pull qwen3.5 and re-run).
- **Ministral / Devstral** models: Uses the Devstral tool-calling template and stop sequences.
- **GLM-4.7** models: Appends PARSER/RENDERER for thinking (see below).

## Why you get 400 "does not support thinking"

Ollama checks the **model manifest** (built at `ollama create` time) for a "thinking" capability before accepting `think: true`. Custom GGUF imports often don't get that set, so the server returns 400 before running the model. Unsloth's **`enable_thinking`** (e.g. in `--chat-template-kwargs`) is for **llama-server** only and is not an Ollama Modelfile or API parameter. The fix is to merge from the **official qwen3.5** Modelfile so the manifest matches a known thinking-capable model. Pull it once (`ollama pull qwen3.5`), then re-run the script.

## Extra parameters for reasoning

1. **Merge from official qwen3.5** – For Qwen3.5 Unsloth models, the script does this automatically when you have qwen3.5 installed. That gives you the full template and manifest so thinking works.
2. **Template** – The template must include the `.Thinking` block; the official Modelfile has it.
3. **PARSER and RENDERER** – The official Modelfile includes these. For the fallback path or GLM:
   - **Qwen3.5** (fallback): `PARSER qwen3` and `RENDERER qwen3`.
   - **GLM-4.7-Flash**: `PARSER glm-4.7` and `RENDERER glm-4.7` (the script adds these for GLM).

If reasoning still doesn't work after re-running the script, pull qwen3.5 and run the script again so the merge path is used; ensure Ollama is up to date.

## Running the script

From the repo root:

```powershell
.\scripts\update-ollama-modelfiles.ps1
```

Generated Modelfiles are written to `scripts/ollama-modelfiles/`. Then run `ollama create <name> -f <modelfile>` (the script does this for each model).

## References

- [Ollama thinking capability](https://docs.ollama.com/capabilities/thinking)
- [Ollama issue #14212](https://github.com/ollama/ollama/issues/14212) – GLM-4.7-Flash with thinking via PARSER/RENDERER
