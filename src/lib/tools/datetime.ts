/**
 * @fileoverview Tools for retrieving the current host system date and time.
 * @module lib/tools/datetime
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { getCurrentSystemDateTime } from "../date-time";
import type { Tool, ToolContext } from "./types";

const emptyArgsSchema = z
  .object({})
  .describe("No parameters; always call with an empty object.");

/**
 * @brief Get the current system date and time in multiple formats.
 * @param _args Unused, the tool takes no arguments.
 * @param _ctx Tool execution context (unused; included for consistency with other tools).
 * @returns Object containing ISO (UTC), local string, and timezone identifier.
 * @example
 * const result = await systemDateTimeTool.execute({}, ctx);
 * // result.iso -> \"2026-02-24T15:04:05.000Z\"
 */
export const systemDateTimeTool: Tool<z.infer<typeof emptyArgsSchema>> = {
  name: "system_datetime",
  description:
    "Get the current host system date and time in ISO 8601 (UTC), local string, and timezone identifier formats. Example: system_datetime({}).",
  schema: emptyArgsSchema,
  toDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: zodToJsonSchema(emptyArgsSchema),
    };
  },
  async execute(_args, _ctx: ToolContext) {
    return getCurrentSystemDateTime();
  },
};

/**
 * @brief Get only the current system calendar date in local time.
 * @param _args Unused, the tool takes no arguments.
 * @param _ctx Tool execution context (unused; included for consistency with other tools).
 * @returns Object with the current date as YYYY-MM-DD and ISO datetime in UTC.
 * @example
 * const result = await systemDateTool.execute({}, ctx);
 * // result.date -> \"2026-02-24\"
 */
export const systemDateTool: Tool<z.infer<typeof emptyArgsSchema>> = {
  name: "system_date",
  description:
    "Get the current host system calendar date as YYYY-MM-DD (local time), plus the ISO 8601 datetime in UTC. Example: system_date({}).",
  schema: emptyArgsSchema,
  toDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: zodToJsonSchema(emptyArgsSchema),
    };
  },
  async execute(_args, _ctx: ToolContext) {
    const { iso } = getCurrentSystemDateTime();
    const date = iso.slice(0, 10);
    return { date, iso };
  },
};

/**
 * @brief Collection of date/time tools exposed to agents.
 * @returns Array of datetime-related tools (system_datetime, system_date).
 */
export const dateTimeTools: Tool[] = [systemDateTimeTool, systemDateTool];

