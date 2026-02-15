/**
 * @fileoverview Modal for responding to approval requests (tool proposal, agent creation, widget review, or flagged agent).
 * @module components/ApprovalRequestModal
 */

import { useState } from "preact/hooks";
import type { ApprovalRequest } from "../lib/types.js";

interface ApprovalRequestModalProps {
  request: ApprovalRequest | null;
  onRespond: (payload: { kind: string; decision: string; feedback?: string; proposalId?: string; requestId?: string; agentId?: string; approvalRequestId?: string }) => void;
  onDismiss: () => void;
}

/**
 * @brief Renders a modal for tool proposal, agent creation, widget review, or flagged-agent approval with action buttons.
 */
export function ApprovalRequestModal({ request, onRespond, onDismiss }: ApprovalRequestModalProps) {
  if (!request) return null;

  const id = request.id;
  const kind = request.kind;
  const [widgetTab, setWidgetTab] = useState<"html" | "css" | "js">("html");

  const handleDecision = (decision: string, feedback?: string) => {
    onRespond({
      kind,
      decision,
      feedback,
      proposalId: request.proposalId,
      requestId: request.requestId,
      agentId: request.agentId,
      approvalRequestId: id,
    });
    onDismiss();
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onDismiss}
    >
      <div
        class="bg-maia-surface border border-maia-border rounded-2xl p-6 shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold text-maia-text">
            {kind === "tool_proposal" ? "Tool proposal" : kind === "agent_creation_request" ? "Agent creation request" : kind === "mcp_server_proposal" ? "MCP server proposal" : kind === "widget_review_request" ? "Widget review request" : "Flagged agent"}
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            class="text-maia-text-dim hover:text-maia-text p-1"
          >
            ✕
          </button>
        </div>

        <p class="text-sm text-maia-text mb-2">{request.summary}</p>
        {kind === "tool_proposal" && request.toolName && (
          <p class="text-xs text-maia-text-dim mb-3">Tool: {request.toolName}</p>
        )}
        {(kind === "agent_creation_request" || kind === "flagged_agent" || kind === "widget_review_request") && (request.agentName ?? request.agentId ?? request.requestingAgentId) && (
          <p class="text-xs text-maia-text-dim mb-2">
            Agent: {request.agentName ?? request.agentId ?? request.requestingAgentId}
          </p>
        )}
        {kind === "widget_review_request" && request.widgetId && (
          <p class="text-xs text-maia-text-dim mb-2">Widget ID: {request.widgetId}{request.name ? ` (${request.name})` : ""}</p>
        )}
        {kind === "flagged_agent" && request.reason && (
          <p class="text-xs text-amber-600 dark:text-amber-400 mb-3">{request.reason}</p>
        )}
        {request.snippet && kind !== "widget_review_request" && (
          <pre class="text-xs bg-maia-surface-light rounded p-2 mb-4 overflow-auto max-h-24">
            {request.snippet}
          </pre>
        )}
        {kind === "widget_review_request" && (request.html !== undefined || request.css !== undefined || request.js !== undefined) && (
          <div class="mb-4">
            <div class="flex gap-2 mb-2">
              {["html", "css", "js"].map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setWidgetTab(tab as "html" | "css" | "js")}
                  class={`px-2 py-1 text-xs rounded ${widgetTab === tab ? "bg-maia-accent text-white" : "bg-maia-surface-light text-maia-text-dim"}`}
                >
                  {tab.toUpperCase()}
                </button>
              ))}
            </div>
            <pre class="text-xs bg-maia-surface-light rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap wrap-break-word text-maia-text">
              {widgetTab === "html" ? (request.html ?? "") : widgetTab === "css" ? (request.css ?? "") : (request.js ?? "")}
            </pre>
          </div>
        )}

        {(kind === "tool_proposal" || kind === "agent_creation_request" || kind === "mcp_server_proposal" || kind === "widget_review_request") && (
          <div class="space-y-2">
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleDecision("approve")}
                class="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => {
                  const feedback = window.prompt(
                    kind === "agent_creation_request" || kind === "mcp_server_proposal" || kind === "widget_review_request"
                      ? "Optional feedback for the requesting agent:"
                      : "Optional feedback for the agent:"
                  );
                  handleDecision(
                    kind === "agent_creation_request" || kind === "mcp_server_proposal" || kind === "widget_review_request" ? "deny" : "reject",
                    feedback ?? undefined
                  );
                }}
                class="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg"
              >
                {kind === "agent_creation_request" || kind === "mcp_server_proposal" || kind === "widget_review_request" ? "Deny" : "Reject"}
              </button>
              {kind === "tool_proposal" && (
                <button
                  type="button"
                  onClick={() => {
                    const feedback = window.prompt("Requested changes (required):");
                    handleDecision("modify", feedback ?? "");
                  }}
                  class="px-3 py-1.5 bg-maia-accent hover:bg-maia-accent-hover text-white text-sm rounded-lg"
                >
                  Request modification
                </button>
              )}
            </div>
          </div>
        )}

        {kind === "flagged_agent" && (
          <div class="space-y-2">
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleDecision("restart_with_warning")}
                class="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg"
              >
                Restart with warning
              </button>
              <button
                type="button"
                onClick={() => handleDecision("keep_stopped")}
                class="px-3 py-1.5 bg-maia-surface-light hover:bg-maia-border text-maia-text text-sm rounded-lg"
              >
                Keep stopped
              </button>
              <button
                type="button"
                onClick={() => handleDecision("remove")}
                class="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg"
              >
                Remove agent
              </button>
              <button
                type="button"
                onClick={() => {
                  const feedback = window.prompt("Other (feedback for Maia):");
                  handleDecision("other", feedback ?? undefined);
                }}
                class="px-3 py-1.5 text-maia-text-dim hover:text-maia-text text-sm rounded-lg border border-maia-border"
              >
                Other
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
