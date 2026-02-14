/**
 * @fileoverview propose_mcp_server tool for agents to propose MCP servers for hosting.
 * @module agents/tools/propose-mcp-server
 *
 * @brief Agent builds an MCP server in their sandbox and proposes it. Maia reviews (security);
 * if approved, user is DMed for approval. After user approval, a config snippet is written
 * for the user to add to their Docker MCP setup.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { AgentRegistry } from "../registry.js";
import type { McpServerProposalsRepository, McpServerProposal } from "../mcp-server-proposals.js";
import type { CryptoProvider } from "../../core/types.js";

/**
 * @brief Dependencies for createProposeMcpServerTool.
 */
export interface ProposeMcpServerToolDeps {
  logger: Logger;
  crypto: CryptoProvider;
  repo: McpServerProposalsRepository;
  registry: AgentRegistry;
  /** Resolves the calling agent's ID */
  resolveAgentId: (context: ToolContext) => string | undefined;
  /** Called when proposal passes security so the user can be notified (e.g. approval_request + DM) */
  onMcpProposalForUserApproval: (proposal: McpServerProposal) => void;
}

/**
 * @brief Normalizes a path for comparison (resolve relative segments and separators).
 */
function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

/**
 * @brief Returns true if child is under parent (normalized path prefix check).
 */
function isUnderPath(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  if (!p.length) return true;
  return c === p || c.startsWith(p + "/");
}

/**
 * @brief Creates the propose_mcp_server tool.
 * @param deps - Dependencies: logger, crypto, repo, registry, resolveAgentId, onMcpProposalForUserApproval
 * @returns AgentTool for proposing an MCP server
 *
 * @example
 * // Agent calls: propose_mcp_server({ name: "my-api", description: "...", sandbox_path: "mcp/my-server" })
 */
export function createProposeMcpServerTool(deps: ProposeMcpServerToolDeps): AgentTool {
  const { logger, crypto, repo, registry, resolveAgentId, onMcpProposalForUserApproval } = deps;

  return {
    name: "propose_mcp_server",
    description:
      "Propose an MCP server you built in your sandbox for hosting. Maia will review it; if approved, the user will be asked to add it to their Docker MCP setup.",
    definition(): ToolDefinition {
      return {
        name: "propose_mcp_server",
        description:
          "Propose an MCP server for hosting. Provide a name, description, and the path inside your workspace where the MCP server implementation lives. Optionally provide dockerfile_path or image_ref.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short name for the MCP server (e.g. my-api)" },
            description: { type: "string", description: "What this MCP server does" },
            sandbox_path: {
              type: "string",
              description: "Path relative to your agent workspace where the MCP server code lives",
            },
            dockerfile_path: {
              type: "string",
              description: "Optional path to Dockerfile relative to sandbox_path",
            },
            image_ref: { type: "string", description: "Optional OCI image reference if already built" },
          },
          required: ["name", "sandbox_path"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const agentId = resolveAgentId(context);
      if (!agentId) {
        return {
          content: "Could not determine your agent ID. This tool is only available to agents.",
          success: false,
        };
      }

      const name = args.name as string;
      const sandboxPath = args.sandbox_path as string;
      const description = (args.description as string) ?? "";
      const dockerfilePath = (args.dockerfile_path as string) ?? undefined;
      const imageRef = (args.image_ref as string) ?? undefined;

      if (!name?.trim()) {
        return { content: "name is required.", success: false };
      }
      if (!sandboxPath?.trim()) {
        return { content: "sandbox_path is required.", success: false };
      }

      const workspacePath = registry.agentWorkspacePath(agentId);
      const absoluteSandbox = normalizePath(`${workspacePath}/${sandboxPath}`);
      const absoluteWorkspace = normalizePath(workspacePath);
      if (!isUnderPath(absoluteWorkspace, absoluteSandbox)) {
        return {
          content: "sandbox_path must be inside your agent workspace.",
          success: false,
        };
      }

      const id = crypto.randomUUID();
      try {
        const proposal = await repo.create({
          id,
          proposingAgentId: agentId,
          name: name.trim(),
          description: description.trim() ? description.trim() : undefined,
          sandboxPath: absoluteSandbox,
          dockerfilePath,
          imageRef,
        });
        const updated = await repo.updateStatus(proposal.id, "pending_user");
        if (updated) {
          onMcpProposalForUserApproval(updated);
        }
        logger.info("MCP server proposal submitted for user approval", {
          id: proposal.id,
          name: proposal.name,
          proposingAgentId: agentId,
        });
        return {
          content: `MCP server "${proposal.name}" has been submitted for user approval. You will be notified when the user approves or denies it.`,
          success: true,
        };
      } catch (err) {
        logger.warn("MCP server proposal failed", {
          agentId,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: `Failed to submit proposal: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
