/**
 * @fileoverview submit_widget_for_review tool for agents to submit custom dashboard widgets.
 * @module agents/tools/submit-widget-for-review
 *
 * @brief Agent submits HTML/CSS/JS for a dashboard widget. A review request is stored;
 * onWidgetReviewRequest is called so the gateway pushes approval_request (widget_review_request).
 * Only after Maia/user approves is the widget stored in approved_dashboard_widgets and rendered.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { WidgetReviewRequestsRepository } from "../widget-review-requests.js";
import type { WidgetReviewRequest } from "../widget-review-requests.js";
import type { CryptoProvider } from "../../core/types.js";

/**
 * @brief Dependencies for createSubmitWidgetForReviewTool.
 */
export interface SubmitWidgetForReviewToolDeps {
  logger: Logger;
  crypto: CryptoProvider;
  widgetReviewRequestsRepo: WidgetReviewRequestsRepository;
  /** Resolves the calling agent's ID (e.g. "maia" or sub-agent id). */
  resolveAgentId: (context: ToolContext) => string | undefined;
  /** Called when a widget is submitted so the gateway can push approval_request (widget_review_request). */
  onWidgetReviewRequest: (request: WidgetReviewRequest) => void;
}

/**
 * @brief Creates the submit_widget_for_review tool.
 * @param deps - Dependencies: logger, crypto, repo, resolveAgentId, onWidgetReviewRequest
 * @returns AgentTool for submitting a widget for security review
 *
 * @example
 * // Agent calls: submit_widget_for_review({ widgetId: "my-panel", name: "My Panel", html: "<div>...</div>", css: "", js: "" })
 */
export function createSubmitWidgetForReviewTool(deps: SubmitWidgetForReviewToolDeps): AgentTool {
  const { logger, crypto, widgetReviewRequestsRepo, resolveAgentId, onWidgetReviewRequest } =
    deps;

  return {
    name: "submit_widget_for_review",
    description:
      "Submit a custom dashboard widget (HTML, CSS, JS) for security review. Use this to surface information that is relevant to the user on your dashboard. Prefer widgets whose JavaScript fetches live data from APIs (e.g. fetch()) so the user sees up-to-date info without you updating it; only use content you generate yourself when the display truly requires your reasoning (e.g. summaries, recommendations).",
    definition(): ToolDefinition {
      return {
        name: "submit_widget_for_review",
        description:
          "Create or update a dashboard widget to show the user information you think is relevant. You are encouraged to find, use, or create widgets to display such info. Prefer widgets that use JavaScript to fetch live data from services (e.g. fetch(URL), setInterval to refresh) so the dashboard stays current without you updating it. Only embed content you generate when the display genuinely requires your reasoning (e.g. your summary, your recommendation). Provide widgetId (slug), optional name, and html, css, js. After Maia approves, the widget is shown on your dashboard in a sandboxed iframe.",
        parameters: {
          type: "object",
          properties: {
            widgetId: {
              type: "string",
              description: "Unique slug for this widget (e.g. my-stats-panel, live-status)",
            },
            name: { type: "string", description: "Optional display name for the widget" },
            html: {
              type: "string",
              description:
                "HTML structure (e.g. container divs). Prefer a minimal shell; use JS to fetch and render live data when possible.",
            },
            css: { type: "string", description: "CSS for layout and styling" },
            js: {
              type: "string",
              description:
                "JavaScript for the widget. Prefer using fetch() or similar to load live data from APIs and update the DOM; use setInterval/setTimeout to refresh when appropriate. Only inject static content you produce when the user needs your reasoned output (e.g. your analysis) in the widget.",
            },
          },
          required: ["widgetId", "html", "css", "js"],
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

      const widgetId = args.widgetId as string;
      const name = (args.name as string) ?? null;
      const html = (args.html as string) ?? "";
      const css = (args.css as string) ?? "";
      const js = (args.js as string) ?? "";

      if (!widgetId || typeof widgetId !== "string") {
        return { content: "widgetId is required.", success: false };
      }
      if (typeof html !== "string" || typeof css !== "string" || typeof js !== "string") {
        return { content: "html, css, and js must be strings.", success: false };
      }

      try {
        const id = crypto.randomUUID();
        const request = await widgetReviewRequestsRepo.create({
          id,
          requestingAgentId: agentId,
          widgetId,
          name: name || null,
          html,
          css,
          js,
        });
        onWidgetReviewRequest(request);
        logger.info("Widget submitted for review", {
          requestId: id,
          requestingAgentId: agentId,
          widgetId,
        });
        return {
          content: `Widget "${widgetId}" submitted for security review. Maia will review it; once approved, it will appear on your dashboard.`,
          success: true,
        };
      } catch (err) {
        logger.warn("Failed to submit widget for review", {
          agentId,
          widgetId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: `Failed to submit widget: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
