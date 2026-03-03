/**
 * @fileoverview RTL tests for the Cron jobs page.
 * Verifies loading and empty-state behavior using mocked /api/cron/jobs.
 * @module __tests__/app/cron/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor, act } from "@testing-library/react";
import CronPage from "@/app/cron/page";
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
 * @brief Renders CronPage and flushes Suspense so content appears.
 * @returns Render result for further assertions.
 */
async function renderCronPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <CronPage params={TEST_PARAMS} searchParams={TEST_SEARCH_PARAMS} />,
    );
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
    ]);

    await renderCronPage();

    await waitFor(() => {
      expect(screen.getByText("Cron jobs")).toBeInTheDocument();
    });

    expect(
      screen.getByText(
        /No cron jobs\. Jobs are created via agent tools or the system\./i,
      ),
    ).toBeInTheDocument();
  });
});
