/**
 * @fileoverview RTL tests for QueueListMonitor header widget.
 * Verifies error state, empty state, and basic job display behavior.
 * @module __tests__/app/components/QueueListMonitor.test
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import QueueListMonitor from "@/app/components/QueueListMonitor";
import {
  installFetchMock,
  restoreFetch,
  jsonResponse,
} from "@/__tests__/helpers/fetch-mock";

type EventCallback = (event: MessageEvent) => void;

let lastEventSource: FakeEventSource | null = null;

/**
 * @brief Minimal EventSource stub for tests that captures listeners and supports close().
 */
class FakeEventSource {
  url: string;
  listeners: Record<string, EventCallback[]> = {};

  constructor(url: string) {
    this.url = url;
    lastEventSource = this;
  }

  addEventListener(type: string, cb: EventCallback): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type]!.push(cb);
  }

  close(): void {
    // no-op for tests
  }
}

describe("QueueListMonitor", () => {
  let originalEventSource: typeof EventSource | undefined;

  beforeEach(() => {
    originalEventSource = (
      globalThis as unknown as { EventSource?: typeof EventSource }
    ).EventSource;
    (
      globalThis as unknown as { EventSource?: typeof EventSource }
    ).EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    (
      globalThis as unknown as { EventSource?: typeof EventSource }
    ).EventSource = originalEventSource as typeof EventSource;
    restoreFetch();
  });

  it("shows error label when queue endpoint is unavailable", async () => {
    installFetchMock([
      {
        url: "/api/queue",
        handler: () => jsonResponse({ error: "down" }, 500),
      },
    ]);

    render(<QueueListMonitor />);

    await waitFor(() => {
      expect(screen.getByText("Queue unavailable")).toBeInTheDocument();
    });
  });

  it("renders empty state when no jobs and shows jobs when present", async () => {
    installFetchMock([
      {
        url: "/api/queue",
        handler: () => jsonResponse({ jobs: [] }),
      },
    ]);

    render(<QueueListMonitor />);

    await waitFor(() => {
      expect(screen.getByText("Queue")).toBeInTheDocument();
      expect(screen.getByText("Queue empty")).toBeInTheDocument();
    });

    // Simulate a queue_changed SSE event with one job.
    const instance = lastEventSource;
    expect(instance).not.toBeNull();
    const payload = {
      jobs: [
        {
          tool: "test_tool",
          args: { foo: "bar" },
          priority: 1,
        },
      ],
    };
    await act(async () => {
      for (const cb of instance?.listeners["queue_changed"] ?? []) {
        cb({ data: JSON.stringify(payload) } as MessageEvent);
      }
    });

    const button = screen.getByRole("button", { name: "Queue" });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      const items = screen.getAllByText(/test_tool/);
      expect(items.length).toBeGreaterThan(0);
    });
  });
});
