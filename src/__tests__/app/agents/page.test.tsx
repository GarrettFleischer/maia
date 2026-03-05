/**
 * @fileoverview RTL tests for the Agents monitor dashboard page.
 * @module __tests__/app/agents/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor, act } from "@testing-library/react";
import AgentsView from "@/app/views/AgentsView";
import {
  installFetchMock,
  restoreFetch,
  jsonResponse,
} from "@/__tests__/helpers/fetch-mock";
import {
  dashboardEmpty,
  dashboardWithData,
} from "@/__tests__/helpers/fixtures";

/** Resolved promises so client pages don't suspend in tests (Next.js 15 passes these at runtime). */
const TEST_PARAMS = Promise.resolve({} as Record<string, string | undefined>);
const TEST_SEARCH_PARAMS = Promise.resolve(
  {} as Record<string, string | string[] | undefined>,
);

/** Renders AgentsPage and flushes React Suspense (use() with promises) so content appears. */
async function renderAgentsPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AgentsView />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return result!;
}

describe("Agents page (monitor dashboard)", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows loading state until dashboard is fetched", async () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => new Promise(() => {}),
      },
    ]);
    await renderAgentsPage();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows empty message when no agents", async () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => jsonResponse(dashboardEmpty),
      },
    ]);
    await renderAgentsPage();
    await waitFor(() => {
      expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
    });
  });

  it("shows agent list and orchestrator badge when dashboard is returned", async () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => jsonResponse(dashboardWithData),
      },
    ]);
    await renderAgentsPage();
    await waitFor(() => {
      expect(screen.getAllByText("Maia").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText("Helper")).toBeInTheDocument();
    expect(screen.getByText("orchestrator")).toBeInTheDocument();
  });

  it("shows task counts in summary when dashboard has tasks", async () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => jsonResponse(dashboardWithData),
      },
    ]);
    await renderAgentsPage();
    await waitFor(() => {
      expect(screen.getAllByText("Maia").length).toBeGreaterThanOrEqual(1);
    });
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary).toHaveTextContent("To do");
    expect(summary).toHaveTextContent("In progress");
    expect(summary).toHaveTextContent("Done");
    expect(summary).toHaveTextContent("2");
    expect(summary).toHaveTextContent("1");
    expect(summary).toHaveTextContent("3");
  });

  it("shows recent activity section when dashboard has agent sessions", async () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => jsonResponse(dashboardWithData),
      },
    ]);
    await renderAgentsPage();
    await waitFor(() => {
      expect(screen.getByText(/Recent agent activity/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Agent run")).toBeInTheDocument();
  });

  it("shows cron schedule section when dashboard has cron jobs", async () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => jsonResponse(dashboardWithData),
      },
    ]);
    await renderAgentsPage();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /Schedule/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Heartbeat")).toBeInTheDocument();
  });
});
