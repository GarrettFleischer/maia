import type { DynamicToolDeps } from "../../../../src/tools/loader.js";
import type { AgentTool } from "../../../../src/agent/tools/base.js";

export function createTool(deps: DynamicToolDeps): AgentTool {
  return {
    name: "sample_tool",
    description: "A sample dynamic tool for tests.",
    definition() {
      return {
        name: "sample_tool",
        description: "A sample dynamic tool for tests.",
        parameters: { type: "object", properties: {} },
      };
    },
    async execute(_args: Record<string, unknown>, _context: unknown) {
      deps.logger.debug("sample_tool executed");
      return { content: "sample ok", success: true };
    },
  };
}
