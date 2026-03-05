/**
 * @fileoverview RTL tests for the Tasks board page.
 * Ensures empty state rendering using mocked /api/tasks and /api/agents.
 * @module __tests__/app/tasks/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor, act } from "@testing-library/react";
import TasksView from "@/app/views/TasksView";
import {
  installFetchMock,
  restoreFetch,
  jsonResponse,
} from "@/__tests__/helpers/fetch-mock";

/** Resolved promises so client pages don't suspend in tests (Next.js 15 passes these at runtime). */
const TEST_PARAMS = Promise.resolve({} as Record<string, string | undefined>);
const TEST_SEARCH_PARAMS = Promise.resolve(
  {} as Record<string, string | string[] | undefined>,
);

/**
 * @brief Renders TasksPage and flushes Suspense so content appears.
 * @returns Render result for further assertions.
 */
async function renderTasksPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<TasksView />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return result!;
}

describe("Tasks page", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("renders three columns and shows 'No tasks' when board is empty", async () => {
    installFetchMock([
      {
        url: "/api/tasks",
        handler: () => jsonResponse({ tasks: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse({ agents: [] }),
      },
    ]);

    await renderTasksPage();

    await waitFor(() => {
      expect(screen.getByText("Task Board")).toBeInTheDocument();
    });

    expect(screen.getByText("To Do")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    const emptyLabels = screen.getAllByText("No tasks");
    expect(emptyLabels.length).toBe(3);
  });
});
