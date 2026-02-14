/**
 * @fileoverview Writes an approved tool proposal to the tools folder as TypeScript + manifest.
 * @module tools/write-approved-tool
 *
 * @brief Creates tools/<name>/manifest.json and tools/<name>/index.ts so the
 * dynamic tool loader can discover and load the tool for all agents.
 */

import type { FileSystem, Logger } from "../core/types.js";
import type { ToolProposal } from "./proposals.js";

/**
 * @brief Writes the approved tool to the tools directory.
 * @param fs - Filesystem to write to
 * @param toolsDir - Absolute path to the tools directory
 * @param proposal - Approved tool proposal (status user_approved)
 * @param logger - Logger
 * @throws Error if proposal is invalid or write fails
 *
 * @example
 * await writeApprovedTool(fs, `${workspacePath}/tools`, proposal, logger);
 */
export async function writeApprovedTool(
  fs: FileSystem,
  toolsDir: string,
  proposal: ToolProposal,
  logger: Logger
): Promise<void> {
  const name = proposal.name.trim();
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid tool name for disk: ${name}`);
  }

  await fs.mkdir(toolsDir).catch(() => {});

  const dir = `${toolsDir}/${name}`;
  const manifestPath = `${dir}/manifest.json`;
  const indexPath = `${dir}/index.ts`;

  let paramsSchema: Record<string, unknown>;
  try {
    paramsSchema = JSON.parse(proposal.parametersJson) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid parameters_json for tool proposal");
  }

  const manifest = {
    name,
    description: proposal.description.trim(),
    functions: [
      {
        name,
        description: proposal.description.trim(),
        parametersSchema: paramsSchema,
      },
    ],
  };
  await fs.mkdir(dir).catch(() => {});
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  let indexContent: string;
  const config = proposal.implementationConfigJson
    ? (JSON.parse(proposal.implementationConfigJson) as Record<string, unknown>)
    : null;
  const code = config?.code as string | undefined;
  if (proposal.implementationType === "inline" && typeof code === "string" && code.trim().length > 0) {
    indexContent = code.trim();
  } else {
    indexContent = generateStubTool(name, proposal.description.trim(), paramsSchema);
  }
  await fs.writeFile(indexPath, indexContent);
  logger.info("Approved tool written to tools folder", { name, dir });
}

/**
 * @brief Generates a minimal stub index.ts that exports createTool. Self-contained so it can be
 * loaded from any path (workspace/tools/<name>/index.ts) without importing from the app.
 */
function generateStubTool(
  toolName: string,
  description: string,
  parametersSchema: Record<string, unknown>
): string {
  const paramsJson = JSON.stringify(parametersSchema, null, 2);
  const nameEsc = toolName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `/**
 * Dynamic tool: ${nameEsc}
 * Generated from approved proposal. Edit as needed.
 */
export function createTool(deps: { logger: { debug: (msg: string, meta?: unknown) => void } }) {
  const { logger } = deps;
  return {
    name: "${nameEsc}",
    description: ${JSON.stringify(description)},

    definition() {
      return {
        name: "${nameEsc}",
        description: ${JSON.stringify(description)},
        parameters: ${paramsJson.replace(/\n/g, "\n        ")},
      };
    },

    async execute(args: Record<string, unknown>, _context: unknown) {
      logger.debug("Dynamic tool executed", { name: "${nameEsc}", args });
      return {
        content: "Tool \\"${nameEsc}\\" executed with args: " + JSON.stringify(args),
        success: true,
        data: { args },
      };
    },
  };
}
`;
}
