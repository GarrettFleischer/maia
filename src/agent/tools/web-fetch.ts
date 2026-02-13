/**
 * @fileoverview Web fetch tool with SSRF guard integration.
 * @module agent/tools/web-fetch
 *
 * @note Allows the agent to fetch web content while preventing SSRF attacks.
 * URLs are validated against the SSRF guard before any request is made.
 */

import type { HttpClient, Logger } from "../../core/types.js";
import type { SsrfGuard } from "../../security/ssrf-guard.js";
import type { AgentTool, ToolContext, ToolResult } from "./base.js";

/**
 * @brief Dependencies for createWebFetchTool.
 */
export interface WebFetchToolDeps {
  http: HttpClient;
  ssrfGuard: SsrfGuard;
  logger: Logger;
  /** Maximum response body length in characters */
  maxResponseLength?: number;
}

/**
 * @brief Creates the web_fetch agent tool.
 * @param deps - Dependencies: http, ssrfGuard, logger, optional maxResponseLength
 * @returns AgentTool implementation for web fetching
 *
 * @example
 * const tool = createWebFetchTool({ http, ssrfGuard, logger });
 * registry.register(tool);
 * // LLM can call: web_fetch({ url: "https://example.com/api" })
 */
export function createWebFetchTool(deps: WebFetchToolDeps): AgentTool {
  const { http, ssrfGuard, logger, maxResponseLength = 10000 } = deps;

  return {
    name: "web_fetch",
    description: "Fetch content from a public URL. Returns the response body text.",

    definition() {
      return {
        name: "web_fetch",
        description: "Fetch content from a public URL. Only http/https URLs to public IPs are allowed.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch (must be http or https, no private IPs)",
            },
            method: {
              type: "string",
              enum: ["GET", "POST"],
              description: "HTTP method (default: GET)",
            },
          },
          required: ["url"],
        },
      };
    },

    async execute(
      args: Record<string, unknown>,
      _context: ToolContext
    ): Promise<ToolResult> {
      const url = String(args.url ?? "");
      const method = String(args.method ?? "GET").toUpperCase();

      if (!url) {
        return { content: "Error: URL is required.", success: false };
      }

      // SSRF validation
      if (!ssrfGuard.isAllowed(url)) {
        logger.warn("Web fetch blocked by SSRF guard", { url });
        return {
          content: "Error: URL is blocked. Only public http/https URLs are allowed.",
          success: false,
        };
      }

      try {
        const response = await http.fetch(url, {
          method,
          timeout: 15000,
        });

        let body = response.body;
        if (body.length > maxResponseLength) {
          body = body.slice(0, maxResponseLength) + "\n...[truncated]";
        }

        logger.debug("Web fetch completed", {
          url,
          status: response.status,
          bodyLength: body.length,
        });

        return {
          content: `Status: ${response.status}\n\n${body}`,
          success: response.ok,
          data: { status: response.status, bodyLength: body.length },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Web fetch failed", { url, error: message });
        return {
          content: `Error fetching ${url}: ${message}`,
          success: false,
        };
      }
    },
  };
}
