/**
 * @fileoverview Tests for cron wake preset inference and apply helpers (UI + API alignment).
 * @module __tests__/lib/cron/wake-presets
 */

import { describe, it, expect } from "bun:test";
import {
  applyCronWakePreset,
  inferCronWakePreset,
  normalizeCronBody,
} from "@/lib/cron/wake-presets";
import { DEFAULT_CRON_WAKE_PROMPT } from "@/lib/cron/default-wake-prompt";

describe("normalizeCronBody", () => {
  it("trims and normalizes CRLF", () => {
    expect(normalizeCronBody("  a\r\nb  ")).toBe("a\nb");
  });
});

describe("inferCronWakePreset", () => {
  it("returns legacy when no persona and no cron message", () => {
    expect(inferCronWakePreset({ personaId: null, cronMessage: null })).toBe(
      "legacy",
    );
    expect(inferCronWakePreset({ personaId: "", cronMessage: undefined })).toBe(
      "legacy",
    );
  });

  it("returns persona when personaId set", () => {
    expect(
      inferCronWakePreset({
        personaId: "typescript-pro",
        cronMessage: null,
      }),
    ).toBe("persona");
  });

  it("returns prompt_default when cron message matches shipped default", () => {
    expect(
      inferCronWakePreset({
        personaId: null,
        cronMessage: DEFAULT_CRON_WAKE_PROMPT,
      }),
    ).toBe("prompt_default");
  });

  it("returns prompt_custom for other non-empty cron messages", () => {
    expect(
      inferCronWakePreset({
        personaId: null,
        cronMessage: "Hello cron",
      }),
    ).toBe("prompt_custom");
  });
});

describe("applyCronWakePreset", () => {
  const slice = {
    personaId: "x",
    personaModel: "y",
    cronMessage: "keep-me",
  };

  it("legacy clears persona and cron fields", () => {
    expect(applyCronWakePreset("legacy", slice)).toEqual({
      personaId: "",
      personaModel: "",
      cronMessage: "",
    });
  });

  it("prompt_default clears persona and injects default message", () => {
    const out = applyCronWakePreset("prompt_default", slice);
    expect(out.personaId).toBe("");
    expect(out.personaModel).toBe("");
    expect(normalizeCronBody(out.cronMessage)).toBe(
      normalizeCronBody(DEFAULT_CRON_WAKE_PROMPT),
    );
  });

  it("prompt_custom clears persona and keeps non-empty cron message", () => {
    expect(applyCronWakePreset("prompt_custom", slice)).toEqual({
      personaId: "",
      personaModel: "",
      cronMessage: "keep-me",
    });
  });

  it("prompt_custom seeds starter text when cron message empty", () => {
    const out = applyCronWakePreset("prompt_custom", {
      personaId: "",
      personaModel: "",
      cronMessage: "   ",
    });
    expect(out.cronMessage).toContain("[CRON]");
    expect(out.personaId).toBe("");
  });

  it("persona clears cron message for server default optional prompt", () => {
    expect(
      applyCronWakePreset("persona", {
        personaId: "",
        personaModel: "",
        cronMessage: "noise",
      }),
    ).toEqual({
      personaId: "",
      personaModel: "",
      cronMessage: "",
    });
  });
});
