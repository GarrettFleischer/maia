/**
 * @fileoverview RTL tests for the Settings page.
 * @module __tests__/app/settings/page.test
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
  act,
} from "@testing-library/react";
import SettingsContent from "@/app/settings/SettingsContent";
import {
  installFetchMock,
  restoreFetch,
  jsonResponse,
} from "@/__tests__/helpers/fetch-mock";
import {
  settingsPublic,
  agentsList,
  modelCapabilitiesFixture,
} from "@/__tests__/helpers/fixtures";

/** Resolved promises so client pages don't suspend in tests (Next.js 15 passes these at runtime). */
const TEST_PARAMS = Promise.resolve({} as Record<string, string | undefined>);
const TEST_SEARCH_PARAMS = Promise.resolve(
  {} as Record<string, string | string[] | undefined>,
);

/** Model name only (no provider prefix) as shown in whitelist rows. */
function modelDisplayName(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

/** Renders SettingsPage and flushes React Suspense (use() with promises) so content appears. */
async function renderSettingsPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <SettingsContent
        params={TEST_PARAMS}
        searchParams={TEST_SEARCH_PARAMS}
      />,
    );
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
      {
        url: "/api/settings",
        handler: () => new Promise(() => {}), // never resolves
      },
      {
        url: "/api/agents",
        handler: () => new Promise(() => {}), // never resolves
      },
      {
        url: "/api/model-capabilities",
        handler: () => new Promise(() => {}), // never resolves
      },
    ]);
    await renderSettingsPage();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows form with settings when loaded", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByText("Ollama Base URL")).toBeInTheDocument();
    });
    expect(
      screen.getByDisplayValue(settingsPublic.ollamaBaseUrl),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Smart context query model"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Smart context reasoning effort"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Save Settings/i }),
    ).toBeInTheDocument();
  });

  it("shows Saved feedback after save", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(
        screen.getByDisplayValue(settingsPublic.ollamaBaseUrl),
      ).toBeInTheDocument();
    });
    const ollamaInput = screen.getByDisplayValue(settingsPublic.ollamaBaseUrl);
    fireEvent.change(ollamaInput, {
      target: { value: "http://localhost:11435" },
    });
    const saveButton = screen.getByRole("button", { name: /Save Settings/i });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
  });

  it("displays embedding model as select from whitelist and save sends whitelistedModels and embeddingModel", async () => {
    let putBody: Record<string, unknown> = {};
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => {
          if (init?.method === "PUT" && init.body) {
            putBody = JSON.parse(init.body as string) as Record<
              string,
              unknown
            >;
          }
          return jsonResponse(settingsPublic);
        },
      },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Context & embedding" }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Context & embedding" }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Embedding model/i)).toBeInTheDocument();
    });
    const embeddingSelect = screen.getByLabelText(
      /Embedding model/i,
    ) as HTMLSelectElement;
    expect(embeddingSelect.tagName).toBe("SELECT");
    expect(embeddingSelect.value).toBe(settingsPublic.embeddingModel);
    const saveButton = screen.getByRole("button", { name: /Save Settings/i });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
    expect(putBody.whitelistedModels).toEqual(settingsPublic.whitelistedModels);
    expect(putBody.embeddingModel).toBe(settingsPublic.embeddingModel);
    expect(putBody.contextReasoningEffort).toBe(
      settingsPublic.contextReasoningEffort,
    );
  });

  it("shows a dedicated context window (num_ctx) param per model and persists it via options", async () => {
    const modelId = settingsPublic.whitelistedModels[0]!;
    const settingsWithNumCtx: typeof settingsPublic = {
      ...settingsPublic,
      modelParams: {
        [modelId]: {
          options: { num_ctx: 8192 },
        },
      },
    };
    let putBody: Record<string, unknown> = {};
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => {
          if (init?.method === "PUT" && init.body) {
            putBody = JSON.parse(init.body as string) as Record<
              string,
              unknown
            >;
          }
          return jsonResponse(settingsWithNumCtx);
        },
      },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Models" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    const whitelistSection = screen
      .getByText("Whitelisted Models")
      .closest("section");
    expect(whitelistSection).toBeInTheDocument();
    const rowWithModel = within(whitelistSection!)
      .getByText(modelDisplayName(modelId))
      .closest("div.border");
    expect(rowWithModel).toBeInTheDocument();
    const editButton = within(rowWithModel!).getByRole("button", {
      name: new RegExp(
        `Edit ${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    });
    fireEvent.click(editButton);
    const ctxInput = within(whitelistSection!).getByLabelText(
      /Context window \(num_ctx, tokens\)/i,
    ) as HTMLInputElement;
    expect(ctxInput.value).toBe("8192");
    fireEvent.change(ctxInput, { target: { value: "16000" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Settings/i }));
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
    const sentModelParams = putBody.modelParams as Record<
      string,
      { options?: Record<string, unknown> }
    >;
    expect(sentModelParams[modelId]).toBeDefined();
    const options = sentModelParams[modelId]!.options as Record<
      string,
      unknown
    >;
    expect(options.num_ctx).toBe(16000);
  });

  it("allows editing a whitelisted model in place", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Models" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    const firstModel = settingsPublic.whitelistedModels[0];
    const whitelistSectionForEdit = screen
      .getByText("Whitelisted Models")
      .closest("section");
    expect(
      within(whitelistSectionForEdit!).getByText(modelDisplayName(firstModel!)),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(
          `Edit ${firstModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      }),
    );
    await waitFor(() => {
      const editInput = screen.getByLabelText("Edit model name");
      expect(editInput).toHaveValue("llama3.2");
    });
    const editInput = screen.getByLabelText("Edit model name");
    fireEvent.change(editInput, { target: { value: "edited-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => {
      const whitelistSection = screen
        .getByText("Whitelisted Models")
        .closest("section");
      expect(whitelistSection).toBeInTheDocument();
      expect(
        within(whitelistSection!).getByText("edited-model"),
      ).toBeInTheDocument();
      expect(
        within(whitelistSection!).queryByText(modelDisplayName(firstModel!)),
      ).not.toBeInTheDocument();
    });
  });

  // Advanced JSON options have been removed from the UI in favor of first-class parameters like context window.

  it("keeps params with model when renaming: save sends params under new id", async () => {
    const settingsWithParams: typeof settingsPublic = {
      ...settingsPublic,
      whitelistedModels: ["ollama/llama3.2", "openrouter/free"],
      modelParams: {
        "ollama/llama3.2": { temperature: 0.6, top_p: 0.95 },
        "openrouter/free": { temperature: 0.7 },
      },
    };
    let putBody: Record<string, unknown> = {};
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => {
          if (init?.method === "PUT" && init.body) {
            putBody = JSON.parse(init.body as string) as Record<
              string,
              unknown
            >;
          }
          return jsonResponse(
            init?.method === "PUT" ? settingsPublic : settingsWithParams,
          );
        },
      },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Models" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Edit ollama\/llama3\.2/ }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Edit model name")).toHaveValue("llama3.2");
    });
    fireEvent.change(screen.getByLabelText("Edit model name"), {
      target: { value: "llama3.2-renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => {
      const section = screen.getByText("Whitelisted Models").closest("section");
      expect(
        within(section!).getByText("llama3.2-renamed"),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Settings/i }));
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
    const list = putBody.whitelistedModels as string[];
    const params = putBody.modelParams as Record<
      string,
      { temperature?: number; top_p?: number }
    >;
    expect(list).toContain("ollama/llama3.2-renamed");
    expect(list).not.toContain("ollama/llama3.2");
    expect(params["ollama/llama3.2-renamed"]).toEqual({
      temperature: 0.6,
      top_p: 0.95,
    });
    expect(params["openrouter/free"]).toEqual({ temperature: 0.7 });
  });

  it("allows adding and removing whitelisted models and save sends updated list", async () => {
    let putBody: Record<string, unknown> = {};
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => {
          if (init?.method === "PUT" && init.body) {
            putBody = JSON.parse(init.body as string) as Record<
              string,
              unknown
            >;
          }
          return jsonResponse(settingsPublic);
        },
      },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Models" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    const whitelistSectionAddRemove = screen
      .getByText("Whitelisted Models")
      .closest("section");
    const addInput = within(whitelistSectionAddRemove!).getByPlaceholderText(
      /Model name \(e\.g\. llama3\.2\)/,
    );
    fireEvent.change(addInput, { target: { value: "qwen2.5-coder" } });
    fireEvent.click(
      within(whitelistSectionAddRemove!).getByRole("button", { name: "Add" }),
    );
    await waitFor(() => {
      expect(
        within(whitelistSectionAddRemove!).getByText("qwen2.5-coder"),
      ).toBeInTheDocument();
    });
    const firstModelId = settingsPublic.whitelistedModels[0]!;
    const rowToRemove = within(whitelistSectionAddRemove!)
      .getByText(modelDisplayName(firstModelId))
      .closest("div.border");
    expect(rowToRemove).toBeInTheDocument();
    fireEvent.click(
      within(rowToRemove!).getByRole("button", {
        name: new RegExp(
          `Edit ${firstModelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      }),
    );
    fireEvent.click(
      within(rowToRemove!).getByRole("button", { name: /Remove/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save Settings/i }));
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
    const list = putBody.whitelistedModels as string[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toContain(firstModelId);
  });

  it("shows model assignment section with model and reasoning effort dropdowns when agents loaded", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => {
      expect(
        screen.getByText(/Model assignment|Agents & models/i),
      ).toBeInTheDocument();
    });
    const maiaRow = screen.getByText("Maia (orchestrator)").closest("div");
    expect(maiaRow).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Reasoning effort for Maia/i),
    ).toBeInTheDocument();
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps model assignment selection when whitelist is edited", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => {
      expect(screen.getByText(/Model assignment/i)).toBeInTheDocument();
    });
    const maiaCombobox = screen.getByRole("combobox", {
      name: /Model for Maia/i,
    });
    expect(maiaCombobox).toHaveTextContent(/llama3\.2/);
    const firstWhitelist = settingsPublic.whitelistedModels[0];
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(
          `Edit ${firstWhitelist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Edit model name")).toHaveValue("llama3.2");
    });
    fireEvent.change(screen.getByLabelText("Edit model name"), {
      target: { value: "llama3.2-edited" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => {
      const section = screen.getByText("Whitelisted Models").closest("section");
      expect(within(section!).getByText("llama3.2-edited")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /Model for Maia/i }),
      ).toBeInTheDocument();
    });
    const maiaComboboxAfter = screen.getByRole("combobox", {
      name: /Model for Maia/i,
    });
    expect(maiaComboboxAfter).toHaveTextContent(/llama3\.2/);
  });

  it("shows a checkmark prefix for available models in model selection dropdowns", async () => {
    const ollamaModelId =
      settingsPublic.whitelistedModels.find((id) => id.startsWith("ollama/")) ??
      "ollama/llama3.2";
    const settingsWithQueryAndEmbeddingModel: typeof settingsPublic = {
      ...settingsPublic,
      contextQueryModel: ollamaModelId,
      embeddingModel: ollamaModelId,
    };
    installFetchMock([
      {
        url: "/api/settings",
        handler: () => jsonResponse(settingsWithQueryAndEmbeddingModel),
      },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
      {
        url: "/api/ollama/models",
        handler: () => jsonResponse({ downloaded: [ollamaModelId] }),
      },
    ]);
    await renderSettingsPage();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Context & embedding" }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Context & embedding" }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Embedding model/i)).toBeInTheDocument();
    });
    const embeddingSelect = screen.getByLabelText(
      /Embedding model/i,
    ) as HTMLSelectElement;
    const embeddingOptions = Array.from(embeddingSelect.options);
    const embeddingModelOption = embeddingOptions.find(
      (o) => o.value === ollamaModelId,
    );
    expect(embeddingModelOption).toBeDefined();
    const expectedEmbedLabel =
      "Ollama " +
      (ollamaModelId.startsWith("ollama/")
        ? ollamaModelId.slice(7).replace(/\//g, " ")
        : ollamaModelId);
    expect(embeddingModelOption!.textContent).toContain(
      `✓ ${expectedEmbedLabel}`,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /Model for Maia/i }),
      ).toBeInTheDocument();
    });
    const maiaCombobox = screen.getByRole("combobox", {
      name: /Model for Maia/i,
    });
    fireEvent.click(maiaCombobox);
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
    const namePart = ollamaModelId.startsWith("ollama/")
      ? ollamaModelId.slice(7).replace(/\//g, " ")
      : ollamaModelId;
    const expectedLabel = "Ollama " + namePart;
    const listbox = screen.getByRole("listbox");
    const option = within(listbox).getByRole("option", {
      name: new RegExp(
        expectedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      ),
    });
    expect(option).toBeInTheDocument();
  });

  it("does not PATCH agent when model dropdown is changed; applies on Save after settings PUT", async () => {
    const callOrder: string[] = [];
    let putCalled = false;
    let patchUrl: string | null = null;
    let patchBody: Record<string, unknown> = {};
    installFetchMock([
      {
        url: "/api/settings",
        handler: (_url, init) => {
          if (init?.method === "PUT") {
            putCalled = true;
            callOrder.push("PUT");
          }
          return jsonResponse(settingsPublic);
        },
      },
      {
        url: "/api/agents/maia",
        handler: (url, init) => {
          if (init?.method === "PATCH" && init.body) {
            patchUrl = url;
            patchBody = JSON.parse(init.body as string) as Record<
              string,
              unknown
            >;
            callOrder.push("PATCH-maia");
          }
          return jsonResponse({
            agent: { ...agentsList.agents[0], model: "ollama/qwen2.5-coder" },
          });
        },
      },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      {
        url: "/api/ollama/models",
        handler: () =>
          jsonResponse({
            downloaded: [
              "ollama/llama3.2",
              "ollama/qwen2.5-coder",
              "ollama/nomic-embed-text",
            ],
          }),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => {
      expect(screen.getByText(/Model assignment/i)).toBeInTheDocument();
    });
    const maiaCombobox = screen.getByRole("combobox", {
      name: /Model for Maia/i,
    });
    fireEvent.click(maiaCombobox);
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
    const option = within(screen.getByRole("listbox")).getByRole("option", {
      name: /Ollama qwen2\.5-coder/i,
    });
    fireEvent.click(option);
    await waitFor(() => {
      expect(maiaCombobox).toHaveTextContent(/qwen2\.5-coder/);
    });
    expect(callOrder).toEqual([]);
    expect(patchUrl).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Save Settings/i }));
    await waitFor(() => {
      expect(screen.getByText(/Saved ✓/)).toBeInTheDocument();
    });
    expect(putCalled).toBe(true);
    expect(patchUrl).toContain("api/agents/maia");
    expect((patchBody as { model?: string }).model).toBe(
      "ollama/qwen2.5-coder",
    );
    expect((patchBody as { reasoningEffort?: string }).reasoningEffort).toBe(
      agentsList.agents[0].reasoningEffort,
    );
    expect(callOrder.indexOf("PUT")).toBe(0);
    expect(callOrder.indexOf("PATCH-maia")).toBeGreaterThan(0);
  });

  it("shows Skills section with scope selector and Add skill button", async () => {
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Skills" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Skills scope")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Add skill/i }),
    ).toBeInTheDocument();
  });

  it("disables reasoning effort dropdown when model does not support reasoning", async () => {
    const overriddenCapabilities = {
      modelCapabilities: {
        ...modelCapabilitiesFixture.modelCapabilities,
        "ollama/qwen2.5-coder": {
          provider: "ollama",
          supportsReasoning: false,
        },
      },
    };

    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse(agentsList) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(overriddenCapabilities),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ]);

    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => {
      expect(
        screen.getByText(/Model assignment|Agents & models/i),
      ).toBeInTheDocument();
    });

    const helperRow = screen.getByText("Helper").closest("div");
    expect(helperRow).toBeInTheDocument();
    const helperReasoningSelect = within(helperRow!).getByLabelText(
      /Reasoning effort for Helper/i,
    ) as HTMLSelectElement;
    expect(helperReasoningSelect.disabled).toBe(true);
  });

  it("copies ollama pull command to clipboard for undownloaded Ollama models", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    installFetchMock([
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
      {
        url: "/api/ollama/models",
        handler: () => jsonResponse({ downloaded: [] }),
      },
    ]);
    await renderSettingsPage();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Models" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    await waitFor(() => {
      expect(screen.getByText("Whitelisted Models")).toBeInTheDocument();
    });
    const copyButton = screen.getByRole("button", {
      name: /Copy ollama pull command for ollama\/llama3\.2/i,
    });
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("ollama pull llama3.2");
    });
  });

  /**
   * Credential vault UI (GET/POST /api/credentials, list keys, add/edit/delete) is not
   * implemented in SettingsContent; these tests are skipped until the UI exists.
   */
  describe.skip("Credential vault (Providers tab)", () => {
    const defaultHandlers = [
      { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
      { url: "/api/agents", handler: () => jsonResponse({ agents: [] }) },
      {
        url: "/api/model-capabilities",
        handler: () => jsonResponse(modelCapabilitiesFixture),
      },
      { url: "/api/skills", handler: () => jsonResponse({ skills: [] }) },
    ];

    it("shows Credential vault section and lists only non-default keys", async () => {
      let credentialKeys = [
        "BRAVE_SEARCH_API_KEY",
        "BRAVE_ANSWERS_API_KEY",
        "MY_CUSTOM_KEY",
      ];
      installFetchMock([
        ...defaultHandlers,
        {
          url: "/api/credentials/",
          handler: () => jsonResponse({ ok: true }),
        },
        {
          url: "/api/credentials",
          handler: (_url, init) => {
            if (init?.method === "GET") {
              return jsonResponse({ keys: credentialKeys });
            }
            if (init?.method === "POST") {
              const body = JSON.parse(init?.body as string) as {
                key: string;
                value: string;
              };
              credentialKeys = [...credentialKeys, body.key].sort();
              return jsonResponse({ ok: true }, 201);
            }
            return jsonResponse({ keys: credentialKeys });
          },
        },
      ]);
      await renderSettingsPage();
      await waitFor(() => {
        expect(screen.getByText("Ollama Base URL")).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText("Credential vault")).toBeInTheDocument();
      });
      expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
      expect(
        screen.queryByText("BRAVE_SEARCH_API_KEY"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("BRAVE_ANSWERS_API_KEY"),
      ).not.toBeInTheDocument();
    });

    it("creates a new vault credential via form and refetches list", async () => {
      let credentialKeys: string[] = [];
      installFetchMock([
        ...defaultHandlers,
        {
          url: "/api/credentials/",
          handler: () => jsonResponse({ ok: true }),
        },
        {
          url: "/api/credentials",
          handler: (_url, init) => {
            if (init?.method === "GET") {
              return jsonResponse({ keys: credentialKeys });
            }
            if (init?.method === "POST") {
              const body = JSON.parse(init?.body as string) as {
                key: string;
                value: string;
              };
              credentialKeys = [...credentialKeys, body.key].sort();
              return jsonResponse({ ok: true }, 201);
            }
            return jsonResponse({ keys: credentialKeys });
          },
        },
      ]);
      await renderSettingsPage();
      await waitFor(() => {
        expect(screen.getByText("Credential vault")).toBeInTheDocument();
      });
      const vaultSection = screen
        .getByText("Credential vault")
        .closest("section")!;
      const keyInput = within(vaultSection).getByRole("textbox", {
        name: /Credential key/i,
      });
      const valueInput =
        within(vaultSection).getByPlaceholderText("Secret value");
      fireEvent.change(keyInput, { target: { value: "NEW_KEY" } });
      fireEvent.change(valueInput, { target: { value: "secret123" } });
      fireEvent.click(screen.getByRole("button", { name: /Add credential/i }));
      await waitFor(() => {
        expect(screen.getByText("NEW_KEY")).toBeInTheDocument();
      });
    });

    it("updates a vault credential", async () => {
      const credentialKeys = ["CUSTOM_KEY"];
      let putValue: string | null = null;
      installFetchMock([
        ...defaultHandlers,
        {
          url: "/api/credentials/",
          handler: (_url, init) => {
            if (init?.method === "PUT" && init.body) {
              putValue = (JSON.parse(init.body as string) as { value: string })
                .value;
              return jsonResponse({ ok: true });
            }
            if (init?.method === "DELETE") {
              return jsonResponse({ ok: true });
            }
            return jsonResponse({ ok: true });
          },
        },
        {
          url: "/api/credentials",
          handler: (_url, init) => {
            if (init?.method === "GET") {
              return jsonResponse({ keys: credentialKeys });
            }
            return jsonResponse({ keys: credentialKeys });
          },
        },
      ]);
      await renderSettingsPage();
      await waitFor(() => {
        expect(screen.getByText("CUSTOM_KEY")).toBeInTheDocument();
      });
      const editButton = within(
        screen.getByText("CUSTOM_KEY").closest("li")!,
      ).getByRole("button", { name: /Edit/i });
      fireEvent.click(editButton);
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /Update credential/i }),
        ).toBeInTheDocument();
      });
      const valueInput = screen.getByPlaceholderText("New value");
      fireEvent.change(valueInput, { target: { value: "new-secret" } });
      fireEvent.click(
        screen.getByRole("button", { name: /Update credential/i }),
      );
      await waitFor(() => {
        expect(putValue).toBe("new-secret");
      });
    });

    it("deletes a vault credential after confirm", async () => {
      let credentialKeys = ["CUSTOM_KEY"];
      let deleteUrl: string | null = null;
      installFetchMock([
        ...defaultHandlers,
        {
          url: "/api/credentials/",
          handler: (url, init) => {
            if (init?.method === "DELETE") {
              deleteUrl = url;
              credentialKeys = credentialKeys.filter(
                (k) => !url.endsWith("/" + k),
              );
              return jsonResponse({ ok: true });
            }
            return jsonResponse({ ok: true });
          },
        },
        {
          url: "/api/credentials",
          handler: () => jsonResponse({ keys: credentialKeys }),
        },
      ]);
      await renderSettingsPage();
      await waitFor(() => {
        expect(screen.getByText("CUSTOM_KEY")).toBeInTheDocument();
      });
      const deleteButton = within(
        screen.getByText("CUSTOM_KEY").closest("li")!,
      ).getByRole("button", { name: /Delete/i });
      fireEvent.click(deleteButton);
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /Confirm delete/i }),
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: /Confirm delete/i }));
      await waitFor(() => {
        expect(deleteUrl).toContain("CUSTOM_KEY");
      });
    });
  });
});
