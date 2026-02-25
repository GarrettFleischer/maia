/**
 * @fileoverview Tests for ThreadListItem and getThreadLabel (including agent name resolution).
 * @module __tests__/app/components/ThreadListItem.test
 */

import { describe, it, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import ThreadListItem, { getThreadLabel } from "@/app/components/ThreadListItem";
import type { SessionMeta } from "@/lib/types";

function session(overrides: Partial<SessionMeta>): SessionMeta {
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

describe("getThreadLabel", () => {
  it("returns session name when set", () => {
    expect(getThreadLabel(session({ name: " My Thread " }))).toBe("My Thread");
  });

  it("returns agent names for user thread when agentNameMap provided", () => {
    const s = session({ type: "user", participants: ["user", "maia"] });
    const map = new Map<string, string>([["maia", "Maia"]]);
    expect(getThreadLabel(s, map)).toBe("Chat with Maia");
  });

  it("falls back to participant id when name not in map", () => {
    const s = session({ type: "user", participants: ["user", "maia"] });
    expect(getThreadLabel(s)).toBe("Chat with maia");
    expect(getThreadLabel(s, new Map())).toBe("Chat with maia");
  });

  it("returns agent names for agents thread when agentNameMap provided", () => {
    const s = session({
      type: "agents",
      participants: ["maia", "11c358ab-ce59-4418-8e05-ec07d2c2d3cb"],
    });
    const map = new Map<string, string>([
      ["maia", "Maia"],
      ["11c358ab-ce59-4418-8e05-ec07d2c2d3cb", "Helper Bot"],
    ]);
    expect(getThreadLabel(s, map)).toBe("Maia ↔ Helper Bot");
  });

  it("falls back to ids for agents thread when no map", () => {
    const s = session({
      type: "agents",
      participants: ["maia", "other-agent"],
    });
    expect(getThreadLabel(s)).toBe("maia ↔ other-agent");
  });
});

describe("ThreadListItem", () => {
  it("renders thread label and time", () => {
    render(
      <ThreadListItem
        session={session({ name: "Test thread", participants: ["user", "maia"] })}
        isActive={false}
        onSelect={() => {}}
      />
    );
    expect(screen.getByText("Test thread")).toBeInTheDocument();
  });

  it("renders agent name when agentNameMap provided", () => {
    render(
      <ThreadListItem
        session={session({ type: "user", participants: ["user", "maia"] })}
        isActive={false}
        onSelect={() => {}}
        agentNameMap={new Map([["maia", "Maia"]])}
      />
    );
    expect(screen.getByText("Chat with Maia")).toBeInTheDocument();
  });

  it("shows delete button when onDelete provided and clicking it calls onDelete with session id", () => {
    let deletedId: string | null = null;
    const onDelete = (id: string) => {
      deletedId = id;
    };
    render(
      <ThreadListItem
        session={session({ id: "thread-123", name: "My thread" })}
        isActive={false}
        onSelect={() => {}}
        onDelete={onDelete}
      />
    );
    const deleteBtn = screen.getByRole("button", { name: /delete thread/i });
    fireEvent.click(deleteBtn);
    expect(deletedId).toBe("thread-123");
  });

  it("shows rename button when onRename provided; edit flow calls onRename with session id and new name", () => {
    const calls: { id: string; name: string }[] = [];
    const onRename = (id: string, name: string) => {
      calls.push({ id, name });
    };
    render(
      <ThreadListItem
        session={session({ id: "thread-456", name: "Original" })}
        isActive={false}
        onSelect={() => {}}
        onRename={onRename}
      />
    );
    const renameBtn = screen.getByRole("button", { name: /rename|edit/i });
    fireEvent.click(renameBtn);
    const input = screen.getByDisplayValue("Original");
    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(calls).toEqual([{ id: "thread-456", name: "Renamed thread" }]);
  });
});
