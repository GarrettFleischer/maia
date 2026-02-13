/**
 * @fileoverview Per-context tool access control.
 * @module security/tool-permissions
 *
 * @note Implements a deny-wins-over-allow policy for tool usage.
 * Each context type (main, group, consolidation) has its own allow/deny lists.
 */

import type { AuditLog } from "../core/types.js";

/**
 * @brief Configuration for tool permissions per context.
 */
export interface ToolPermissionsConfig {
  [context: string]: {
    allow?: string[];
    deny?: string[];
  };
}

/**
 * @brief Dependencies for the tool permissions checker.
 */
export interface ToolPermissionsDeps {
  readonly config: ToolPermissionsConfig;
  readonly auditLog: AuditLog;
}

/**
 * @brief Tool permissions checker interface.
 */
export interface ToolPermissions {
  isAllowed(toolName: string, context: string): boolean;
}

/**
 * @brief Creates a tool permissions checker.
 * @param deps - Injected dependencies
 * @returns ToolPermissions instance
 *
 * @example
 * const perms = createToolPermissions({ config, auditLog });
 * perms.isAllowed("web_fetch", "main");  // true
 * perms.isAllowed("web_fetch", "group"); // false (denied)
 */
export function createToolPermissions(deps: ToolPermissionsDeps): ToolPermissions {
  const { config, auditLog } = deps;

  return {
    isAllowed(toolName: string, context: string): boolean {
      const contextConfig = config[context];

      // Unknown contexts: deny by default
      if (!contextConfig) {
        void auditLog.log("TOOL_CALL", {
          tool: toolName,
          context,
          allowed: false,
          reason: "unknown_context",
        });
        return false;
      }

      // Deny always wins
      if (contextConfig.deny?.includes(toolName)) {
        void auditLog.log("TOOL_CALL", {
          tool: toolName,
          context,
          allowed: false,
          reason: "denied",
        });
        return false;
      }

      // Check allow list
      const allowList = contextConfig.allow ?? [];
      const allowed = allowList.includes("*") || allowList.includes(toolName);

      void auditLog.log("TOOL_CALL", {
        tool: toolName,
        context,
        allowed,
        reason: allowed ? "allowed" : "not_in_allow_list",
      });

      return allowed;
    },
  };
}
