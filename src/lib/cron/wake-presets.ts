/**
 * @fileoverview Cron wake preset helpers for the Cron UI (infer current mode, apply preset field patches).
 * @module lib/cron/wake-presets
 */

import { DEFAULT_CRON_WAKE_PROMPT } from "./default-wake-prompt";

/** @brief Wake modes surfaced as a single dropdown in CronView. */
export type CronWakePresetId =
  | "legacy"
  | "prompt_default"
  | "prompt_custom"
  | "persona";

/** @brief Persona / cron message slice edited in CronView. */
export interface CronWakeFormSlice {
  personaId: string;
  personaModel: string;
  cronMessage: string;
}

/** Short hints under the preset `<select>` (plain sentences). */
export const CRON_WAKE_PRESET_HINTS: Record<CronWakePresetId, string> = {
  legacy:
    "Runs with user message [CRON] and forces the tool + JSON args below (classic behavior).",
  prompt_default:
    "Runs Maia (or another target agent) with the shipped task-board wake paragraph—no forced initial tool call.",
  prompt_custom:
    "Runs with your cron message only; edit the textarea. Persona fields stay cleared.",
  persona:
    'Targets maia with a catalog persona slug + whitelist model; leave cron message empty to use the server default task-board paragraph for that persona wake.',
};

/** Starter body when switching to custom prompt while the textarea is blank. */
const PROMPT_CUSTOM_STARTER = `[CRON]

(Edit this wake instruction.)`;

/**
 * @brief Normalizes cron message bodies for equality checks (trim + CRLF → LF).
 * @param body - Raw markdown/text
 * @returns Normalized string
 */
export function normalizeCronBody(body: string): string {
  return body.trim().replace(/\r\n/g, "\n");
}

/**
 * @brief Infers dropdown preset id from persisted cron job fields.
 * @param job - persona id + cron message from API / SQLite mapping
 * @returns Preset id for the UI select
 */
export function inferCronWakePreset(job: {
  personaId?: string | null;
  cronMessage?: string | null;
}): CronWakePresetId {
  if (job.personaId?.trim()) return "persona";
  if (
    job.cronMessage != null &&
    normalizeCronBody(String(job.cronMessage)) !== ""
  ) {
    if (
      normalizeCronBody(String(job.cronMessage)) ===
      normalizeCronBody(DEFAULT_CRON_WAKE_PROMPT)
    ) {
      return "prompt_default";
    }
    return "prompt_custom";
  }
  return "legacy";
}

/**
 * @brief Applies a preset by returning new persona/cron slice (callers merge into full form).
 * @param preset - Selected wake style
 * @param current - Current slice (used by **prompt_custom** to retain or seed text)
 * @returns Replacement slice for persona id, persona model, and cron message fields
 */
export function applyCronWakePreset(
  preset: CronWakePresetId,
  current: CronWakeFormSlice,
): CronWakeFormSlice {
  switch (preset) {
    case "legacy":
      return { personaId: "", personaModel: "", cronMessage: "" };
    case "prompt_default":
      return {
        personaId: "",
        personaModel: "",
        cronMessage: DEFAULT_CRON_WAKE_PROMPT,
      };
    case "prompt_custom": {
      const trimmed = current.cronMessage.trim();
      const cronMessage = trimmed !== "" ? current.cronMessage : PROMPT_CUSTOM_STARTER;
      return {
        personaId: "",
        personaModel: "",
        cronMessage,
      };
    }
    case "persona":
      return {
        personaId: "",
        personaModel: "",
        cronMessage: "",
      };
    default: {
      const _exhaustive: never = preset;
      return _exhaustive;
    }
  }
}
