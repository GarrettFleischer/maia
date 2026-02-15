/**
 * @fileoverview MCP client bridge: connects to MCP servers and exposes their tools as AgentTools.
 * @module mcp/bridge
 *
 * @brief Connects to configured MCP servers (e.g. Docker MCP), lists tools, and registers
 * bridge tools that call the MCP server on execute. Maia's only external tool config is
 * the list of MCP servers (e.g. Docker MCP for managing hosted MCPs).
 */

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import type { Logger } from "../core/types.js";
import type {
  AgentTool,
  ToolContext,
  ToolResult,
} from "../agent/tools/base.js";
import type { ToolDefinition } from "../core/types.js";

/**
 * @brief Configuration for one MCP server (stdio).
 */
export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
}

/**
 * @brief Dependencies for createMCPBridgeTools.
 */
export interface MCPBridgeDeps {
  logger: Logger;
  server: MCPServerConfig;
}

/**
 * @brief Connects to an MCP server via stdio, lists tools, and returns AgentTools that proxy to the server.
 * @param deps - Logger and server config
 * @returns Array of AgentTools (one per MCP tool); empty on connection or list failure
 *
 * @note Tool names are prefixed with the server name to avoid collisions (e.g. docker_list_containers).
 */
export async function createMCPBridgeTools(
  deps: MCPBridgeDeps,
): Promise<AgentTool[]> {
  const { logger, server } = deps;
  const prefix =
    server.name
      .replace(/\s+/g, "_")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "") + "_";

  try {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
    });
    const client = new Client(
      { name: "maia-mcp-client", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport as Parameters<Client["connect"]>[0]);

    const result = await client.listTools();
    const tools = result.tools ?? [];
    const agentTools: AgentTool[] = [];

    for (const tool of tools) {
      const toolName = prefix + tool.name;
      const description = (tool.description ?? tool.name) as string;
      const inputSchema = (tool.inputSchema ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>;

      agentTools.push({
        name: toolName,
        description: `MCP (${server.name}): ${description}`,
        definition(): ToolDefinition {
          return {
            name: toolName,
            description: description,
            parameters: inputSchema as {
              type: "object";
              properties?: Record<string, unknown>;
              required?: string[];
            },
          };
        },
        async execute(
          args: Record<string, unknown>,
          _context: ToolContext,
        ): Promise<ToolResult> {
          try {
            const result = await client.callTool({
              name: tool.name,
              arguments: args as Record<
                string,
                string | number | boolean | null
              >,
            });
            const content = (
              result as { content?: Array<{ type: string; text?: string }> }
            ).content;
            const text =
              content
                ?.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                .join("\n") ?? JSON.stringify(result);
            return { content: text, success: true, data: { result } };
          } catch (err) {
            logger.warn("MCP tool call failed", {
              server: server.name,
              tool: tool.name,
              error: err instanceof Error ? err.message : String(err),
            });
            return {
              content: `MCP tool failed: ${err instanceof Error ? err.message : String(err)}`,
              success: false,
            };
          }
        },
      });
    }

    logger.info("MCP bridge connected", {
      server: server.name,
      toolCount: agentTools.length,
    });
    return agentTools;
  } catch (err) {
    logger.warn("MCP bridge connection failed", {
      server: server.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
