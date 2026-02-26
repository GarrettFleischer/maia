/**
 * @fileoverview RTL tests for the Settings page.
 * @module __tests__/app/settings/page.test
 */

import { describe, it, expect, afterEach } from "bun:test";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import { installFetchMock, restoreFetch, jsonResponse } from "@/__tests__/helpers/fetch-mock";
import { settingsPublic, agentsList } from "@/__tests__/helpers/fixtures";

/** Resolved promises so client pages don't suspend in tests (Next.js 15 passes these at runtime). */
const TEST_PARAMS = Promise.resolve({} as Record<string, string | undefined>);
const TEST_SEARCH_PARAMS = Promise.resolve({} as Record<string, string | string[] | undefined>);

/** Renders SettingsPage and flushes React Suspense (use() with promises) so content appears. */
async function renderSettingsPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<SettingsPage params={TEST_PARAMS} searchParams={TEST_SEARCH_PARAMS} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return result!;
}

describe("Settings page", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows loading state until settings are fetched", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => new Promise(() => {}), // never resolves
      },
      { url: "/api/agents", handler: () => new Promise(() => {}), // never resolves
      },
    ]);
    await renderSettingsPage();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows form with settings when loaded", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByText("Ollama Base URL")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(settingsPublic.ollamaBaseUrl)).toBeInTheDocument();
    const vllmUrlInput = screen.getByLabelText("vLLM Base URL");
    expect(vllmUrlInput).toBeInTheDocument();
    expect(vllmUrlInput).toHaveValue(settingsPublic.vllmBaseUrl);
    const dockerUrlInput = screen.getByLabelText("Docker Base URL");
    expect(dockerUrlInput).toBeInTheDocument();
    expect(dockerUrlInput).toHaveValue(settingsPublic.dockerBaseUrl);
    const compressionSelect = screen.getByLabelText("Compression model");
    expect(compressionSelect).toBeInTheDocument();
    expect(compressionSelect).toHaveValue(settingsPublic.compressionModel);
    expect(screen.getByDisplayValue(String(settingsPublic.heartbeatIntervalMinutes))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Settings/i })).toBeInTheDocument();
  });

  it("shows Saved feedback after save", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
    ]);
    await renderSettingsPage();
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

  it("displays embedding model and save sends whitelistedModels and embeddingModel", async () => {
    let putBody: Record<string, unknown> = {};
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => {
          if (init?.method === "PUT" && init.body) {
            putBody = JSON.parse(init.body as string) as Record<string, unknown>;
          }
          return jsonResponse(settingsPublic);
        },
      },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByLabelText("Compression model")).toHaveValue(settingsPublic.compressionModel);
    });
    expect(screen.getByLabelText(/Embedding model/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue(settingsPublic.embeddingModel)).toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: /Save Settings/i });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
    expect(putBody.whitelistedModels).toEqual(settingsPublic.whitelistedModels);
    expect(putBody.embeddingModel).toBe(settingsPublic.embeddingModel);
    expect(putBody.vllmBaseUrl).toBe(settingsPublic.vllmBaseUrl);
    expect(putBody.dockerBaseUrl).toBe(settingsPublic.dockerBaseUrl);
  });

  it("allows editing a whitelisted model in place", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    const firstModel = settingsPublic.whitelistedModels[0];
    const whitelistSectionForEdit = screen.getByText("Whitelisted Models").closest("section");
    expect(within(whitelistSectionForEdit!).getByText(firstModel)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`Edit ${firstModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }));
    await waitFor(() => {
      const editInput = screen.getByLabelText("Edit model name");
      expect(editInput).toHaveValue(firstModel);
    });
    const editInput = screen.getByLabelText("Edit model name");
    fireEvent.change(editInput, { target: { value: "ollama/edited-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => {
      const whitelistSection = screen.getByText("Whitelisted Models").closest("section");
      expect(whitelistSection).toBeInTheDocument();
      expect(within(whitelistSection!).getByText("ollama/edited-model")).toBeInTheDocument();
      expect(within(whitelistSection!).queryByText(firstModel)).not.toBeInTheDocument();
    });
  });

  it("allows adding and removing whitelisted models and save sends updated list", async () => {
    let putBody: Record<string, unknown> = {};
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => {
          if (init?.method === "PUT" && init.body) {
            putBody = JSON.parse(init.body as string) as Record<string, unknown>;
          }
          return jsonResponse(settingsPublic);
        },
      },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    const addInput = screen.getByPlaceholderText(/Add model/i);
    fireEvent.change(addInput, { target: { value: "ollama/qwen2.5-coder" } });
    fireEvent.click(screen.getByRole("button", { name: /Add/i }));
    const whitelistSectionAddRemove = screen.getByText("Whitelisted Models").closest("section");
    await waitFor(() => {
      expect(within(whitelistSectionAddRemove!).getByText("ollama/qwen2.5-coder")).toBeInTheDocument();
    });
    const removeButtons = within(whitelistSectionAddRemove!).getAllByRole("button", { name: /Remove/i });
    fireEvent.click(removeButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: /Save Settings/i }));
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
    const list = putBody.whitelistedModels as string[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toContain(settingsPublic.whitelistedModels[0]);
  });

  it("shows model assignment section and Maia model dropdown when agents loaded", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByText(/Model assignment|Agents & models/i)).toBeInTheDocument();
    });
    const maiaRow = screen.getByText("Maia (orchestrator)").closest("div");
    expect(maiaRow).toBeInTheDocument();
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps model assignment selection when whitelist is edited", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByText(/Model assignment/i)).toBeInTheDocument();
    });
    const maiaSelect = screen.getByRole("combobox", { name: /Model for Maia/i }) as HTMLSelectElement;
    expect(maiaSelect.value).toBe(agentsList.agents[0].model);
    const firstWhitelist = settingsPublic.whitelistedModels[0];
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`Edit ${firstWhitelist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }));
    await waitFor(() => {
      expect(screen.getByLabelText("Edit model name")).toHaveValue(firstWhitelist);
    });
    fireEvent.change(screen.getByLabelText("Edit model name"), { target: { value: "ollama/llama3.2-edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => {
      const section = screen.getByText("Whitelisted Models").closest("section");
      expect(within(section!).getByText("ollama/llama3.2-edited")).toBeInTheDocument();
    });
    const maiaSelectAfter = screen.getByRole("combobox", { name: /Model for Maia/i }) as HTMLSelectElement;
    expect(maiaSelectAfter.value).toBe(agentsList.agents[0].model);
  });

  it("PATCHes agent when Maia model dropdown is changed", async () => {
    let patchUrl: string | null = null;
    let patchBody: Record<string, unknown> = {};
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      {
        url: "/api/agents/maia",
        handler: (url, init) => {
          if (init?.method === "PATCH" && init.body) {
            patchUrl = url;
            patchBody = JSON.parse(init.body as string) as Record<string, unknown>;
          }
          return jsonResponse({ agent: { ...agentsList.agents[0], model: "ollama/qwen2.5-coder" } });
        },
      },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByText(/Model assignment/i)).toBeInTheDocument();
    });
    const maiaSelect = screen.getByRole("combobox", { name: /Model for Maia/i });
    fireEvent.change(maiaSelect, { target: { value: "ollama/qwen2.5-coder" } });
    await waitFor(() => {
      expect(patchUrl).toContain("api/agents/maia");
      expect(patchBody).toBeDefined();
      expect(typeof patchBody).toBe("object");
      expect((patchBody as { model?: string }).model).toBe("ollama/qwen2.5-coder");
    });
  });
});
