/**
 * @fileoverview Tests for the OllamaPerformanceMonitor header widget component.
 * @module __tests__/app/components/OllamaPerformanceMonitor.test
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import OllamaPerformanceMonitor from "@/app/components/OllamaPerformanceMonitor";

function makeMetricsPayload() {
  return {
    host: {
      cpuPercent: 35,
      memoryUsedBytes: 12 * 1024 * 1024 * 1024,
      memoryTotalBytes: 32 * 1024 * 1024 * 1024,
    },
    processes: [
      { name: "llama3", vramBytes: 5_000_000_000, totalSizeBytes: 7_000_000_000 },
      { name: "qwen", vramBytes: 3_000_000_000, totalSizeBytes: 4_000_000_000 },
    ],
    jobs: [
      {
        id: "job-1",
        model: "ollama/llama3",
        type: "chat",
        startedAt: new Date().toISOString(),
        status: "running",
        canStop: true,
      },
    ],
  };
}

describe("OllamaPerformanceMonitor", () => {
  beforeEach(() => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/ollama/metrics")) {
        return {
          ok: true,
          json: async () => makeMetricsPayload(),
        } as Response;
      }
      return {
        ok: false,
        json: async () => ({}),
      } as Response;
    }) as typeof fetch;
  });

  it("renders a compact summary with host metrics, model count, GPU %, and VRAM", async () => {
    render(<OllamaPerformanceMonitor />);

    await waitFor(() => {
      expect(screen.getByText(/2 models/i)).toBeInTheDocument();
      expect(screen.getByText(/CPU 35%/i)).toBeInTheDocument();
      expect(screen.getByText(/RAM/i)).toBeInTheDocument();
      expect(screen.getByText(/GPU 73%/i)).toBeInTheDocument();
      expect(screen.getByText(/8\.0 GB VRAM/i)).toBeInTheDocument();
    });
  });

  it("expands to show per-process metrics and jobs when toggled", async () => {
    render(<OllamaPerformanceMonitor />);

    const toggle = await screen.findByRole("button", {
      name: /ollama metrics/i,
    });
    toggle.click();

    await waitFor(() => {
      expect(screen.getByText("llama3")).toBeInTheDocument();
      expect(screen.getByText("qwen")).toBeInTheDocument();
      expect(screen.getByText(/29%\/71% CPU\/GPU/i)).toBeInTheDocument();
      expect(screen.getByText(/25%\/75% CPU\/GPU/i)).toBeInTheDocument();
      expect(screen.getByText(/5\.0 GB VRAM/i)).toBeInTheDocument();
      expect(screen.getByText(/3\.0 GB VRAM/i)).toBeInTheDocument();
      expect(screen.getByText(/job-1/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /stop job-1/i })).toBeInTheDocument();
    });
  });

  it("shows empty states when there are no processes or jobs", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/ollama/metrics")) {
        return {
          ok: true,
          json: async () => ({
            host: {
              cpuPercent: 0,
              memoryUsedBytes: 0,
              memoryTotalBytes: 32 * 1024 * 1024 * 1024,
            },
            processes: [],
            jobs: [],
          }),
        } as Response;
      }
      return {
        ok: false,
        json: async () => ({}),
      } as Response;
    }) as typeof fetch;

    render(<OllamaPerformanceMonitor />);

    const toggle = await screen.findByRole("button", {
      name: /ollama metrics/i,
    });
    toggle.click();

    await waitFor(() => {
      expect(screen.getByText(/no active ollama models/i)).toBeInTheDocument();
      expect(screen.getByText(/no active jobs/i)).toBeInTheDocument();
      expect(screen.getByText(/GPU —/i)).toBeInTheDocument();
    });
  });

  it("shows an error indicator when the metrics API fails", async () => {
    global.fetch = mock(async () => {
      throw new Error("network failure");
    }) as typeof fetch;

    render(<OllamaPerformanceMonitor />);

    await waitFor(() => {
      expect(
        screen.getByText(/ollama metrics unavailable/i),
      ).toBeInTheDocument();
    });
  });
});

