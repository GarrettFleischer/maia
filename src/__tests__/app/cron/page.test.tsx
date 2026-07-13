/**
 * @fileoverview RTL tests for the Cron jobs page.
 * Verifies loading and empty-state behavior using mocked /api/cron/jobs.
 * @module __tests__/app/cron/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor, act, within, fireEvent } from "@testing-library/react";
import CronView from "@/app/views/CronView";
import { describeCronSchedule } from "@/lib/cron/describe";
import { DEFAULT_CRON_WAKE_PROMPT } from "@/lib/cron/default-wake-prompt";
import {
  installFetchMock,
  restoreFetch,
  jsonResponse,
} from "@/__tests__/helpers/fetch-mock";

/**
 * @brief Renders CronPage and flushes Suspense so content appears.
 * @returns Render result for further assertions.
 */
async function renderCronPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CronView />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return result!;
}

describe("Cron page", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows empty message when there are no cron jobs", async () => {
    installFetchMock([
      {
        url: "/api/cron/jobs",
        handler: () => jsonResponse({ jobs: [] }),
      },
      {
        url: "/api/personas",
        handler: () => jsonResponse({ personas: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse({ agents: [] }),
      },
      {
        url: "/api/settings",
        handler: () => jsonResponse({ whitelistedModels: ["openrouter/free"] }),
      },
    ]);

    await renderCronPage();

    await waitFor(() => {
      expect(screen.getByText("Schedules")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/No jobs yet\. Create one above\./i),
    ).toBeInTheDocument();
  });

  it("edit form uses quick picks when job expression matches a preset", async () => {
    installFetchMock([
      {
        url: "/api/cron/jobs",
        handler: () =>
          jsonResponse({
            jobs: [
              {
                id: "job-1",
                expression: "0 9 * * *",
                taskDescription: "Morning sweep",
                agentId: "maia",
                isBuiltIn: false,
                createdAt: "2026-01-01T00:00:00.000Z",
                toolName: "cron_echo",
                toolArgs: {},
                personaId: null,
                personaModel: null,
                cronMessage: DEFAULT_CRON_WAKE_PROMPT,
                scheduleDescription: "At 09:00",
              },
            ],
          }),
      },
      {
        url: "/api/personas",
        handler: () => jsonResponse({ personas: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse({ agents: [] }),
      },
      {
        url: "/api/settings",
        handler: () => jsonResponse({ whitelistedModels: ["openrouter/free"] }),
      },
    ]);

    await renderCronPage();

    await waitFor(() => {
      expect(screen.getByText("Morning sweep")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const panel = await screen.findByTestId("cron-edit-panel");
    const quickPick = within(panel).getByLabelText("Edit schedule quick pick");
    expect(quickPick).toBeInTheDocument();
    expect((quickPick as HTMLSelectElement).value).toBe("daily9");

    const hint = describeCronSchedule("0 9 * * *");
    expect(within(panel).getByText(hint)).toBeInTheDocument();
  });

  it("edit form opens custom cron when expression is not a quick preset", async () => {
    installFetchMock([
      {
        url: "/api/cron/jobs",
        handler: () =>
          jsonResponse({
            jobs: [
              {
                id: "job-2",
                expression: "5 * * * *",
                taskDescription: "Five past",
                agentId: "maia",
                isBuiltIn: false,
                createdAt: "2026-01-01T00:00:00.000Z",
                toolName: "cron_echo",
                toolArgs: {},
                personaId: null,
                personaModel: null,
                cronMessage: null,
              },
            ],
          }),
      },
      {
        url: "/api/personas",
        handler: () => jsonResponse({ personas: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse({ agents: [] }),
      },
      {
        url: "/api/settings",
        handler: () => jsonResponse({ whitelistedModels: ["openrouter/free"] }),
      },
    ]);

    await renderCronPage();

    await waitFor(() => {
      expect(screen.getByText("Five past")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const panel = await screen.findByTestId("cron-edit-panel");
    const customInput = within(panel).getByLabelText(
      "Edit schedule custom cron expression",
    );
    expect(customInput).toBeInTheDocument();
    expect((customInput as HTMLInputElement).value).toBe("5 * * * *");
  });

  it("shows catalog hint when personas are missing and blocks persona harness until catalogs exist", async () => {
    installFetchMock([
      {
        url: "/api/cron/jobs",
        handler: () => jsonResponse({ jobs: [] }),
      },
      {
        url: "/api/personas",
        handler: () => jsonResponse({ personas: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse({ agents: [{ id: "maia", name: "Maia" }] }),
      },
      {
        url: "/api/settings",
        handler: () => jsonResponse({ whitelistedModels: ["openrouter/free"] }),
      },
    ]);

    await renderCronPage();
    await waitFor(() => {
      expect(screen.getByText("Schedules")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/persona harness needs catalog personas/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Catalog persona" }));
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(/whitelist a model/i);
  });

  it("shows client error when custom cron is empty on create", async () => {
    installFetchMock([
      { url: "/api/cron/jobs", handler: () => jsonResponse({ jobs: [] }) },
      { url: "/api/personas", handler: () => jsonResponse({ personas: [] }) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/settings",
        handler: () => jsonResponse({ whitelistedModels: ["openrouter/free"] }),
      },
    ]);

    await renderCronPage();
    await waitFor(() => {
      expect(screen.getByText("Schedules")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Custom cron" }));
    const cronInput = screen.getByPlaceholderText(/5-field cron/i);
    fireEvent.change(cronInput, { target: { value: "   " } });

    fireEvent.change(screen.getByPlaceholderText(/Morning task sweep/i), {
      target: { value: "My schedule" },
    });

    fireEvent.submit(screen.getByRole("form", { name: "New schedule form" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /enter a valid 5-field cron expression/i,
    );
  });
});
