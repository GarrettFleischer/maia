/**
 * @fileoverview RTL tests for the Agents page.
 * @module __tests__/app/agents/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import AgentsPage from "@/app/agents/page";
import { installFetchMock, restoreFetch, jsonResponse } from "@/__tests__/helpers/fetch-mock";
import { agentsEmpty, agentsList } from "@/__tests__/helpers/fixtures";

describe("Agents page", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows loading state until agents are fetched", () => {
    installFetchMock([
      {
        url: "/api/agents",
        handler: () => new Promise(() => {}),
      },
    ]);
    render(<AgentsPage />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows empty message when no agents", async () => {
    installFetchMock([
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
    ]);
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
    });
  });

  it("shows agent list when agents are returned", async () => {
    installFetchMock([
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsList),
      },
    ]);
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText("Maia")).toBeInTheDocument();
    });
    expect(screen.getByText("Helper")).toBeInTheDocument();
    expect(screen.getByText("orchestrator")).toBeInTheDocument();
  });
});
