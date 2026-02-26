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
  sessionActiveWithCustomAgent,
  agentsEmpty,
  agentsList,
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

  it("sends targetAgent in chat request when session has non-maia participant", async () => {
    let chatBody: { message?: string; sessionId?: string; targetAgent?: string } = {};
    installFetchMock([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveWithCustomAgent),
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
        handler: (_url, init) => {
          try {
            chatBody = JSON.parse((init?.body as string) ?? "{}") as typeof chatBody;
          } catch {
            // ignore
          }
          return streamResponse([
            "data: " + JSON.stringify({ type: "done", sessionId: "session-custom" }) + "\n\n",
          ]);
        },
      },
    ]);
    render(<Home />);
    await waitFor(() => expect(screen.getByText("Hello")).toBeInTheDocument());
    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(chatBody.targetAgent).toBe("custom-agent"));
    expect(chatBody.message).toBe("Hi");
  });

  it("creates new thread with chosen agent via picker (POST sessions has participants)", async () => {
    let sessionsPostBody: { participants?: string[]; type?: string } = {};
    installFetchMock([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveEmpty),
      },
      {
        url: "/api/sessions",
        handler: (url, init) => {
          if (init?.method === "POST" && init?.body) {
            try {
              sessionsPostBody = JSON.parse(init.body as string) as typeof sessionsPostBody;
            } catch {
              // ignore
            }
            return jsonResponse({ sessionId: "new-thread-id" }, 201);
          }
          return jsonResponse({ sessions: [] });
        },
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsList),
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
    await waitFor(() => expect(screen.getByText(/Welcome to Maia/i)).toBeInTheDocument());
    screen.getByRole("button", { name: /new thread/i }).click();
    await waitFor(() => expect(screen.getByText("Helper")).toBeInTheDocument());
    screen.getByText("Helper").click();
    await waitFor(() => {
      expect(sessionsPostBody.participants).toEqual(["user", "agent-2"]);
      expect(sessionsPostBody.type).toBe("user");
    });
  });
});
