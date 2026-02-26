/**
 * @fileoverview RTL tests for the Agents monitor dashboard page.
 * @module __tests__/app/agents/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import AgentsPage from "@/app/agents/page";
import { installFetchMock, restoreFetch, jsonResponse } from "@/__tests__/helpers/fetch-mock";
import { dashboardEmpty, dashboardWithData } from "@/__tests__/helpers/fixtures";

describe("Agents page (monitor dashboard)", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows loading state until dashboard is fetched", () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => new Promise(() => {}),
      },
    ]);
    render(<AgentsPage />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows empty message when no agents", async () => {
    installFetchMock([
      {
        url: "/api/dashboard",
        handler: () => jsonResponse(dashboardEmpty),
      },
    ]);
    render(<AgentsPage />);
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
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText("Maia")).toBeInTheDocument();
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
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText("Maia")).toBeInTheDocument();
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
    render(<AgentsPage />);
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
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Schedule/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Heartbeat")).toBeInTheDocument();
  });
});
