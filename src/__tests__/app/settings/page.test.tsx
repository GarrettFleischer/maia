/**
 * @fileoverview RTL tests for the Settings page.
 * @module __tests__/app/settings/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import { installFetchMock, restoreFetch, jsonResponse } from "@/__tests__/helpers/fetch-mock";
import { settingsPublic } from "@/__tests__/helpers/fixtures";

describe("Settings page", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows loading state until settings are fetched", () => {
    installFetchMock([
      {
        url: "/api/settings",
        handler: () => new Promise(() => {}), // never resolves
      },
    ]);
    render(<SettingsPage />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows form with settings when loaded", async () => {
    installFetchMock([
      {
        url: "/api/settings",
        handler: () => jsonResponse(settingsPublic),
      },
    ]);
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("Ollama Base URL")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(settingsPublic.ollamaBaseUrl)).toBeInTheDocument();
    expect(screen.getByDisplayValue(settingsPublic.compressionModel)).toBeInTheDocument();
    expect(screen.getByDisplayValue(String(settingsPublic.heartbeatIntervalMinutes))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Settings/i })).toBeInTheDocument();
  });

  it("shows Saved feedback after save", async () => {
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => jsonResponse(settingsPublic),
      },
    ]);
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue(settingsPublic.ollamaBaseUrl)).toBeInTheDocument();
    });
    const ollamaInput = screen.getByDisplayValue(settingsPublic.ollamaBaseUrl);
    fireEvent.change(ollamaInput, { target: { value: "http://localhost:11435" } });
    const saveButton = screen.getByRole("button", { name: /Save Settings/i });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
  });
});
