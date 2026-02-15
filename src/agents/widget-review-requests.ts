/**
 * @fileoverview Repository for widget review requests (dashboard custom widgets).
 * @module agents/widget-review-requests
 *
 * @brief When an agent submits HTML/CSS/JS for a dashboard widget via submit_widget_for_review,
 * a request is stored for Maia/user security review. Status flow: pending -> approved | denied.
 */

import type { Database, Logger } from "../core/types.js";

/**
 * @brief Status of a widget review request.
 */
export type WidgetReviewRequestStatus = "pending" | "approved" | "denied";

/**
 * @brief A single widget review request record.
 */
export interface WidgetReviewRequest {
  id: string;
  requestingAgentId: string;
  widgetId: string;
  name: string | null;
  html: string;
  css: string;
  js: string;
  status: WidgetReviewRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * @brief Input for creating a new widget review request.
 */
export interface CreateWidgetReviewRequestInput {
  id: string;
  requestingAgentId: string;
  widgetId: string;
  name?: string | null;
  html: string;
  css: string;
  js: string;
}

/**
 * @brief Dependencies for createWidgetReviewRequestsRepository.
 */
export interface WidgetReviewRequestsRepositoryDeps {
  db: Database;
  logger: Logger;
}

/**
 * @brief Repository interface for widget review requests.
 */
export interface WidgetReviewRequestsRepository {
  create(input: CreateWidgetReviewRequestInput): Promise<WidgetReviewRequest>;
  getById(id: string): Promise<WidgetReviewRequest | undefined>;
  updateStatus(id: string, status: WidgetReviewRequestStatus): Promise<WidgetReviewRequest | undefined>;
  listByStatus(status: WidgetReviewRequestStatus): Promise<WidgetReviewRequest[]>;
}

function rowToRequest(row: Record<string, unknown>): WidgetReviewRequest {
  return {
    id: row.id as string,
    requestingAgentId: row.requesting_agent_id as string,
    widgetId: row.widget_id as string,
    name: (row.name as string | null) ?? null,
    html: (row.html as string) ?? "",
    css: (row.css as string) ?? "",
    js: (row.js as string) ?? "",
    status: row.status as WidgetReviewRequestStatus,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string | null) ?? null,
  };
}

/**
 * @brief Creates the widget review requests repository.
 * @param deps - Database and logger
 * @returns WidgetReviewRequestsRepository instance
 */
export function createWidgetReviewRequestsRepository(
  deps: WidgetReviewRequestsRepositoryDeps
): WidgetReviewRequestsRepository {
  const { db, logger } = deps;

  return {
    async create(input: CreateWidgetReviewRequestInput): Promise<WidgetReviewRequest> {
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO widget_review_requests (id, requesting_agent_id, widget_id, name, html, css, js, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
        [
          input.id,
          input.requestingAgentId,
          input.widgetId,
          input.name ?? null,
          input.html,
          input.css,
          input.js,
          now,
        ]
      );
      const row = await db.query("SELECT * FROM widget_review_requests WHERE id = ?", [input.id]);
      const r = row[0] as Record<string, unknown>;
      logger.debug("Widget review request created", {
        id: input.id,
        requestingAgentId: input.requestingAgentId,
        widgetId: input.widgetId,
      });
      return rowToRequest(r);
    },

    async getById(id: string): Promise<WidgetReviewRequest | undefined> {
      const rows = await db.query("SELECT * FROM widget_review_requests WHERE id = ?", [id]);
      if (rows.length === 0) return undefined;
      return rowToRequest(rows[0] as Record<string, unknown>);
    },

    async updateStatus(
      id: string,
      status: WidgetReviewRequestStatus
    ): Promise<WidgetReviewRequest | undefined> {
      const resolvedAt = status !== "pending" ? new Date().toISOString() : null;
      await db.execute(
        "UPDATE widget_review_requests SET status = ?, resolved_at = ? WHERE id = ?",
        [status, resolvedAt, id]
      );
      const rows = await db.query("SELECT * FROM widget_review_requests WHERE id = ?", [id]);
      if (rows.length === 0) return undefined;
      return rowToRequest(rows[0] as Record<string, unknown>);
    },

    async listByStatus(status: WidgetReviewRequestStatus): Promise<WidgetReviewRequest[]> {
      const rows = await db.query("SELECT * FROM widget_review_requests WHERE status = ?", [status]);
      return (rows as Record<string, unknown>[]).map(rowToRequest);
    },
  };
}
