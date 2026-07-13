/**
 * @fileoverview Tests for ThreadList: user chat threads and Maia-only new thread.
 * @module __tests__/app/components/ThreadList.test
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ThreadList from "@/app/components/ThreadList";
import type { SessionMeta } from "@/lib/types";

function makeSession(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s1",
    name: "",
    description: "",
    participants: [],
    tags: [],
    type: "user",
    defaultPersonaId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const userSession = makeSession({ id: "u1", name: "My Chat", type: "user" });

beforeEach(() => {
  global.fetch = mock(async (url: string) => {
    if (typeof url === "string" && url.includes("/api/agents")) {
      return {
        ok: true,
        json: async () => ({ agents: [{ id: "maia", name: "Maia" }] }),
      } as Response;
    }
    if (typeof url === "string" && url.includes("/api/sessions")) {
      return {
        ok: true,
        json: async () => ({ sessions: [userSession] }),
      } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
});

describe("ThreadList", () => {
  it("renders a 'Your Chats' section header when user sessions exist", async () => {
    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/your chats/i)).toBeInTheDocument(),
    );
  });

  it("places user sessions under 'Your Chats' section", async () => {
    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/your chats/i)).toBeInTheDocument();
      expect(screen.getByText("My Chat")).toBeInTheDocument();
    });
  });

  it("does not render 'Your Chats' when only non-user sessions exist", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/agents")) {
        return { ok: true, json: async () => ({ agents: [] }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          sessions: [
            makeSession({
              id: "a1",
              name: "Legacy A2A",
              type: "agents",
            }),
          ],
        }),
      } as Response;
    }) as typeof fetch;

    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/loading threads/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/your chats/i)).not.toBeInTheDocument();
  });

  it("shows 'No threads yet' when no sessions exist at all", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/agents")) {
        return { ok: true, json: async () => ({ agents: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ sessions: [] }) } as Response;
    }) as typeof fetch;

    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/no threads yet/i)).toBeInTheDocument(),
    );
  });

  it("calls onNewThreadWithAgent with maia when '+ New thread' is clicked", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/agents")) {
        return {
          ok: true,
          json: async () => ({
            agents: [
              { id: "maia", name: "Maia" },
              { id: "agent-2", name: "Helper" },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ sessions: [] }),
      } as Response;
    }) as typeof fetch;

    let chosenAgentId: string | null = null;
    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={(agentId) => {
          chosenAgentId = agentId;
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/no threads yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));
    expect(chosenAgentId).toBe("maia");
  });
});
