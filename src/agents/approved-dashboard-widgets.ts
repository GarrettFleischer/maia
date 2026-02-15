/**
 * @fileoverview Repository for approved dashboard widgets (custom HTML/CSS/JS).
 * @module agents/approved-dashboard-widgets
 *
 * @brief Only approved widgets are stored here and rendered in the dashboard.
 * Populated when a widget_review_request is approved.
 */

import type { Database, Logger } from "../core/types.js";

/**
 * @brief A single approved dashboard widget record.
 */
export interface ApprovedDashboardWidget {
  id: string;
  agentId: string;
  widgetId: string;
  name: string | null;
  html: string;
  css: string;
  js: string;
  createdAt: string;
}

/**
 * @brief Input for inserting an approved widget (e.g. after approval).
 */
export interface CreateApprovedWidgetInput {
  id: string;
  agentId: string;
  widgetId: string;
  name?: string | null;
  html: string;
  css: string;
  js: string;
}

/**
 * @brief Dependencies for createApprovedDashboardWidgetsRepository.
 */
export interface ApprovedDashboardWidgetsRepositoryDeps {
  db: Database;
  logger: Logger;
}

/**
 * @brief Repository interface for approved dashboard widgets.
 */
export interface ApprovedDashboardWidgetsRepository {
  create(input: CreateApprovedWidgetInput): Promise<ApprovedDashboardWidget>;
  getByAgentAndWidget(agentId: string, widgetId: string): Promise<ApprovedDashboardWidget | undefined>;
  listByAgent(agentId: string): Promise<ApprovedDashboardWidget[]>;
}

function rowToWidget(row: Record<string, unknown>): ApprovedDashboardWidget {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    widgetId: row.widget_id as string,
    name: (row.name as string | null) ?? null,
    html: (row.html as string) ?? "",
    css: (row.css as string) ?? "",
    js: (row.js as string) ?? "",
    createdAt: row.created_at as string,
  };
}

/**
 * @brief Creates the approved dashboard widgets repository.
 * @param deps - Database and logger
 * @returns ApprovedDashboardWidgetsRepository instance
 */
export function createApprovedDashboardWidgetsRepository(
  deps: ApprovedDashboardWidgetsRepositoryDeps
): ApprovedDashboardWidgetsRepository {
  const { db, logger } = deps;

  return {
    async create(input: CreateApprovedWidgetInput): Promise<ApprovedDashboardWidget> {
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO approved_dashboard_widgets (id, agent_id, widget_id, name, html, css, js, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.agentId,
          input.widgetId,
          input.name ?? null,
          input.html,
          input.css,
          input.js,
          now,
        ]
      );
      const row = await db.query("SELECT * FROM approved_dashboard_widgets WHERE id = ?", [
        input.id,
      ]);
      const r = row[0] as Record<string, unknown>;
      logger.debug("Approved dashboard widget created", {
        id: input.id,
        agentId: input.agentId,
        widgetId: input.widgetId,
      });
      return rowToWidget(r);
    },

    async getByAgentAndWidget(
      agentId: string,
      widgetId: string
    ): Promise<ApprovedDashboardWidget | undefined> {
      const rows = await db.query(
        "SELECT * FROM approved_dashboard_widgets WHERE agent_id = ? AND widget_id = ?",
        [agentId, widgetId]
      );
      if (rows.length === 0) return undefined;
      return rowToWidget(rows[0] as Record<string, unknown>);
    },

    async listByAgent(agentId: string): Promise<ApprovedDashboardWidget[]> {
      const rows = await db.query("SELECT * FROM approved_dashboard_widgets WHERE agent_id = ?", [
        agentId,
      ]);
      return (rows as Record<string, unknown>[]).map(rowToWidget);
    },
  };
}
