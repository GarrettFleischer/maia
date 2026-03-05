"use client";

/**
 * @fileoverview Settings content: AI providers, whitelist, embedding model, per-agent model.
 * Used by the app shell (SettingsView with hideHeader) and by the standalone settings route (with redirect).
 * @module app/settings/SettingsContent
 */

import { use, useEffect, useRef, useState } from "react";
import type {
  SettingsPublic,
  AgentDefinition,
  ReasoningEffort,
  ModelCapabilities,
  ModelGenerationParams,
} from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";

/** Pre-resolved promise for tests when Next.js does not pass params/searchParams; avoids conditional use() call. */
const RESOLVED_EMPTY = Promise.resolve(
  {} as Record<string, string | string[] | undefined>,
);

/** Props for settings content; params/searchParams are Promises in Next.js 15 and must be unwrapped with use(). */
type SettingsContentProps = {
  params?: Promise<Record<string, string | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  /** When true, omit AppHeader and use compact layout for embedding in app shell (tab view). */
  hideHeader?: boolean;
};

export default function SettingsContent(props: SettingsContentProps = {}) {
  use(
    props.params ??
      (RESOLVED_EMPTY as Promise<Record<string, string | undefined>>),
  );
  use(props.searchParams ?? RESOLVED_EMPTY);
  const [settings, setSettings] = useState<SettingsPublic | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [braveApiKey, setBraveApiKey] = useState("");
  const [braveAnswersApiKey, setBraveAnswersApiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [ollamaApiKey, setOllamaApiKey] = useState("");
  const [muninnUrl, setMuninnUrl] = useState("");
  const [contextQueryModel, setContextQueryModel] = useState("");
  const [contextSummaryModel, setContextSummaryModel] = useState("");
  const [contextReasoningEffort, setContextReasoningEffort] =
    useState<ReasoningEffort>("medium");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embedMaxContentLength, setEmbedMaxContentLength] = useState(4000);
  const [archiveDurationValue, setArchiveDurationValue] = useState(0);
  const [archiveDurationUnit, setArchiveDurationUnit] = useState<
    "seconds" | "minutes" | "hours" | "days" | "months" | "years"
  >("days");
  /** One row per model: id + params kept together so renaming does not lose params. */
  const [modelEntries, setModelEntries] = useState<
    Array<{ id: string; params: ModelGenerationParams }>
  >([]);
  const [newModelInput, setNewModelInput] = useState("");
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");
  const [modelCapabilities, setModelCapabilities] = useState<
    Record<string, ModelCapabilities>
  >({});
  /** Index of the row whose params are expanded (stable across renames). */
  const [expandedModelIndex, setExpandedModelIndex] = useState<number | null>(
    null,
  );
  /** Set of model ids that are downloaded on Ollama (only ollama/* ids). */
  const [downloadedOllamaModels, setDownloadedOllamaModels] = useState<
    Set<string>
  >(new Set());
  /** Per-model download status for Ollama pull: idle, in-progress, or error. */
  const [ollamaDownloadStatus, setOllamaDownloadStatus] = useState<
    Record<string, "idle" | "in-progress" | "error">
  >({});
  /** Per-model last Ollama error message, when available. */
  const [ollamaDownloadError, setOllamaDownloadError] = useState<
    Record<string, string | null>
  >({});
  const [rebuildingEmbeddings, setRebuildingEmbeddings] = useState(false);
  const [buildingEmbeddings, setBuildingEmbeddings] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<{
    knowledgeIndexed: number;
    historyIndexed: number;
  } | null>(null);
  const [buildResult, setBuildResult] = useState<{
    knowledgeIndexed: number;
    historyIndexed: number;
  } | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  /** Skills: scope (global vs agent), agentId when agent, list, and add/edit form. */
  const [skillsScope, setSkillsScope] = useState<"global" | "agent">("global");
  const [skillsAgentId, setSkillsAgentId] = useState("");
  const [skillsList, setSkillsList] = useState<
    { id: string; name: string; description: string }[]
  >([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillFormOpen, setSkillFormOpen] = useState<"add" | "edit" | null>(
    null,
  );
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillFormFilename, setSkillFormFilename] = useState("");
  const [skillFormName, setSkillFormName] = useState("");
  const [skillFormDescription, setSkillFormDescription] = useState("");
  const [skillFormContent, setSkillFormContent] = useState("");
  const [skillDeleteConfirmId, setSkillDeleteConfirmId] = useState<
    string | null
  >(null);
  /** Snapshot of agent models when last loaded or saved; used to PATCH only changed agents on Save. */
  const initialAgentsRef = useRef<AgentDefinition[]>([]);
  /** Active settings tab; panels use hidden so state is preserved when switching. */
  const [activeTab, setActiveTab] = useState<
    "providers" | "models" | "context" | "agents" | "skills"
  >("providers");

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()) as Promise<SettingsPublic>,
      fetch("/api/agents")
        .then((r) => r.json())
        .then((d: { agents: AgentDefinition[] }) => d.agents ?? []),
      fetch("/api/model-capabilities")
        .then((r) => r.json())
        .then(
          (d: { modelCapabilities: Record<string, ModelCapabilities> }) =>
            d.modelCapabilities,
        )
        .catch(() => ({}) as Record<string, ModelCapabilities>),
    ]).then(([settingsData, agentsList, capabilities]) => {
      setSettings(settingsData);
      setOllamaUrl(settingsData.ollamaBaseUrl);
      setMuninnUrl(settingsData.muninnUrl ?? "");
      setContextQueryModel(settingsData.contextQueryModel);
      setContextSummaryModel(settingsData.contextSummaryModel);
      setContextReasoningEffort(settingsData.contextReasoningEffort);
      setEmbeddingModel(settingsData.embeddingModel);
      setEmbedMaxContentLength(settingsData.embedMaxContentLength);
      setArchiveDurationValue(settingsData.archiveDurationValue);
      setArchiveDurationUnit(settingsData.archiveDurationUnit);
      setModelEntries(
        (settingsData.whitelistedModels ?? []).map((id) => ({
          id,
          params: (settingsData.modelParams ?? {})[id] ?? {},
        })),
      );
      setAgents(agentsList);
      setModelCapabilities(capabilities);
      initialAgentsRef.current = agentsList;
      if (agentsList.length > 0 && !skillsAgentId)
        setSkillsAgentId(agentsList[0].id);
    });
  }, []);

  /** Fetch which Ollama models are downloaded when whitelist or settings load. */
  useEffect(() => {
    const ollamaIds = modelEntries
      .map((e) => e.id)
      .filter((id) => id.startsWith("ollama/"));
    if (ollamaIds.length === 0) {
      setDownloadedOllamaModels(new Set());
      return;
    }
    const q = new URLSearchParams({ modelIds: ollamaIds.join(",") });
    fetch(`/api/ollama/models?${q}`)
      .then((r) => r.json())
      .then((d: { downloaded?: string[] }) =>
        setDownloadedOllamaModels(new Set(d.downloaded ?? [])),
      )
      .catch(() => setDownloadedOllamaModels(new Set()));
  }, [modelEntries]);

  /** Fetch skills list when scope or agentId changes. */
  useEffect(() => {
    if (!settings) return;
    if (skillsScope === "agent" && !skillsAgentId) {
      setSkillsList([]);
      return;
    }
    setSkillsLoading(true);
    const params = new URLSearchParams({ scope: skillsScope });
    if (skillsScope === "agent" && skillsAgentId)
      params.set("agentId", skillsAgentId);
    fetch(`/api/skills?${params}`)
      .then((r) => r.json())
      .then(
        (d: { skills: { id: string; name: string; description: string }[] }) =>
          setSkillsList(d.skills ?? []),
      )
      .catch(() => setSkillsList([]))
      .finally(() => setSkillsLoading(false));
  }, [settings, skillsScope, skillsAgentId]);

  const save = async () => {
    setSaving(true);
    const whitelistedModels = modelEntries.map((e) => e.id);
    const modelParams = Object.fromEntries(
      modelEntries
        .filter((e) => Object.keys(e.params).length > 0)
        .map((e) => [e.id, e.params] as const),
    );
    const body: Record<string, unknown> = {
      ollamaBaseUrl: ollamaUrl,
      muninnUrl: muninnUrl.trim(),
      contextQueryModel,
      contextSummaryModel,
      contextReasoningEffort,
      embeddingModel,
      embedMaxContentLength,
      archiveDurationValue,
      archiveDurationUnit,
      whitelistedModels,
      modelParams,
    };
    if (ollamaApiKey) body.ollamaApiKey = ollamaApiKey;
    if (openRouterKey) body.openRouterApiKey = openRouterKey;
    if (braveApiKey) body.braveSearchApiKey = braveApiKey;
    if (braveAnswersApiKey) body.braveAnswersApiKey = braveAnswersApiKey;

    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const updated = (await res.json()) as SettingsPublic;
    setSettings(updated);

    const initial = initialAgentsRef.current;
    for (const agent of agents) {
      const orig = initial.find((a) => a.id === agent.id);
      const modelChanged = orig && orig.model !== agent.model;
      const reasoningChanged =
        orig && orig.reasoningEffort !== agent.reasoningEffort;
      if (modelChanged || reasoningChanged) {
        await fetch(`/api/agents/${agent.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: agent.model,
            reasoningEffort: agent.reasoningEffort,
          }),
        });
      }
    }
    initialAgentsRef.current = agents;

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    if (ollamaApiKey) setOllamaApiKey("");
    if (openRouterKey) setOpenRouterKey("");
    if (braveApiKey) setBraveApiKey("");
    if (braveAnswersApiKey) setBraveAnswersApiKey("");
  };

  const whitelistedModels = modelEntries.map((e) => e.id);

  const addWhitelistModel = () => {
    const trimmed = newModelInput.trim();
    if (!trimmed || whitelistedModels.includes(trimmed)) return;
    setModelEntries((prev) => [...prev, { id: trimmed, params: {} }]);
    setNewModelInput("");
  };

  const removeWhitelistModel = (index: number) => {
    setModelEntries((prev) => prev.filter((_, i) => i !== index));
    if (editingModelIndex === index) {
      setEditingModelIndex(null);
      setEditValue("");
    } else if (editingModelIndex != null && editingModelIndex > index) {
      setEditingModelIndex(editingModelIndex - 1);
    }
    if (expandedModelIndex === index) {
      setExpandedModelIndex(null);
    } else if (expandedModelIndex != null && expandedModelIndex > index) {
      setExpandedModelIndex(expandedModelIndex - 1);
    }
  };

  const startEditWhitelistModel = (index: number) => {
    setEditingModelIndex(index);
    setEditValue(modelEntries[index]!.id);
  };

  const cancelEditWhitelistModel = () => {
    setEditingModelIndex(null);
    setEditValue("");
  };

  const saveEditWhitelistModel = () => {
    if (editingModelIndex == null) return;
    const trimmed = editValue.trim();
    if (!trimmed) return;
    const isDuplicate = modelEntries.some(
      (e, i) => i !== editingModelIndex && e.id === trimmed,
    );
    if (isDuplicate) return;
    setModelEntries((prev) =>
      prev.map((e, i) => (i === editingModelIndex ? { ...e, id: trimmed } : e)),
    );
    setEditingModelIndex(null);
    setEditValue("");
  };

  /** Updates local agent model only; persisted when user clicks Save (whitelist is saved first). */
  const setAgentModel = (agentId: string, model: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, model } : a)),
    );
  };

  /** Updates local agent reasoning effort only; persisted when user clicks Save. */
  const setAgentReasoningEffort = (
    agentId: string,
    reasoningEffort: AgentDefinition["reasoningEffort"],
  ) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, reasoningEffort } : a)),
    );
  };

  const refreshSkillsList = () => {
    if (!settings) return;
    const params = new URLSearchParams({ scope: skillsScope });
    if (skillsScope === "agent" && skillsAgentId)
      params.set("agentId", skillsAgentId);
    fetch(`/api/skills?${params}`)
      .then((r) => r.json())
      .then(
        (d: { skills: { id: string; name: string; description: string }[] }) =>
          setSkillsList(d.skills ?? []),
      )
      .catch(() => setSkillsList([]));
  };

  const openAddSkillForm = () => {
    setSkillFormFilename("");
    setSkillFormName("");
    setSkillFormDescription("");
    setSkillFormContent("");
    setEditingSkillId(null);
    setSkillFormOpen("add");
  };

  const openEditSkillForm = async (id: string) => {
    setEditingSkillId(id);
    setSkillFormOpen("edit");
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const d = (await res.json()) as {
        name: string;
        description: string;
        content: string;
      };
      setSkillFormName(d.name);
      setSkillFormDescription(d.description);
      setSkillFormContent(d.content);
      setSkillFormFilename(id.includes("/") ? id.split("/")[1]! : id);
    } catch {
      setSkillFormOpen(null);
    }
  };

  const submitSkillForm = async () => {
    if (skillFormOpen === "add") {
      const body = {
        scope: skillsScope,
        ...(skillsScope === "agent" &&
          skillsAgentId && { agentId: skillsAgentId }),
        filename: skillFormFilename.trim() || "skill",
        name: skillFormName.trim(),
        description: skillFormDescription.trim(),
        content: skillFormContent,
      };
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSkillFormOpen(null);
        refreshSkillsList();
      }
    } else if (skillFormOpen === "edit" && editingSkillId) {
      const res = await fetch(
        `/api/skills/${encodeURIComponent(editingSkillId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: skillFormName.trim(),
            description: skillFormDescription.trim(),
            content: skillFormContent,
          }),
        },
      );
      if (res.ok) {
        setSkillFormOpen(null);
        setEditingSkillId(null);
        refreshSkillsList();
      }
    }
  };

  const deleteSkill = async (id: string) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setSkillDeleteConfirmId(null);
      refreshSkillsList();
    }
  };

  /**
   * Triggers an Ollama pull for the given model id; updates downloaded set on success or error status on failure.
   * @param modelId - Full model id (e.g. "ollama/llama3.2")
   */
  const handleOllamaDownload = async (modelId: string) => {
    setOllamaDownloadStatus((prev) => ({ ...prev, [modelId]: "in-progress" }));
    setOllamaDownloadError((prev) => ({ ...prev, [modelId]: null }));
    try {
      const res = await fetch("/api/ollama/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setDownloadedOllamaModels((prev) => new Set([...prev, modelId]));
        setOllamaDownloadStatus((prev) => ({ ...prev, [modelId]: "idle" }));
      } else {
        setOllamaDownloadStatus((prev) => ({ ...prev, [modelId]: "error" }));
        setOllamaDownloadError((prev) => ({
          ...prev,
          [modelId]:
            typeof data.error === "string" && data.error.trim() !== ""
              ? data.error
              : "Download failed",
        }));
      }
    } catch (err) {
      setOllamaDownloadStatus((prev) => ({ ...prev, [modelId]: "error" }));
      setOllamaDownloadError((prev) => ({
        ...prev,
        [modelId]:
          err instanceof Error && err.message.trim() !== ""
            ? err.message
            : "Download failed",
      }));
    }
  };

  /** Update or clear one model row's generation params by index. Omit key to remove it. */
  const updateModelParam = (
    index: number,
    update: Partial<ModelGenerationParams>,
  ) => {
    setModelEntries((prev) => {
      const entry = prev[index];
      if (!entry) return prev;
      const merged = { ...entry.params, ...update };
      const cleaned = Object.fromEntries(
        Object.entries(merged).filter(([, v]) => v !== undefined),
      ) as ModelGenerationParams;
      return prev.map((e, i) =>
        i === index
          ? { ...e, params: Object.keys(cleaned).length > 0 ? cleaned : {} }
          : e,
      );
    });
  };

  const num = (v: number | undefined): string =>
    v === undefined ? "" : String(v);
  const parseNum = (s: string): number | undefined => {
    if (s.trim() === "") return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  const getModelOptionLabel = (modelId: string): string => {
    const capabilities = modelCapabilities[modelId];
    const isOllama =
      capabilities?.provider === "ollama" || modelId.startsWith("ollama/");
    const isAvailable = !isOllama || downloadedOllamaModels.has(modelId);
    return `${isAvailable ? "✓ " : ""}${modelId}`;
  };

  const wrapperClass = props.hideHeader
    ? "min-h-full overflow-auto bg-zinc-950 text-zinc-100"
    : "min-h-screen bg-zinc-950 text-zinc-100";

  return (
    <div className={wrapperClass}>
      {!props.hideHeader && (
        <AppHeader activeView="settings" subtitle="Settings" />
      )}

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <h1 className="text-xl font-semibold">Settings</h1>

        {!settings && <p className="text-zinc-500 text-sm">Loading...</p>}

        {settings && (
          <>
            <div
              role="tablist"
              aria-label="Settings sections"
              className="flex flex-wrap gap-1 border-b border-zinc-800 pb-3"
            >
              {(["providers", "models", "context", "agents", "skills"] as const)
                .filter((tab) => tab !== "agents" || agents.length > 0)
                .map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    aria-controls={`settings-tab-${tab}`}
                    id={`tab-${tab}`}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-2 rounded-t-lg text-sm font-medium transition-colors ${
                      activeTab === tab
                        ? "bg-zinc-800 text-zinc-100 border border-b-0 border-zinc-700 -mb-px"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                    }`}
                  >
                    {tab === "providers" && "Providers"}
                    {tab === "models" && "Models"}
                    {tab === "context" && "Context & embedding"}
                    {tab === "agents" && "Agents"}
                    {tab === "skills" && "Skills"}
                  </button>
                ))}
            </div>

            <div
              id="settings-tab-providers"
              role="tabpanel"
              aria-labelledby="tab-providers"
              hidden={activeTab !== "providers"}
              className="space-y-6"
            >
              <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
                <h2 className="font-medium text-sm text-zinc-300">
                  AI Providers
                </h2>

                <div>
                  <label
                    htmlFor="settings-ollama-url"
                    className="block text-xs text-zinc-500 mb-1"
                  >
                    Ollama Base URL
                  </label>
                  <input
                    id="settings-ollama-url"
                    type="text"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    placeholder="http://localhost:11434 or https://ollama.com for Ollama Cloud"
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Ollama Base URL"
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    Ollama API Key (for Ollama Cloud){" "}
                    {settings.hasOllamaKey && (
                      <span className="text-green-400">(configured)</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={ollamaApiKey}
                    onChange={(e) => setOllamaApiKey(e.target.value)}
                    placeholder={
                      settings.hasOllamaKey
                        ? "Enter new key to update"
                        : "Required for cloud models (e.g. minimax-m2:cloud)"
                    }
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Ollama API Key"
                  />
                </div>

                <div>
                  <label
                    htmlFor="settings-muninn-url"
                    className="block text-xs text-zinc-500 mb-1"
                  >
                    MuninnDB URL
                  </label>
                  <input
                    id="settings-muninn-url"
                    type="text"
                    value={muninnUrl}
                    onChange={(e) => setMuninnUrl(e.target.value)}
                    placeholder="http://localhost:8475 (optional — cognitive memory)"
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="MuninnDB URL"
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    OpenRouter API Key{" "}
                    {settings.hasOpenRouterKey && (
                      <span className="text-green-400">(configured)</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={openRouterKey}
                    onChange={(e) => setOpenRouterKey(e.target.value)}
                    placeholder={
                      settings.hasOpenRouterKey
                        ? "Enter new key to update"
                        : "sk-or-..."
                    }
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    Brave Search API Key{" "}
                    {settings.hasBraveKey && (
                      <span className="text-green-400">(configured)</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={braveApiKey}
                    onChange={(e) => setBraveApiKey(e.target.value)}
                    placeholder={
                      settings.hasBraveKey
                        ? "Enter new key to update"
                        : "Web search (stored encrypted)"
                    }
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Brave Search API Key"
                  />
                </div>

                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    Brave Answers API Key{" "}
                    {settings.hasBraveAnswersKey && (
                      <span className="text-green-400">(configured)</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={braveAnswersApiKey}
                    onChange={(e) => setBraveAnswersApiKey(e.target.value)}
                    placeholder={
                      settings.hasBraveAnswersKey
                        ? "Enter new key to update"
                        : "Brave Answers / chat (separate billing, stored encrypted)"
                    }
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Brave Answers API Key"
                  />
                </div>
              </section>
            </div>

            <div
              id="settings-tab-context"
              role="tabpanel"
              aria-labelledby="tab-context"
              hidden={activeTab !== "context"}
              className="space-y-6"
            >
              <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
                <h2 className="font-medium text-sm text-zinc-300">
                  Agent System
                </h2>

                <p className="text-xs text-zinc-500">
                  When an agent calls the{" "}
                  <code className="bg-zinc-800 px-1 rounded">
                    smart_context
                  </code>{" "}
                  tool, these models are used to extract search queries,
                  retrieve from history and data files, filter relevant sources,
                  and extract verbatim quotes. Leave query model blank if you do
                  not want agents to use that tool.
                </p>

                <div>
                  <label
                    htmlFor="settings-context-query-model"
                    className="block text-xs text-zinc-500 mb-1"
                  >
                    Smart context: query model
                  </label>
                  <select
                    id="settings-context-query-model"
                    value={contextQueryModel}
                    onChange={(e) => setContextQueryModel(e.target.value)}
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Smart context query model"
                  >
                    <option value="">Disabled</option>
                    {whitelistedModels.map((m) => (
                      <option key={m} value={m}>
                        {getModelOptionLabel(m)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Query model and quote extraction model used when an agent
                    calls the smart_context tool. Leave blank to disable.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="settings-context-summary-model"
                    className="block text-xs text-zinc-500 mb-1"
                  >
                    Smart context: quote extraction model
                  </label>
                  <select
                    id="settings-context-summary-model"
                    value={contextSummaryModel}
                    onChange={(e) => setContextSummaryModel(e.target.value)}
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Smart context quote extraction model"
                  >
                    <option value="">Same as query model</option>
                    {whitelistedModels.map((m) => (
                      <option key={m} value={m}>
                        {getModelOptionLabel(m)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Model used for relevance filtering and for extracting
                    verbatim quotes from retrieved sources (per source/chunk).
                    Defaults to query model when blank.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="settings-context-reasoning-effort"
                    className="block text-xs text-zinc-500 mb-1"
                  >
                    Smart context reasoning effort
                  </label>
                  <select
                    id="settings-context-reasoning-effort"
                    value={contextReasoningEffort}
                    onChange={(e) =>
                      setContextReasoningEffort(
                        e.target.value as ReasoningEffort,
                      )
                    }
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Smart context reasoning effort"
                  >
                    <option value="off">Off</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Reasoning effort for the query, relevance filter, and quote
                    extraction models (Ollama think / OpenRouter reasoning).
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="settings-embedding-model"
                    className="block text-xs text-zinc-500 mb-1"
                  >
                    Embedding model
                  </label>
                  <select
                    id="settings-embedding-model"
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Embedding model"
                  >
                    {whitelistedModels.length > 0 ? (
                      (whitelistedModels.includes(embeddingModel)
                        ? whitelistedModels
                        : [embeddingModel, ...whitelistedModels]
                      ).map((m) => (
                        <option key={m} value={m}>
                          {getModelOptionLabel(m)}
                        </option>
                      ))
                    ) : embeddingModel ? (
                      <option value={embeddingModel}>
                        {getModelOptionLabel(embeddingModel)}
                      </option>
                    ) : (
                      <option value="">
                        Select a model (add to whitelist first)
                      </option>
                    )}
                  </select>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Model for indexing files under the data folder and for
                    history semantic search (chat_find, knowledge_search). Must
                    be in whitelist.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="settings-embed-max-content-length"
                    className="block text-xs text-zinc-500 mb-1"
                  >
                    Embed max content length (chars)
                  </label>
                  <input
                    id="settings-embed-max-content-length"
                    type="number"
                    min={500}
                    max={32000}
                    value={embedMaxContentLength}
                    onChange={(e) =>
                      setEmbedMaxContentLength(Number(e.target.value))
                    }
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Max characters per embed chunk"
                  />
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Truncation limit to avoid Ollama context-length errors. 4000
                    is safe for 2048-token default.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 items-end">
                  <button
                    type="button"
                    onClick={async () => {
                      setBuildingEmbeddings(true);
                      setBuildResult(null);
                      setRebuildError(null);
                      try {
                        const res = await fetch("/api/embeddings/build", {
                          method: "POST",
                        });
                        const data = (await res.json()) as {
                          ok?: boolean;
                          knowledgeIndexed?: number;
                          historyIndexed?: number;
                          error?: string;
                        };
                        if (data.ok) {
                          setBuildResult({
                            knowledgeIndexed: data.knowledgeIndexed ?? 0,
                            historyIndexed: data.historyIndexed ?? 0,
                          });
                        } else {
                          setRebuildError(data.error ?? "Build failed");
                        }
                      } catch (err) {
                        setRebuildError(
                          err instanceof Error ? err.message : "Build failed",
                        );
                      } finally {
                        setBuildingEmbeddings(false);
                      }
                    }}
                    disabled={buildingEmbeddings || rebuildingEmbeddings}
                    className="px-4 py-2 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-400 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label="Index new knowledge and history"
                  >
                    {buildingEmbeddings ? "BuildingΓÇª" : "Build Embeddings"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setRebuildingEmbeddings(true);
                      setRebuildResult(null);
                      setBuildResult(null);
                      setRebuildError(null);
                      try {
                        const res = await fetch("/api/embeddings/rebuild", {
                          method: "POST",
                        });
                        const data = (await res.json()) as {
                          ok?: boolean;
                          knowledgeIndexed?: number;
                          historyIndexed?: number;
                          error?: string;
                        };
                        if (data.ok) {
                          setRebuildResult({
                            knowledgeIndexed: data.knowledgeIndexed ?? 0,
                            historyIndexed: data.historyIndexed ?? 0,
                          });
                        } else {
                          setRebuildError(data.error ?? "Rebuild failed");
                        }
                      } catch (err) {
                        setRebuildError(
                          err instanceof Error ? err.message : "Rebuild failed",
                        );
                      } finally {
                        setRebuildingEmbeddings(false);
                      }
                    }}
                    disabled={buildingEmbeddings || rebuildingEmbeddings}
                    className="px-4 py-2 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label="Clear and rebuild all embeddings"
                  >
                    {rebuildingEmbeddings ? "Rebuilding…" : "Clear & Rebuild"}
                  </button>
                  {(buildResult || rebuildResult) &&
                    !buildingEmbeddings &&
                    !rebuildingEmbeddings && (
                      <p className="text-xs text-green-400">
                        {(buildResult ?? rebuildResult)!.knowledgeIndexed} data
                        files, {(buildResult ?? rebuildResult)!.historyIndexed}{" "}
                        history vectors.
                      </p>
                    )}
                  {rebuildError &&
                    !buildingEmbeddings &&
                    !rebuildingEmbeddings && (
                      <p className="text-xs text-red-400">{rebuildError}</p>
                    )}
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Build: index new/changed data files and history. Clear &
                  Rebuild: delete all and re-index from scratch (use after
                  changing embedding model).
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label
                      htmlFor="settings-archive-duration-value"
                      className="block text-xs text-zinc-500 mb-1"
                    >
                      Auto archive duration (value)
                    </label>
                    <input
                      id="settings-archive-duration-value"
                      type="number"
                      min={0}
                      value={archiveDurationValue}
                      onChange={(e) =>
                        setArchiveDurationValue(
                          Math.max(0, Number(e.target.value)),
                        )
                      }
                      className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                      aria-label="Archive duration value"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="settings-archive-duration-unit"
                      className="block text-xs text-zinc-500 mb-1"
                    >
                      Unit
                    </label>
                    <select
                      id="settings-archive-duration-unit"
                      value={archiveDurationUnit}
                      onChange={(e) =>
                        setArchiveDurationUnit(
                          e.target.value as
                            | "seconds"
                            | "minutes"
                            | "hours"
                            | "days"
                            | "months"
                            | "years",
                        )
                      }
                      className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                      aria-label="Archive duration unit"
                    >
                      <option value="seconds">Seconds</option>
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                      <option value="months">Months</option>
                      <option value="years">Years</option>
                    </select>
                  </div>
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Files whose last-modified time is older than this duration are
                  considered archived and excluded from knowledge_search by
                  default. Agents can pass include_archived: true to include
                  them. Results always include last_modified per file. Set to 0
                  to disable archiving.
                </p>
              </section>
            </div>

            <div
              id="settings-tab-models"
              role="tabpanel"
              aria-labelledby="tab-models"
              hidden={activeTab !== "models"}
              className="space-y-6"
            >
              <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
                <h2 className="font-medium text-sm text-zinc-300 mb-3">
                  Whitelisted Models
                </h2>
                <p className="text-xs text-zinc-500 -mt-1 mb-3">
                  Model id and optional generation params (e.g. temperature,
                  top_p) are stored together so renaming a model keeps its
                  params. For Ollama models: green check = downloaded locally;
                  click the download icon to pull missing models.
                </p>
                <div className="space-y-2">
                  {modelEntries.map((entry, index) => {
                    const isEditing = editingModelIndex === index;
                    const isExpanded = expandedModelIndex === index;
                    const params = entry.params;
                    const optionsRecord = (params.options ?? {}) as Record<
                      string,
                      unknown
                    >;
                    const numCtxValue =
                      typeof optionsRecord["num_ctx"] === "number"
                        ? (optionsRecord["num_ctx"] as number)
                        : undefined;
                    const numCtxId = `settings-model-${index}-num-ctx`;
                    return (
                      <div
                        key={`${entry.id}-${index}`}
                        className="border border-zinc-800 rounded-lg overflow-hidden"
                      >
                        <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50">
                          {isEditing ? (
                            <>
                              <input
                                type="text"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    saveEditWhitelistModel();
                                  if (e.key === "Escape")
                                    cancelEditWhitelistModel();
                                }}
                                className="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                                aria-label="Edit model name"
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={saveEditWhitelistModel}
                                className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                                aria-label="Save edit"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={cancelEditWhitelistModel}
                                className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                                aria-label="Cancel edit"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <span className="text-xs font-mono text-zinc-400 bg-zinc-800 rounded px-2 py-1 flex-1 flex items-center gap-1.5">
                                {entry.id}
                                {entry.id.startsWith("ollama/") ? (
                                  downloadedOllamaModels.has(entry.id) ? (
                                    <span
                                      className="shrink-0 text-green-500"
                                      title="Downloaded on Ollama"
                                      aria-label={`Downloaded: ${entry.id}`}
                                    >
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                        <polyline points="22 4 12 14.01 9 11.01" />
                                      </svg>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleOllamaDownload(entry.id)
                                      }
                                      disabled={
                                        ollamaDownloadStatus[entry.id] ===
                                        "in-progress"
                                      }
                                      className="shrink-0 text-amber-500 hover:text-amber-400 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                                      aria-label={`Download ${entry.id}`}
                                      title="Download model with Ollama"
                                    >
                                      {ollamaDownloadStatus[entry.id] ===
                                      "in-progress" ? (
                                        "Downloading…"
                                      ) : (
                                        <svg
                                          width="14"
                                          height="14"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        >
                                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                          <polyline points="7 10 12 15 17 10" />
                                          <line
                                            x1="12"
                                            y1="15"
                                            x2="12"
                                            y2="3"
                                          />
                                        </svg>
                                      )}
                                    </button>
                                  )
                                ) : null}
                              </span>
                              <button
                                type="button"
                                onClick={() => startEditWhitelistModel(index)}
                                className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                                aria-label={`Edit ${entry.id}`}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => removeWhitelistModel(index)}
                                className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                                aria-label={`Remove ${entry.id}`}
                              >
                                Remove
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedModelIndex((prev) =>
                                prev === index ? null : index,
                              )
                            }
                            className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1 rounded shrink-0"
                            aria-expanded={isExpanded}
                            aria-label={
                              isExpanded ? "Collapse params" : "Expand params"
                            }
                          >
                            {Object.keys(params).length > 0
                              ? `${Object.keys(params).length} param(s)`
                              : "Params"}
                          </button>
                        </div>
                        {entry.id.startsWith("ollama/") &&
                          ollamaDownloadStatus[entry.id] === "error" && (
                            <div className="px-3 pb-2">
                              <span className="text-xs text-red-400">
                                {ollamaDownloadError[entry.id] ??
                                  "Download failed"}
                              </span>
                            </div>
                          )}
                        {isExpanded && (
                          <div className="p-3 space-y-3 border-t border-zinc-800 bg-zinc-900/80">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">
                                  temperature
                                </label>
                                <input
                                  type="number"
                                  step="0.1"
                                  min={0}
                                  max={2}
                                  value={num(params.temperature)}
                                  onChange={(e) =>
                                    updateModelParam(index, {
                                      temperature: parseNum(e.target.value),
                                    })
                                  }
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">
                                  top_p
                                </label>
                                <input
                                  type="number"
                                  step="0.05"
                                  min={0}
                                  max={1}
                                  value={num(params.top_p)}
                                  onChange={(e) =>
                                    updateModelParam(index, {
                                      top_p: parseNum(e.target.value),
                                    })
                                  }
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">
                                  top_k
                                </label>
                                <input
                                  type="number"
                                  min={1}
                                  value={num(params.top_k)}
                                  onChange={(e) =>
                                    updateModelParam(index, {
                                      top_k: parseNum(e.target.value),
                                    })
                                  }
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">
                                  min_p
                                </label>
                                <input
                                  type="number"
                                  step="0.01"
                                  min={0}
                                  max={1}
                                  value={num(params.min_p)}
                                  onChange={(e) =>
                                    updateModelParam(index, {
                                      min_p: parseNum(e.target.value),
                                    })
                                  }
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">
                                  presence_penalty
                                </label>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={num(params.presence_penalty)}
                                  onChange={(e) =>
                                    updateModelParam(index, {
                                      presence_penalty: parseNum(
                                        e.target.value,
                                      ),
                                    })
                                  }
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">
                                  repetition_penalty
                                </label>
                                <input
                                  type="number"
                                  step="0.1"
                                  min={0}
                                  value={num(params.repetition_penalty)}
                                  onChange={(e) =>
                                    updateModelParam(index, {
                                      repetition_penalty: parseNum(
                                        e.target.value,
                                      ),
                                    })
                                  }
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                            </div>
                            <div>
                              <label
                                htmlFor={numCtxId}
                                className="block text-xs text-zinc-500 mb-0.5"
                              >
                                Context window (num_ctx, tokens)
                              </label>
                              <input
                                id={numCtxId}
                                type="number"
                                min={0}
                                value={
                                  numCtxValue === undefined
                                    ? ""
                                    : String(numCtxValue)
                                }
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  const trimmed = raw.trim();
                                  const n =
                                    trimmed === ""
                                      ? undefined
                                      : Number(trimmed);
                                  const baseOptions = (params.options ??
                                    {}) as Record<string, unknown>;
                                  const nextOptions: Record<string, unknown> = {
                                    ...baseOptions,
                                  };
                                  if (n === undefined || Number.isNaN(n)) {
                                    delete nextOptions["num_ctx"];
                                  } else {
                                    nextOptions["num_ctx"] = n;
                                  }
                                  if (Object.keys(nextOptions).length === 0) {
                                    updateModelParam(index, {
                                      options: undefined,
                                    });
                                  } else {
                                    updateModelParam(index, {
                                      options: nextOptions,
                                    });
                                  }
                                }}
                                placeholder="e.g. 16384"
                                className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                aria-label="Context window (num_ctx, tokens)"
                              />
                              <p className="text-xs text-zinc-500 mt-0.5">
                                Per-model context window in tokens. For Ollama,
                                this sets options.num_ctx.
                              </p>
                            </div>
                            <div></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="flex gap-2 mt-2">
                    <input
                      type="text"
                      value={newModelInput}
                      onChange={(e) => setNewModelInput(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && addWhitelistModel()
                      }
                      placeholder="Add model"
                      className="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    />
                    <button
                      type="button"
                      onClick={addWhitelistModel}
                      className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </section>
            </div>

            <div
              id="settings-tab-agents"
              role="tabpanel"
              aria-labelledby="tab-agents"
              hidden={activeTab !== "agents"}
              className="space-y-6"
            >
              {agents.length > 0 && (
                <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
                  <h2 className="font-medium text-sm text-zinc-300">
                    Model assignment
                  </h2>
                  <p className="text-xs text-zinc-500 -mt-2">
                    Reasoning effort is applied via the correct API for each
                    model (Ollama think / OpenRouter reasoning.effort).
                  </p>
                  {agents.map((agent) => {
                    const label =
                      agent.id === "maia" ? "Maia (orchestrator)" : agent.name;
                    const modelOptions =
                      whitelistedModels.length > 0
                        ? whitelistedModels.includes(agent.model)
                          ? whitelistedModels
                          : [agent.model, ...whitelistedModels]
                        : [agent.model];
                    const effortOptions = [
                      "off",
                      "low",
                      "medium",
                      "high",
                    ] as const;
                    const capabilities = modelCapabilities[agent.model];
                    const reasoningDisabled =
                      capabilities && capabilities.supportsReasoning === false;
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center gap-3 flex-wrap"
                      >
                        <label
                          htmlFor={`agent-model-${agent.id}`}
                          className="text-sm text-zinc-300 w-40 shrink-0"
                        >
                          {label}
                        </label>
                        <select
                          id={`agent-model-${agent.id}`}
                          value={agent.model}
                          onChange={(e) =>
                            setAgentModel(agent.id, e.target.value)
                          }
                          disabled={saving}
                          className="flex-1 min-w-0 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                          aria-label={`Model for ${label}`}
                          role="combobox"
                        >
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>
                              {getModelOptionLabel(m)}
                            </option>
                          ))}
                        </select>
                        <select
                          id={`agent-reasoning-${agent.id}`}
                          value={agent.reasoningEffort}
                          onChange={(e) =>
                            setAgentReasoningEffort(
                              agent.id,
                              e.target
                                .value as AgentDefinition["reasoningEffort"],
                            )
                          }
                          disabled={saving || reasoningDisabled}
                          className="w-28 shrink-0 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                          aria-label={`Reasoning effort for ${label}`}
                        >
                          {effortOptions.map((eff) => (
                            <option key={eff} value={eff}>
                              {eff === "off"
                                ? "Off"
                                : eff.charAt(0).toUpperCase() + eff.slice(1)}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </section>
              )}
            </div>

            <div
              id="settings-tab-skills"
              role="tabpanel"
              aria-labelledby="tab-skills"
              hidden={activeTab !== "skills"}
              className="space-y-6"
            >
              <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
                <h2 className="font-medium text-sm text-zinc-300">Skills</h2>
                <p className="text-xs text-zinc-500 -mt-2">
                  Skills are markdown files with a name and description. They
                  are matched to the user message by semantic similarity and
                  their instructions are injected into the system prompt when
                  relevant.
                </p>
                <div className="flex flex-wrap gap-2 items-center">
                  <label
                    htmlFor="skills-scope"
                    className="text-xs text-zinc-500"
                  >
                    Scope
                  </label>
                  <select
                    id="skills-scope"
                    value={skillsScope}
                    onChange={(e) =>
                      setSkillsScope(e.target.value as "global" | "agent")
                    }
                    className="bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Skills scope"
                  >
                    <option value="global">Global skills</option>
                    <option value="agent">Agent skills</option>
                  </select>
                  {skillsScope === "agent" && agents.length > 0 && (
                    <>
                      <label
                        htmlFor="skills-agent"
                        className="text-xs text-zinc-500 ml-2"
                      >
                        Agent
                      </label>
                      <select
                        id="skills-agent"
                        value={skillsAgentId}
                        onChange={(e) => setSkillsAgentId(e.target.value)}
                        className="bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                        aria-label="Agent for skills"
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.id === "maia" ? "Maia" : a.name}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
                {skillsLoading ? (
                  <p className="text-xs text-zinc-500">Loading skills…</p>
                ) : (
                  <div className="space-y-2">
                    {skillsList.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-start gap-2 py-2 border-b border-zinc-800 last:border-0"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-zinc-200">
                            {s.name}
                          </span>
                          <p
                            className="text-xs text-zinc-500 truncate mt-0.5"
                            title={s.description}
                          >
                            {s.description}
                          </p>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => openEditSkillForm(s.id)}
                            className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                            aria-label={`Edit ${s.name}`}
                          >
                            Edit
                          </button>
                          {skillDeleteConfirmId === s.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => deleteSkill(s.id)}
                                className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded"
                                aria-label="Confirm delete"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setSkillDeleteConfirmId(null)}
                                className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                                aria-label="Cancel delete"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setSkillDeleteConfirmId(s.id)}
                              className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                              aria-label={`Delete ${s.name}`}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {!skillFormOpen && (
                      <button
                        type="button"
                        onClick={openAddSkillForm}
                        className="mt-2 px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm"
                        aria-label="Add skill"
                      >
                        Add skill
                      </button>
                    )}
                  </div>
                )}
                {skillFormOpen && (
                  <div className="mt-4 p-4 border border-zinc-800 rounded-lg space-y-3 bg-zinc-800/50">
                    <h3 className="text-sm font-medium text-zinc-300">
                      {skillFormOpen === "add" ? "New skill" : "Edit skill"}
                    </h3>
                    {skillFormOpen === "add" && (
                      <div>
                        <label
                          htmlFor="skill-filename"
                          className="block text-xs text-zinc-500 mb-1"
                        >
                          Filename (slug)
                        </label>
                        <input
                          id="skill-filename"
                          type="text"
                          value={skillFormFilename}
                          onChange={(e) => setSkillFormFilename(e.target.value)}
                          placeholder="commit-style"
                          className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                          aria-label="Skill filename"
                        />
                      </div>
                    )}
                    <div>
                      <label
                        htmlFor="skill-name"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Name
                      </label>
                      <input
                        id="skill-name"
                        type="text"
                        value={skillFormName}
                        onChange={(e) => setSkillFormName(e.target.value)}
                        placeholder="Skill name"
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                        aria-label="Skill name"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="skill-description"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Description
                      </label>
                      <input
                        id="skill-description"
                        type="text"
                        value={skillFormDescription}
                        onChange={(e) =>
                          setSkillFormDescription(e.target.value)
                        }
                        placeholder="When to use this skill (for semantic matching)"
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                        aria-label="Skill description"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="skill-content"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Instructions (markdown)
                      </label>
                      <textarea
                        id="skill-content"
                        value={skillFormContent}
                        onChange={(e) => setSkillFormContent(e.target.value)}
                        placeholder="# Instructions..."
                        rows={8}
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600 font-mono"
                        aria-label="Skill content"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={submitSkillForm}
                        className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-medium"
                      >
                        {skillFormOpen === "add" ? "Create" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSkillFormOpen(null);
                          setEditingSkillId(null);
                        }}
                        className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>

            <button
              onClick={save}
              disabled={saving}
              className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-sm font-medium transition-colors"
            >
              {saved ? "Saved ✓" : saving ? "Saving..." : "Save Settings"}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
