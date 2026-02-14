/**
 * @fileoverview Security audit for agent-proposed tools. Reviews name, description,
 * parameters, and implementation for SSRF, privilege escalation, and misleading behavior.
 * @module security/tool-audit
 *
 * @brief Used by the tool_review queue job. Returns approve/deny and a reason for the proposing agent.
 */

import type { Logger, LLMProvider } from "../core/types.js";
import type { ToolProposal } from "../tools/proposals.js";

/**
 * @brief Result of a tool proposal security review.
 */
export interface ToolAuditResult {
  approved: boolean;
  reason: string;
}

/**
 * @brief Dependencies for createToolAudit.
 */
export interface ToolAuditDeps {
  logger: Logger;
  /** Maia's LLM provider for semantic review (optional; if omitted, only rules run). */
  llm?: LLMProvider;
}

/**
 * @brief Tool audit interface.
 */
export interface ToolAudit {
  /**
   * @brief Review a tool proposal for security issues.
   * @param proposal - The proposal to review
   * @returns Approve/deny and reason
   */
  review(proposal: ToolProposal): Promise<ToolAuditResult>;
}

/**
 * @brief Rules-based checks: blocklist param names, name/description length, dangerous patterns.
 */
function runRulesCheck(proposal: ToolProposal): ToolAuditResult | null {
  const name = proposal.name.trim();
  if (name.length < 2 || name.length > 64) {
    return {
      approved: false,
      reason: "Tool name must be between 2 and 64 characters.",
    };
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return {
      approved: false,
      reason: "Tool name must be lowercase, start with a letter, and contain only letters, numbers, and underscores.",
    };
  }
  const desc = proposal.description.trim();
  if (desc.length < 10 || desc.length > 500) {
    return {
      approved: false,
      reason: "Description must be between 10 and 500 characters.",
    };
  }
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(proposal.parametersJson) as Record<string, unknown>;
  } catch {
    return {
      approved: false,
      reason: "Invalid parameters JSON.",
    };
  }
  const schema = params as { type?: string; properties?: Record<string, unknown> };
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props) {
    const dangerous = ["password", "secret", "api_key", "token", "credential"];
    for (const key of Object.keys(props)) {
      const lower = key.toLowerCase();
      if (dangerous.some((d) => lower.includes(d))) {
        return {
          approved: false,
          reason: `Parameter name '${key}' suggests sensitive data; use a secure pattern instead.`,
        };
      }
    }
  }
  return null;
}

/**
 * @brief Creates the tool audit service.
 * @param deps - Logger and optional LLM provider
 * @returns ToolAudit instance
 *
 * @example
 * const audit = createToolAudit({ logger, llm: maiaProvider });
 * const result = await audit.review(proposal);
 * if (!result.approved) await repo.updateStatus(proposal.id, 'security_denied', { securityReason: result.reason });
 */
export function createToolAudit(deps: ToolAuditDeps): ToolAudit {
  const { logger, llm } = deps;

  return {
    async review(proposal: ToolProposal): Promise<ToolAuditResult> {
      const rulesResult = runRulesCheck(proposal);
      if (rulesResult) return rulesResult;

      if (!llm) {
        return { approved: true, reason: "Rules check passed; no LLM review configured." };
      }

      const systemPrompt = `You are a security reviewer for AI agent tools. Review the following tool proposal and respond with exactly two lines:
Line 1: APPROVE or DENY
Line 2: A short reason (one sentence). If DENY, explain the security concern (e.g. SSRF, privilege escalation, misleading name, dangerous parameters).

Check for: (1) SSRF or external URL/network abuse, (2) parameters that could expose secrets or escalate privileges, (3) misleading name or description that could hide harmful behavior, (4) code or config that could run arbitrary commands or access sensitive paths.`;

      const userContent = `Tool name: ${proposal.name}
Description: ${proposal.description}
Parameters (JSON): ${proposal.parametersJson}
Implementation type: ${proposal.implementationType}
Implementation config: ${proposal.implementationConfigJson ?? "none"}

Respond with:
APPROVE or DENY
Reason: ...`;

      try {
        const stream = llm.chat(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          { temperature: 0.2, maxTokens: 200 }
        );
        let text = "";
        for await (const chunk of stream) {
          text += chunk.content ?? "";
        }
        text = text.trim();
        const firstLine = (text.split("\n")[0] ?? "").trim().toUpperCase();
        const approved = firstLine.startsWith("APPROVE");
        const reasonLine = text.split("\n").slice(1).join(" ").trim() || (approved ? "Approved after review." : "See review.");
        const reason = reasonLine.replace(/^reason:\s*/i, "").trim() || (approved ? "Approved." : "Denied.");
        logger.debug("Tool audit completed", { proposalId: proposal.id, approved, reason: reason.slice(0, 80) });
        return { approved, reason };
      } catch (err) {
        logger.warn("Tool audit LLM call failed", {
          proposalId: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          approved: false,
          reason: "Security review could not be completed; please try again or simplify the proposal.",
        };
      }
    },
  };
}
