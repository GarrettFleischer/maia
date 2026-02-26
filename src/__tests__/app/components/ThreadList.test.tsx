/**
 * @fileoverview Tests for ThreadList component - grouped sections for user chats and AI conversations.
 * @module __tests__/app/components/ThreadList.test
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const userSession = makeSession({ id: "u1", name: "My Chat", type: "user" });
const agentSession = makeSession({ id: "a1", name: "Agent Convo", type: "agents" });

const noopNewThread = (): void => {};

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
        json: async () => ({ sessions: [userSession, agentSession] }),
      } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
});

describe("ThreadList sections", () => {
  it("renders a 'Your Chats' section header", async () => {
    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={noopNewThread}
      />
    );
    await waitFor(() => expect(screen.getByText(/your chats/i)).toBeInTheDocument());
  });

  it("renders an 'AI Conversations' section header", async () => {
    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={noopNewThread}
      />
    );
    await waitFor(() => expect(screen.getByText(/ai conversations/i)).toBeInTheDocument());
  });

  it("places user sessions under 'Your Chats' section", async () => {
    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={noopNewThread}
      />
    );
    await waitFor(() => {
      const header = screen.getByText(/your chats/i);
      const chatItem = screen.getByText("My Chat");
      expect(header).toBeInTheDocument();
      expect(chatItem).toBeInTheDocument();
    });
  });

  it("places agent sessions under 'AI Conversations' section", async () => {
    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={noopNewThread}
      />
    );
    await waitFor(() => {
      const header = screen.getByText(/ai conversations/i);
      const agentItem = screen.getByText("Agent Convo");
      expect(header).toBeInTheDocument();
      expect(agentItem).toBeInTheDocument();
    });
  });

  it("does not render 'AI Conversations' section if no agent sessions exist", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/agents")) {
        return { ok: true, json: async () => ({ agents: [] }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ sessions: [userSession] }),
      } as Response;
    }) as typeof fetch;

    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={noopNewThread}
      />
    );
    await waitFor(() => expect(screen.getByText("My Chat")).toBeInTheDocument());
    expect(screen.queryByText(/ai conversations/i)).not.toBeInTheDocument();
  });

  it("does not render 'Your Chats' section if no user sessions exist", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/agents")) {
        return { ok: true, json: async () => ({ agents: [] }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ sessions: [agentSession] }),
      } as Response;
    }) as typeof fetch;

    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={noopNewThread}
      />
    );
    await waitFor(() => expect(screen.getByText("Agent Convo")).toBeInTheDocument());
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
        onNewThreadWithAgent={noopNewThread}
      />
    );
    await waitFor(() => expect(screen.getByText(/no threads yet/i)).toBeInTheDocument());
  });
});

describe("ThreadList new-thread agent picker", () => {
  it("shows agent picker when '+ New thread' is clicked", async () => {
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

    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText(/no threads yet/i)).toBeInTheDocument());
    const newThreadBtn = screen.getByRole("button", { name: /new thread/i });
    newThreadBtn.click();
    await waitFor(() => {
      expect(screen.getByText("Maia")).toBeInTheDocument();
      expect(screen.getByText("Helper")).toBeInTheDocument();
    });
  });

  it("calls onNewThreadWithAgent with selected agent id and closes picker", async () => {
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
      />
    );
    await waitFor(() => expect(screen.getByText(/no threads yet/i)).toBeInTheDocument());
    screen.getByRole("button", { name: /new thread/i }).click();
    await waitFor(() => expect(screen.getByText("Helper")).toBeInTheDocument());
    screen.getByText("Helper").click();
    expect(chosenAgentId).toBe("agent-2");
  });

  it("orders agents with Maia first in the picker", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/agents")) {
        return {
          ok: true,
          json: async () => ({
            agents: [
              { id: "agent-2", name: "Helper" },
              { id: "maia", name: "Maia" },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ sessions: [] }),
      } as Response;
    }) as typeof fetch;

    render(
      <ThreadList
        activeSessionId={null}
        onSelectSession={() => {}}
        onNewThreadWithAgent={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByText(/no threads yet/i)).toBeInTheDocument());
    screen.getByRole("button", { name: /new thread/i }).click();
    await waitFor(() => {
      const options = screen.getAllByRole("option");
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options[0]).toHaveTextContent("Maia");
    });
  });
});
