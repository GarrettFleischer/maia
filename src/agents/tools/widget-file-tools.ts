/**
 * @fileoverview Widget create/edit and delete tools using file-based pending/approved folders.
 * @module agents/tools/widget-file-tools
 *
 * @brief Widgets are stored under dataDir/widgets/pending (until approved) and
 * dataDir/widgets/approved. Each widget is a single HTML file with embedded style and script.
 */

import type { FileSystem, Logger, CryptoProvider } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { WidgetReviewRequestsRepository } from "../widget-review-requests.js";
import type { WidgetReviewRequest } from "../widget-review-requests.js";

/**
 * @brief Builds a single HTML document from html, css, js (escapes closing tags in css/js).
 */
function buildWidgetHtml(html: string, css: string, js: string): string {
  const escCss = (css ?? "").replace(/<\/style>/gi, "\\u003c/style>");
  const escJs = (js ?? "").replace(/<\/script>/gi, "\\u003c/script>");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${escCss}</style></head><body>${html ?? ""}<script>${escJs}<\/script></body></html>`;
}

/**
 * @brief Dependencies for widget_create_or_edit tool.
 */
export interface WidgetCreateOrEditToolDeps {
  logger: Logger;
  crypto: CryptoProvider;
  fs: FileSystem;
  getWidgetsPendingDir: () => string;
  getWidgetsApprovedDir: () => string;
  widgetReviewRequestsRepo: WidgetReviewRequestsRepository;
  resolveAgentId: (context: ToolContext) => string | undefined;
  onWidgetReviewRequest: (request: WidgetReviewRequest) => void;
}

/**
 * @brief Creates the widget_create_or_edit tool (writes to pending folder and creates review request).
 */
export function createWidgetCreateOrEditTool(deps: WidgetCreateOrEditToolDeps): AgentTool {
  const {
    logger,
    crypto,
    fs,
    getWidgetsPendingDir,
    widgetReviewRequestsRepo,
    resolveAgentId,
    onWidgetReviewRequest,
  } = deps;

  return {
    name: "widget_create_or_edit",
    description:
      "Create or update a dashboard widget in the pending folder. Single HTML file with embedded CSS and JS. After Maia/user approves, it moves to approved and appears on your dashboard.",
    definition() {
      return {
        name: "widget_create_or_edit",
        description:
          "Create or update a dashboard widget. Writes a single HTML file (with embedded style and script) to the pending folder. Provide widgetId, optional name, and html, css, js. After approval the widget appears on your dashboard.",
        parameters: {
          type: "object",
          properties: {
            widgetId: { type: "string", description: "Unique slug for this widget" },
            name: { type: "string", description: "Optional display name" },
            html: { type: "string", description: "HTML body content" },
            css: { type: "string", description: "CSS styles" },
            js: { type: "string", description: "JavaScript" },
          },
          required: ["widgetId", "html", "css", "js"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const agentId = resolveAgentId(context);
      if (!agentId) {
        return { content: "Could not determine your agent ID.", success: false };
      }

      const widgetId = args.widgetId as string;
      const name = (args.name as string) ?? null;
      const html = (args.html as string) ?? "";
      const css = (args.css as string) ?? "";
      const js = (args.js as string) ?? "";

      if (!widgetId || typeof widgetId !== "string") {
        return { content: "widgetId is required.", success: false };
      }
      const safeId = widgetId.replace(/[^a-zA-Z0-9-_]/g, "_");
      const filename = `${agentId}_${safeId}.html`;
      const pendingDir = getWidgetsPendingDir();
      const filePath = `${pendingDir}/${filename}`.replace(/\/+/g, "/");

      try {
        await fs.mkdir(pendingDir).catch(() => {});
        const fullHtml = buildWidgetHtml(html, css, js);
        await fs.writeFile(filePath, fullHtml);

        const requestId = crypto.randomUUID();
        const request = await widgetReviewRequestsRepo.create({
          id: requestId,
          requestingAgentId: agentId,
          widgetId: safeId,
          name,
          html,
          css,
          js,
        });
        onWidgetReviewRequest(request);

        logger.info("Widget created/updated in pending", { agentId, widgetId: safeId });
        return {
          content: `Widget "${safeId}" saved to pending. Once Maia approves, it will appear on your dashboard.`,
          success: true,
        };
      } catch (err) {
        logger.warn("widget_create_or_edit failed", {
          agentId,
          widgetId: safeId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: `Failed: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}

/**
 * @brief Dependencies for widget_delete tool.
 */
export interface WidgetDeleteToolDeps {
  logger: Logger;
  fs: FileSystem;
  getWidgetsPendingDir: () => string;
  getWidgetsApprovedDir: () => string;
  resolveAgentId: (context: ToolContext) => string | undefined;
}

/**
 * @brief Creates the widget_delete tool (removes from pending and approved).
 */
export function createWidgetDeleteTool(deps: WidgetDeleteToolDeps): AgentTool {
  const { logger, fs, getWidgetsPendingDir, getWidgetsApprovedDir, resolveAgentId } = deps;

  return {
    name: "widget_delete",
    description: "Remove a widget from pending and approved folders.",
    definition() {
      return {
        name: "widget_delete",
        description: "Delete a widget by widgetId. Removes it from pending and approved.",
        parameters: {
          type: "object",
          properties: {
            widgetId: { type: "string", description: "Widget slug to delete" },
          },
          required: ["widgetId"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const agentId = resolveAgentId(context);
      if (!agentId) {
        return { content: "Could not determine your agent ID.", success: false };
      }

      const widgetId = args.widgetId as string;
      if (!widgetId || typeof widgetId !== "string") {
        return { content: "widgetId is required.", success: false };
      }
      const safeId = widgetId.replace(/[^a-zA-Z0-9-_]/g, "_");
      const filename = `${agentId}_${safeId}.html`;
      const pendingPath = `${getWidgetsPendingDir()}/${filename}`.replace(/\/+/g, "/");
      const approvedPath = `${getWidgetsApprovedDir()}/${filename}`.replace(/\/+/g, "/");

      try {
        let removed = false;
        if (await fs.exists(pendingPath)) {
          await fs.remove(pendingPath);
          removed = true;
        }
        if (await fs.exists(approvedPath)) {
          await fs.remove(approvedPath);
          removed = true;
        }
        if (!removed) {
          return { content: `No widget found: ${safeId}`, success: false };
        }
        logger.info("Widget deleted", { agentId, widgetId: safeId });
        return { content: `Widget "${safeId}" deleted.`, success: true };
      } catch (err) {
        logger.warn("widget_delete failed", {
          agentId,
          widgetId: safeId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: `Failed: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
