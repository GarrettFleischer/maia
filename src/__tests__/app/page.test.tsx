/**
 * @fileoverview RTL tests for the Home (chat) page.
 * @module __tests__/app/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import Home from "@/app/page";
import { installFetchMock, restoreFetch, jsonResponse, streamResponse } from "@/__tests__/helpers/fetch-mock";
import {
  sessionActiveEmpty,
  sessionActiveWithMessages,
  agentsEmpty,
} from "@/__tests__/helpers/fixtures";

describe("Home page", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows welcome state when no session", async () => {
    installFetchMock([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveEmpty),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
    ]);
    render(<Home />);
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Maia/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Your personal AI agent system/i)).toBeInTheDocument();
  });

  it("shows messages when session has history", async () => {
    installFetchMock([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveWithMessages),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
    ]);
    render(<Home />);
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("sends message and shows it in the list when user submits", async () => {
    installFetchMock([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveEmpty),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
      {
        url: "/api/chat",
        handler: () =>
          streamResponse([
            "data: " + JSON.stringify({ type: "done", sessionId: "new-session" }) + "\n\n",
          ]),
      },
    ]);
    render(<Home />);
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Maia/i)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/Message Maia/i);
    fireEvent.change(input, { target: { value: "Test message" } });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    fireEvent.click(sendButton);
    await waitFor(() => {
      expect(screen.getByText("Test message")).toBeInTheDocument();
    });
  });
});
