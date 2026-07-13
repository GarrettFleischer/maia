/**
 * @fileoverview Maia-only tools: persona catalog discovery, delegated runs, and persona mutations on disk.
 * @module lib/tools/personas-tools
 */
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import { getSettings } from "../settings";
import {
  clearPersonaCatalogCache,
  getPersonaById,
  getPersonaCatalog,
} from "../personas/registry";
import { runAgent } from "../agent/runner";
import { createProvider } from "../ai/factory";
import { normalizeReasoningEffort } from "../agent/identity";
import type { ReasoningEffort } from "../types";
import {
  assertSafePersonaCatalogId,
  buildPersonaCatalogToml,
} from "../personas/write-catalog";
import { getPersonasDataCatalogDir, getPersonasOverridesDir } from "../data-dir";
import {
  getSessionMeta,
  isMaiaUserThread,
  setSessionDefaultPersonaId,
} from "../history";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>,
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({
      name,
      description,
      parameters: zodToJsonSchema(schema),
    }),
  };
}

const personaListSchema = z.object({});

const personaGetSchema = z.object({
  id: z.string().describe("Persona id (matches `name` in the template TOML)"),
});

const personaRunSchema = z.object({
  persona_id: z.string().describe("Persona id from persona_list"),
  model: z
    .string()
    .describe("Model id from the whitelist (e.g. from settings / data/models.json)"),
  task: z.string().describe("Instructions for this persona turn"),
  reasoning_effort: z
    .enum(["off", "low", "medium", "high"])
    .optional()
    .describe("Reasoning effort for the model call"),
});

const personaOverrideSchema = z.object({
  persona_id: z
    .string()
    .describe(
      "Persona id from persona_list (same basename used under data/personas/overrides/)",
    ),
  markdown: z
    .string()
    .describe(
      "Full markdown body stored at data/personas/overrides/<persona_id>.md (replaces existing override)",
    ),
});

const personaCatalogUpsertSchema = z.object({
  persona_id: z
    .string()
    .describe(
      "Stable slug used as template name/id (letters, digits, hyphen, underscore)",
    ),
  description: z.string().describe("Single-line catalog description"),
  instructions: z
    .string()
    .describe(
      "Primary persona instructions ([instructions].text). Must not contain \"\"\" verbatim.",
    ),
});

const personaSetSessionDefaultSchema = z.object({
  persona_id: z
    .string()
    .nullable()
    .describe(
      "Catalog persona id from persona_list, or null to clear so plain user messages use Maia only until another default is set.",
    ),
});

export const personaListTool = makeTool(
  "persona_list",
  "List available persona templates (Codex-style) Maia can delegate to. Maia only.",
  personaListSchema,
  async (_args, _ctx) => {
    return getPersonaCatalog().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      suggestedModelHint: p.suggestedModelHint,
      sandboxMode: p.sandboxMode,
    }));
  },
);

export const personaGetTool = makeTool(
  "persona_get",
  "Get full persona template text and metadata by id. Maia only.",
  personaGetSchema,
  async ({ id }, _ctx) => {
    const p = getPersonaById(id);
    if (!p) return { error: `Unknown persona: ${id}` };
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      instructions: p.instructions,
      suggestedModelHint: p.suggestedModelHint,
      suggestedReasoningEffort: p.suggestedReasoningEffort,
      sandboxMode: p.sandboxMode,
      sourcePath: p.sourcePath,
    };
  },
);

export const personaRunTool = makeTool(
  "persona_run",
  "Run a persona in the current chat session with a whitelisted model. Appends a delegated user line and the persona reply to the transcript. Maia only.",
  personaRunSchema,
  async (
    { persona_id, model, task, reasoning_effort: reasoningEffort },
    ctx,
  ) => {
    const settings = getSettings(ctx);
    if (!settings.whitelistedModels.includes(model)) {
      return `Model is not whitelisted: ${model}. Choose a model from the whitelist.`;
    }
    const persona = getPersonaById(persona_id);
    if (!persona) {
      return `Unknown persona: ${persona_id}. Use persona_list first.`;
    }
    const effort: ReasoningEffort =
      reasoningEffort !== undefined
        ? normalizeReasoningEffort(reasoningEffort)
        : normalizeReasoningEffort(persona.suggestedReasoningEffort ?? "medium");

    const text = await runAgent(ctx, createProvider, "maia", ctx.sessionId, task, () => {}, {
      personaTurn: {
        id: persona.id,
        name: persona.name,
        instructions: persona.instructions,
        model,
        reasoningEffort: effort,
      },
      delegatedFromMaia: true,
      emitHistoryEntries: true,
      queueCaller: "maia",
    });
    return text !== "" ? text : "(Persona finished with no text.)";
  },
);

