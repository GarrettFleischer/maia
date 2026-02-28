"use client";

/**
 * @fileoverview Settings page: AI providers, agent system, whitelist, embedding model,
 * and per-agent model assignment. All changes (including agent model) apply only on Save;
 * whitelist is saved first, then agent model updates.
 * @module app/settings/page
 */

import { use, useEffect, useRef, useState } from "react";
import type { SettingsPublic, AgentDefinition, ReasoningEffort, ModelCapabilities, ModelGenerationParams } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";

/** Pre-resolved promise for tests when Next.js does not pass params/searchParams; avoids conditional use() call. */
const RESOLVED_EMPTY = Promise.resolve({} as Record<string, string | string[] | undefined>);

/** Props for settings page; params/searchParams are Promises in Next.js 15 and must be unwrapped with use(). */
type SettingsPageProps = {
  params?: Promise<Record<string, string | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function SettingsPage(props: SettingsPageProps = {}) {
  use(props.params ?? RESOLVED_EMPTY as Promise<Record<string, string | undefined>>);
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
  const [heartbeatInterval, setHeartbeatInterval] = useState(30);
  const [contextQueryModel, setContextQueryModel] = useState("");
  const [contextSummaryModel, setContextSummaryModel] = useState("");
  const [contextReasoningEffort, setContextReasoningEffort] = useState<ReasoningEffort>("medium");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embedMaxContentLength, setEmbedMaxContentLength] = useState(4000);
  const [archiveDurationValue, setArchiveDurationValue] = useState(0);
  const [archiveDurationUnit, setArchiveDurationUnit] = useState<"seconds" | "minutes" | "hours" | "days" | "months" | "years">("days");
  const [whitelistedModels, setWhitelistedModels] = useState<string[]>([]);
  const [newModelInput, setNewModelInput] = useState("");
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [modelCapabilities, setModelCapabilities] = useState<Record<string, ModelCapabilities>>({});
  const [modelParams, setModelParams] = useState<Record<string, ModelGenerationParams>>({});
  const [expandedModelParams, setExpandedModelParams] = useState<string | null>(null);
  const [rebuildingEmbeddings, setRebuildingEmbeddings] = useState(false);
  const [buildingEmbeddings, setBuildingEmbeddings] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<{ knowledgeIndexed: number; historyIndexed: number } | null>(null);
  const [buildResult, setBuildResult] = useState<{ knowledgeIndexed: number; historyIndexed: number } | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  /** Skills: scope (global vs agent), agentId when agent, list, and add/edit form. */
  const [skillsScope, setSkillsScope] = useState<"global" | "agent">("global");
  const [skillsAgentId, setSkillsAgentId] = useState("");
  const [skillsList, setSkillsList] = useState<{ id: string; name: string; description: string }[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillFormOpen, setSkillFormOpen] = useState<"add" | "edit" | null>(null);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillFormFilename, setSkillFormFilename] = useState("");
  const [skillFormName, setSkillFormName] = useState("");
  const [skillFormDescription, setSkillFormDescription] = useState("");
  const [skillFormContent, setSkillFormContent] = useState("");
  const [skillDeleteConfirmId, setSkillDeleteConfirmId] = useState<string | null>(null);
  /** Snapshot of agent models when last loaded or saved; used to PATCH only changed agents on Save. */
  const initialAgentsRef = useRef<AgentDefinition[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()) as Promise<SettingsPublic>,
      fetch("/api/agents").then((r) => r.json()).then((d: { agents: AgentDefinition[] }) => d.agents ?? []),
      fetch("/api/model-capabilities")
        .then((r) => r.json())
        .then((d: { modelCapabilities: Record<string, ModelCapabilities> }) => d.modelCapabilities)
        .catch(() => ({} as Record<string, ModelCapabilities>)),
    ]).then(([settingsData, agentsList, capabilities]) => {
      setSettings(settingsData);
      setOllamaUrl(settingsData.ollamaBaseUrl);
      setHeartbeatInterval(settingsData.heartbeatIntervalMinutes);
      setContextQueryModel(settingsData.contextQueryModel);
      setContextSummaryModel(settingsData.contextSummaryModel);
      setContextReasoningEffort(settingsData.contextReasoningEffort);
      setEmbeddingModel(settingsData.embeddingModel);
      setEmbedMaxContentLength(settingsData.embedMaxContentLength);
      setArchiveDurationValue(settingsData.archiveDurationValue);
      setArchiveDurationUnit(settingsData.archiveDurationUnit);
      setWhitelistedModels(settingsData.whitelistedModels);
      setModelParams(settingsData.modelParams ?? {});
      setAgents(agentsList);
      setModelCapabilities(capabilities);
      initialAgentsRef.current = agentsList;
      if (agentsList.length > 0 && !skillsAgentId) setSkillsAgentId(agentsList[0].id);
    });
  }, []);

  /** Fetch skills list when scope or agentId changes. */
  useEffect(() => {
    if (!settings) return;
    if (skillsScope === "agent" && !skillsAgentId) {
      setSkillsList([]);
      return;
    }
    setSkillsLoading(true);
    const params = new URLSearchParams({ scope: skillsScope });
    if (skillsScope === "agent" && skillsAgentId) params.set("agentId", skillsAgentId);
    fetch(`/api/skills?${params}`)
      .then((r) => r.json())
      .then((d: { skills: { id: string; name: string; description: string }[] }) => setSkillsList(d.skills ?? []))
      .catch(() => setSkillsList([]))
      .finally(() => setSkillsLoading(false));
  }, [settings, skillsScope, skillsAgentId]);

  const save = async () => {
    setSaving(true);
    const body: Record<string, unknown> = {
      ollamaBaseUrl: ollamaUrl,
      heartbeatIntervalMinutes: heartbeatInterval,
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
      const reasoningChanged = orig && orig.reasoningEffort !== agent.reasoningEffort;
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

  const addWhitelistModel = () => {
    const trimmed = newModelInput.trim();
    if (!trimmed || whitelistedModels.includes(trimmed)) return;
    setWhitelistedModels((prev) => [...prev, trimmed]);
    setNewModelInput("");
  };

  const removeWhitelistModel = (model: string) => {
    setWhitelistedModels((prev) => prev.filter((m) => m !== model));
    if (editingModel === model) {
      setEditingModel(null);
      setEditValue("");
    }
  };

  const startEditWhitelistModel = (model: string) => {
    setEditingModel(model);
    setEditValue(model);
  };

  const cancelEditWhitelistModel = () => {
    setEditingModel(null);
    setEditValue("");
  };

  const saveEditWhitelistModel = () => {
    if (editingModel == null) return;
    const trimmed = editValue.trim();
    if (!trimmed) return;
    const isDuplicate = whitelistedModels.some((m) => m !== editingModel && m === trimmed);
    if (isDuplicate) return;
    setWhitelistedModels((prev) =>
      prev.map((m) => (m === editingModel ? trimmed : m))
    );
    setEditingModel(null);
    setEditValue("");
  };

  /** Updates local agent model only; persisted when user clicks Save (whitelist is saved first). */
  const setAgentModel = (agentId: string, model: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, model } : a))
    );
  };

  /** Updates local agent reasoning effort only; persisted when user clicks Save. */
  const setAgentReasoningEffort = (
    agentId: string,
    reasoningEffort: AgentDefinition["reasoningEffort"],
  ) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, reasoningEffort } : a))
    );
  };

  const refreshSkillsList = () => {
    if (!settings) return;
    const params = new URLSearchParams({ scope: skillsScope });
    if (skillsScope === "agent" && skillsAgentId) params.set("agentId", skillsAgentId);
    fetch(`/api/skills?${params}`)
      .then((r) => r.json())
      .then((d: { skills: { id: string; name: string; description: string }[] }) => setSkillsList(d.skills ?? []))
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
      const d = (await res.json()) as { name: string; description: string; content: string };
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
        ...(skillsScope === "agent" && skillsAgentId && { agentId: skillsAgentId }),
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
      const res = await fetch(`/api/skills/${encodeURIComponent(editingSkillId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skillFormName.trim(),
          description: skillFormDescription.trim(),
          content: skillFormContent,
        }),
      });
      if (res.ok) {
        setSkillFormOpen(null);
        setEditingSkillId(null);
        refreshSkillsList();
      }
    }
  };

  const deleteSkill = async (id: string) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) {
      setSkillDeleteConfirmId(null);
      refreshSkillsList();
    }
  };

  /** Update or clear one model's generation params. Omit key to remove it. */
  const updateModelParam = (modelId: string, update: Partial<ModelGenerationParams>) => {
    setModelParams((prev) => {
      const cur = prev[modelId] ?? {};
      const merged = { ...cur, ...update };
      const cleaned = Object.fromEntries(
        Object.entries(merged).filter(([, v]) => v !== undefined)
      ) as ModelGenerationParams;
      if (Object.keys(cleaned).length === 0) {
        const next = { ...prev }; delete next[modelId]; return next;
      }
      return { ...prev, [modelId]: cleaned };
    });
  };

  const num = (v: number | undefined): string => (v === undefined ? "" : String(v));
  const parseNum = (s: string): number | undefined => {
    if (s.trim() === "") return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader subtitle="Settings" />

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <h1 className="text-xl font-semibold">Settings</h1>

        {!settings && <p className="text-zinc-500 text-sm">Loading...</p>}

        {settings && (
          <>
            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <h2 className="font-medium text-sm text-zinc-300">AI Providers</h2>

              <div>
                <label htmlFor="settings-ollama-url" className="block text-xs text-zinc-500 mb-1">Ollama Base URL</label>
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
                  Ollama API Key (for Ollama Cloud) {settings.hasOllamaKey && <span className="text-green-400">(configured)</span>}
                </label>
                <input
                  type="password"
                  value={ollamaApiKey}
                  onChange={(e) => setOllamaApiKey(e.target.value)}
                  placeholder={settings.hasOllamaKey ? "Enter new key to update" : "Required for cloud models (e.g. minimax-m2:cloud)"}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Ollama API Key"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  OpenRouter API Key {settings.hasOpenRouterKey && <span className="text-green-400">(configured)</span>}
                </label>
                <input
                  type="password"
                  value={openRouterKey}
                  onChange={(e) => setOpenRouterKey(e.target.value)}
                  placeholder={settings.hasOpenRouterKey ? "Enter new key to update" : "sk-or-..."}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Brave Search API Key {settings.hasBraveKey && <span className="text-green-400">(configured)</span>}
                </label>
                <input
                  type="password"
                  value={braveApiKey}
                  onChange={(e) => setBraveApiKey(e.target.value)}
                  placeholder={settings.hasBraveKey ? "Enter new key to update" : "Web search (stored encrypted)"}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Brave Search API Key"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  Brave Answers API Key {settings.hasBraveAnswersKey && <span className="text-green-400">(configured)</span>}
                </label>
                <input
                  type="password"
                  value={braveAnswersApiKey}
                  onChange={(e) => setBraveAnswersApiKey(e.target.value)}
                  placeholder={settings.hasBraveAnswersKey ? "Enter new key to update" : "Brave Answers / chat (separate billing, stored encrypted)"}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Brave Answers API Key"
                />
              </div>
            </section>

            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <h2 className="font-medium text-sm text-zinc-300">Agent System</h2>

              <p className="text-xs text-zinc-500">
                When an agent calls the <code className="bg-zinc-800 px-1 rounded">smart_context</code> tool, these models are used to extract search queries, retrieve from history and data files, filter relevant sources, and extract verbatim quotes. Leave query model blank if you do not want agents to use that tool.
              </p>

              <div>
                <label htmlFor="settings-context-query-model" className="block text-xs text-zinc-500 mb-1">Smart context: query model</label>
                <select
                  id="settings-context-query-model"
                  value={contextQueryModel}
                  onChange={(e) => setContextQueryModel(e.target.value)}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Smart context query model"
                >
                  <option value="">Disabled</option>
                  {whitelistedModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <p className="text-xs text-zinc-500 mt-0.5">Query model and quote extraction model used when an agent calls the smart_context tool. Leave blank to disable.</p>
              </div>

              <div>
                <label htmlFor="settings-context-summary-model" className="block text-xs text-zinc-500 mb-1">Smart context: quote extraction model</label>
                <select
                  id="settings-context-summary-model"
                  value={contextSummaryModel}
                  onChange={(e) => setContextSummaryModel(e.target.value)}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Smart context quote extraction model"
                >
                  <option value="">Same as query model</option>
                  {whitelistedModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <p className="text-xs text-zinc-500 mt-0.5">Model used for relevance filtering and for extracting verbatim quotes from retrieved sources (per source/chunk). Defaults to query model when blank.</p>
              </div>

              <div>
                <label htmlFor="settings-context-reasoning-effort" className="block text-xs text-zinc-500 mb-1">Smart context reasoning effort</label>
                <select
                  id="settings-context-reasoning-effort"
                  value={contextReasoningEffort}
                  onChange={(e) => setContextReasoningEffort(e.target.value as ReasoningEffort)}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Smart context reasoning effort"
                >
                  <option value="off">Off</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <p className="text-xs text-zinc-500 mt-0.5">Reasoning effort for the query, relevance filter, and quote extraction models (Ollama think / OpenRouter reasoning).</p>
              </div>

              <div>
                <label htmlFor="settings-embedding-model" className="block text-xs text-zinc-500 mb-1">Embedding model</label>
                <select
                  id="settings-embedding-model"
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Embedding model"
                >
                  {whitelistedModels.length > 0
                    ? (whitelistedModels.includes(embeddingModel) ? whitelistedModels : [embeddingModel, ...whitelistedModels]).map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))
                    : embeddingModel ? (
                        <option value={embeddingModel}>{embeddingModel}</option>
                      ) : (
                        <option value="">Select a model (add to whitelist first)</option>
                      )}
                </select>
                <p className="text-xs text-zinc-500 mt-0.5">Model for indexing files under the data folder and for history semantic search (chat_find, knowledge_search). Must be in whitelist.</p>
              </div>

              <div>
                <label htmlFor="settings-embed-max-content-length" className="block text-xs text-zinc-500 mb-1">Embed max content length (chars)</label>
                <input
                  id="settings-embed-max-content-length"
                  type="number"
                  min={500}
                  max={32000}
                  value={embedMaxContentLength}
                  onChange={(e) => setEmbedMaxContentLength(Number(e.target.value))}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Max characters per embed chunk"
                />
                <p className="text-xs text-zinc-500 mt-0.5">Truncation limit to avoid Ollama context-length errors. 4000 is safe for 2048-token default.</p>
              </div>

              <div className="flex flex-wrap gap-2 items-end">
                <button
                  type="button"
                  onClick={async () => {
                    setBuildingEmbeddings(true);
                    setBuildResult(null);
                    setRebuildError(null);
                    try {
                      const res = await fetch("/api/embeddings/build", { method: "POST" });
                      const data = (await res.json()) as { ok?: boolean; knowledgeIndexed?: number; historyIndexed?: number; error?: string };
                      if (data.ok) {
                        setBuildResult({
                          knowledgeIndexed: data.knowledgeIndexed ?? 0,
                          historyIndexed: data.historyIndexed ?? 0,
                        });
                      } else {
                        setRebuildError(data.error ?? "Build failed");
                      }
                    } catch (err) {
                      setRebuildError(err instanceof Error ? err.message : "Build failed");
                    } finally {
                      setBuildingEmbeddings(false);
                    }
                  }}
                  disabled={buildingEmbeddings || rebuildingEmbeddings}
                  className="px-4 py-2 rounded-lg bg-violet-600/20 hover:bg-violet-600/30 text-violet-400 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  aria-label="Index new knowledge and history"
                >
                  {buildingEmbeddings ? "Building…" : "Build Embeddings"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setRebuildingEmbeddings(true);
                    setRebuildResult(null);
                    setBuildResult(null);
                    setRebuildError(null);
                    try {
                      const res = await fetch("/api/embeddings/rebuild", { method: "POST" });
                      const data = (await res.json()) as { ok?: boolean; knowledgeIndexed?: number; historyIndexed?: number; error?: string };
                      if (data.ok) {
                        setRebuildResult({
                          knowledgeIndexed: data.knowledgeIndexed ?? 0,
                          historyIndexed: data.historyIndexed ?? 0,
                        });
                      } else {
                        setRebuildError(data.error ?? "Rebuild failed");
                      }
                    } catch (err) {
                      setRebuildError(err instanceof Error ? err.message : "Rebuild failed");
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
                {(buildResult || rebuildResult) && !buildingEmbeddings && !rebuildingEmbeddings && (
                  <p className="text-xs text-green-400">
                    {(buildResult ?? rebuildResult)!.knowledgeIndexed} data files, {(buildResult ?? rebuildResult)!.historyIndexed} history vectors.
                  </p>
                )}
                {rebuildError && !buildingEmbeddings && !rebuildingEmbeddings && (
                  <p className="text-xs text-red-400">{rebuildError}</p>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                Build: index new/changed data files and history. Clear & Rebuild: delete all and re-index from scratch (use after changing embedding model).
              </p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="settings-archive-duration-value" className="block text-xs text-zinc-500 mb-1">Auto archive duration (value)</label>
                  <input
                    id="settings-archive-duration-value"
                    type="number"
                    min={0}
                    value={archiveDurationValue}
                    onChange={(e) => setArchiveDurationValue(Math.max(0, Number(e.target.value)))}
                    className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                    aria-label="Archive duration value"
                  />
                </div>
                <div>
                  <label htmlFor="settings-archive-duration-unit" className="block text-xs text-zinc-500 mb-1">Unit</label>
                  <select
                    id="settings-archive-duration-unit"
                    value={archiveDurationUnit}
                    onChange={(e) => setArchiveDurationUnit(e.target.value as "seconds" | "minutes" | "hours" | "days" | "months" | "years")}
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
                Files whose last-modified time is older than this duration are considered archived and excluded from knowledge_search by default. Agents can pass include_archived: true to include them. Results always include last_modified per file. Set to 0 to disable archiving.
              </p>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">Heartbeat Interval (minutes)</label>
                <input
                  type="number"
                  value={heartbeatInterval}
                  onChange={(e) => setHeartbeatInterval(Number(e.target.value))}
                  min={1}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                />
              </div>
            </section>

            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h2 className="font-medium text-sm text-zinc-300 mb-3">Whitelisted Models</h2>
              <div className="space-y-2">
                {whitelistedModels.map((m) => (
                  <div key={m} className="flex items-center gap-2">
                    {editingModel === m ? (
                      <>
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEditWhitelistModel();
                            if (e.key === "Escape") cancelEditWhitelistModel();
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
                        <span className="text-xs font-mono text-zinc-400 bg-zinc-800 rounded px-2 py-1 flex-1">{m}</span>
                        <button
                          type="button"
                          onClick={() => startEditWhitelistModel(m)}
                          className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                          aria-label={`Edit ${m}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => removeWhitelistModel(m)}
                          className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded"
                          aria-label={`Remove ${m}`}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                ))}
                <div className="flex gap-2 mt-2">
                  <input
                    type="text"
                    value={newModelInput}
                    onChange={(e) => setNewModelInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addWhitelistModel()}
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

            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
              <h2 className="font-medium text-sm text-zinc-300">Per-model parameters</h2>
              <p className="text-xs text-zinc-500 -mt-1">
                Optional generation params per model (e.g. temperature, top_p). Useful for models like Qwen3.5 with recommended settings.
              </p>
              {whitelistedModels.length === 0 ? (
                <p className="text-xs text-zinc-500">Add models to the whitelist above to configure per-model parameters.</p>
              ) : (
                <div className="space-y-2">
                  {whitelistedModels.map((modelId) => {
                    const params = modelParams[modelId] ?? {};
                    const isExpanded = expandedModelParams === modelId;
                    return (
                      <div key={modelId} className="border border-zinc-800 rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setExpandedModelParams((prev) => (prev === modelId ? null : modelId))}
                          className="w-full flex items-center justify-between px-3 py-2 text-left text-sm bg-zinc-800/50 hover:bg-zinc-800 transition-colors"
                          aria-expanded={isExpanded}
                        >
                          <span className="font-mono text-zinc-300 truncate">{modelId}</span>
                          <span className="text-zinc-500 text-xs">
                            {Object.keys(params).length > 0 ? `${Object.keys(params).length} param(s)` : "Default"}
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="p-3 space-y-3 border-t border-zinc-800 bg-zinc-900/80">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">temperature</label>
                                <input
                                  type="number"
                                  step="0.1"
                                  min={0}
                                  max={2}
                                  value={num(params.temperature)}
                                  onChange={(e) => updateModelParam(modelId, { temperature: parseNum(e.target.value) })}
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">top_p</label>
                                <input
                                  type="number"
                                  step="0.05"
                                  min={0}
                                  max={1}
                                  value={num(params.top_p)}
                                  onChange={(e) => updateModelParam(modelId, { top_p: parseNum(e.target.value) })}
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">top_k</label>
                                <input
                                  type="number"
                                  min={1}
                                  value={num(params.top_k)}
                                  onChange={(e) => updateModelParam(modelId, { top_k: parseNum(e.target.value) })}
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">min_p</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  min={0}
                                  max={1}
                                  value={num(params.min_p)}
                                  onChange={(e) => updateModelParam(modelId, { min_p: parseNum(e.target.value) })}
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">presence_penalty</label>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={num(params.presence_penalty)}
                                  onChange={(e) => updateModelParam(modelId, { presence_penalty: parseNum(e.target.value) })}
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-zinc-500 mb-0.5">repetition_penalty</label>
                                <input
                                  type="number"
                                  step="0.1"
                                  min={0}
                                  value={num(params.repetition_penalty)}
                                  onChange={(e) => updateModelParam(modelId, { repetition_penalty: parseNum(e.target.value) })}
                                  placeholder="default"
                                  className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                                />
                              </div>
                            </div>
                            <div>
                              <label className="block text-xs text-zinc-500 mb-0.5">Advanced (JSON options)</label>
                              <textarea
                                value={params.options ? JSON.stringify(params.options, null, 2) : ""}
                                onChange={(e) => {
                                  const s = e.target.value.trim();
                                  if (!s) {
                                    updateModelParam(modelId, { options: undefined });
                                    return;
                                  }
                                  try {
                                    const parsed = JSON.parse(s) as Record<string, unknown>;
                                    updateModelParam(modelId, { options: parsed });
                                  } catch {
                                    // leave invalid JSON in place; user may be editing
                                  }
                                }}
                                placeholder='{"num_ctx": 16384}'
                                rows={2}
                                className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                              />
                              <p className="text-xs text-zinc-500 mt-0.5">Provider-specific options (e.g. Ollama num_ctx). Valid JSON object.</p>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {agents.length > 0 && (
              <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
                <h2 className="font-medium text-sm text-zinc-300">Model assignment</h2>
                <p className="text-xs text-zinc-500 -mt-2">
                  Reasoning effort is applied via the correct API for each model (Ollama think / OpenRouter reasoning.effort).
                </p>
                {agents.map((agent) => {
                  const label = agent.id === "maia" ? "Maia (orchestrator)" : agent.name;
                  const modelOptions =
                    whitelistedModels.length > 0
                      ? (whitelistedModels.includes(agent.model) ? whitelistedModels : [agent.model, ...whitelistedModels])
                      : [agent.model];
                  const effortOptions = ["off", "low", "medium", "high"] as const;
                  const capabilities = modelCapabilities[agent.model];
                  const reasoningDisabled = capabilities && capabilities.supportsReasoning === false;
                  return (
                    <div key={agent.id} className="flex items-center gap-3 flex-wrap">
                      <label htmlFor={`agent-model-${agent.id}`} className="text-sm text-zinc-300 w-40 shrink-0">
                        {label}
                      </label>
                      <select
                        id={`agent-model-${agent.id}`}
                        value={agent.model}
                        onChange={(e) => setAgentModel(agent.id, e.target.value)}
                        disabled={saving}
                        className="flex-1 min-w-0 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                        aria-label={`Model for ${label}`}
                        role="combobox"
                      >
                        {modelOptions.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                      <select
                        id={`agent-reasoning-${agent.id}`}
                        value={agent.reasoningEffort}
                        onChange={(e) =>
                          setAgentReasoningEffort(agent.id, e.target.value as AgentDefinition["reasoningEffort"])
                        }
                        disabled={saving || reasoningDisabled}
                        className="w-28 shrink-0 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                        aria-label={`Reasoning effort for ${label}`}
                      >
                        {effortOptions.map((eff) => (
                          <option key={eff} value={eff}>
                            {eff === "off" ? "Off" : eff.charAt(0).toUpperCase() + eff.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </section>
            )}

            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <h2 className="font-medium text-sm text-zinc-300">Skills</h2>
              <p className="text-xs text-zinc-500 -mt-2">
                Skills are markdown files with a name and description. They are matched to the user message by semantic similarity and their instructions are injected into the system prompt when relevant.
              </p>
              <div className="flex flex-wrap gap-2 items-center">
                <label htmlFor="skills-scope" className="text-xs text-zinc-500">Scope</label>
                <select
                  id="skills-scope"
                  value={skillsScope}
                  onChange={(e) => setSkillsScope(e.target.value as "global" | "agent")}
                  className="bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Skills scope"
                >
                  <option value="global">Global skills</option>
                  <option value="agent">Agent skills</option>
                </select>
                {skillsScope === "agent" && agents.length > 0 && (
                  <>
                    <label htmlFor="skills-agent" className="text-xs text-zinc-500 ml-2">Agent</label>
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
                        <span className="text-sm font-medium text-zinc-200">{s.name}</span>
                        <p className="text-xs text-zinc-500 truncate mt-0.5" title={s.description}>
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
                      <label htmlFor="skill-filename" className="block text-xs text-zinc-500 mb-1">Filename (slug)</label>
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
                    <label htmlFor="skill-name" className="block text-xs text-zinc-500 mb-1">Name</label>
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
                    <label htmlFor="skill-description" className="block text-xs text-zinc-500 mb-1">Description</label>
                    <input
                      id="skill-description"
                      type="text"
                      value={skillFormDescription}
                      onChange={(e) => setSkillFormDescription(e.target.value)}
                      placeholder="When to use this skill (for semantic matching)"
                      className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                      aria-label="Skill description"
                    />
                  </div>
                  <div>
                    <label htmlFor="skill-content" className="block text-xs text-zinc-500 mb-1">Instructions (markdown)</label>
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
                      onClick={() => { setSkillFormOpen(null); setEditingSkillId(null); }}
                      className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </section>

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