export const personaSetSessionDefaultTool = makeTool(
  "persona_set_session_default",
  "Set or clear the catalog persona used for **plain** user messages in this user+Maia thread (no leading @mention). After listing/inspecting personas, call this so follow-up user typing goes to the right specialist; use persona_id null to restore Maia-only turns. Leading @persona on a message always overrides for that turn. Maia only.",
  personaSetSessionDefaultSchema,
  async ({ persona_id }, ctx) => {
    const meta = getSessionMeta(ctx, ctx.sessionId);
    if (!meta) return "No session found.";
    if (!isMaiaUserThread(meta.participants, meta.type)) {
      return "Session default persona only applies to standard user+Maia chat threads.";
    }
    if (persona_id === null) {
      setSessionDefaultPersonaId(ctx, ctx.sessionId, null);
      ctx.events.emit({
        event: "session_updated",
        data: {
          sessionId: ctx.sessionId,
          name: meta.name,
          description: meta.description,
          tags: meta.tags,
          defaultPersonaId: null,
        },
      });
      return "Cleared default persona. Plain user messages will use Maia as orchestrator.";
    }
    const trimmed = persona_id.trim();
    const p = getPersonaById(trimmed);
    if (!p) return `Unknown persona: ${trimmed}. Use persona_list first.`;
    setSessionDefaultPersonaId(ctx, ctx.sessionId, p.id);
    ctx.events.emit({
      event: "session_updated",
      data: {
        sessionId: ctx.sessionId,
        name: meta.name,
        description: meta.description,
        tags: meta.tags,
        defaultPersonaId: p.id,
      },
    });
    return `Default persona for plain user messages set to ${p.name} (\`${p.id}\`). Leading @mentions still override per message.`;
  },
);

export const personaOverrideWriteTool = makeTool(
  "persona_override_write",
  "Replace data/personas/overrides/<persona_id>.md so delegated personas pick up layered instructions after persona_list refreshes (Maia only).",
  personaOverrideSchema,
  async ({ persona_id, markdown }, _ctx) => {
    try {
      assertSafePersonaCatalogId(persona_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
    const overridesRoot = getPersonasOverridesDir();
    await fs.mkdir(overridesRoot, { recursive: true });
    const dest = path.join(overridesRoot, `${persona_id}.md`);
    await fs.writeFile(dest, markdown, "utf-8");
    clearPersonaCatalogCache();
    return { ok: true as const, path: dest };
  },
);

export const personaCatalogUpsertTool = makeTool(
  "persona_catalog_upsert",
  "Create or replace data/personas/catalog/<persona_id>.toml so persona_list gains a new delegated persona (Maia only). Also edit data/agents/maia/PERSONA.md via file_write when refining your own orchestrator persona.",
  personaCatalogUpsertSchema,
  async ({ persona_id, description, instructions }, _ctx) => {
    try {
      assertSafePersonaCatalogId(persona_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
    let body: string;
    try {
      body = buildPersonaCatalogToml({
        id: persona_id,
        description,
        instructions,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
    const catalogRoot = getPersonasDataCatalogDir();
    await fs.mkdir(catalogRoot, { recursive: true });
    const dest = path.join(catalogRoot, `${persona_id}.toml`);
    await fs.writeFile(dest, body, "utf-8");
    clearPersonaCatalogCache();
    return { ok: true as const, path: dest };
  },
);

export const personaManagementTools: Tool[] = [
  personaListTool,
  personaGetTool,
  personaRunTool,
  personaSetSessionDefaultTool,
  personaOverrideWriteTool,
  personaCatalogUpsertTool,
];
