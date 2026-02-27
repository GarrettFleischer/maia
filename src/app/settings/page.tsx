"use client";

/**
 * @fileoverview Settings page: AI providers, agent system, whitelist, embedding model,
 * and per-agent model assignment. All changes (including agent model) apply only on Save;
 * whitelist is saved first, then agent model updates.
 * @module app/settings/page
 */

import { use, useEffect, useRef, useState } from "react";
import type { SettingsPublic, AgentDefinition, ReasoningEffort, ModelCapabilities } from "@/lib/types";
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
  const [vllmBaseUrl, setVllmBaseUrl] = useState("");
  const [dockerBaseUrl, setDockerBaseUrl] = useState("");
  const [heartbeatInterval, setHeartbeatInterval] = useState(30);
  const [contextQueryModel, setContextQueryModel] = useState("");
  const [contextSummaryModel, setContextSummaryModel] = useState("");
  const [contextRecentTurns, setContextRecentTurns] = useState(3);
  const [contextReasoningEffort, setContextReasoningEffort] = useState<ReasoningEffort>("medium");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embedMaxContentLength, setEmbedMaxContentLength] = useState(4000);
  const [whitelistedModels, setWhitelistedModels] = useState<string[]>([]);
  const [newModelInput, setNewModelInput] = useState("");
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [modelCapabilities, setModelCapabilities] = useState<Record<string, ModelCapabilities>>({});
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
      setVllmBaseUrl(settingsData.vllmBaseUrl);
      setDockerBaseUrl(settingsData.dockerBaseUrl);
      setHeartbeatInterval(settingsData.heartbeatIntervalMinutes);
      setContextQueryModel(settingsData.contextQueryModel);
      setContextSummaryModel(settingsData.contextSummaryModel);
      setContextRecentTurns(settingsData.contextRecentTurns);
      setContextReasoningEffort(settingsData.contextReasoningEffort);
      setEmbeddingModel(settingsData.embeddingModel);
      setEmbedMaxContentLength(settingsData.embedMaxContentLength);
      setWhitelistedModels(settingsData.whitelistedModels);
      setAgents(agentsList);
      setModelCapabilities(capabilities);
      initialAgentsRef.current = agentsList;
    });
  }, []);

  const save = async () => {
    setSaving(true);
    const body: Record<string, unknown> = {
      ollamaBaseUrl: ollamaUrl,
      vllmBaseUrl,
      dockerBaseUrl,
      heartbeatIntervalMinutes: heartbeatInterval,
      contextQueryModel,
      contextSummaryModel,
      contextRecentTurns,
      contextReasoningEffort,
      embeddingModel,
      embedMaxContentLength,
      whitelistedModels,
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
                <label htmlFor="settings-vllm-url" className="block text-xs text-zinc-500 mb-1">vLLM Base URL</label>
                <input
                  id="settings-vllm-url"
                  type="text"
                  value={vllmBaseUrl}
                  onChange={(e) => setVllmBaseUrl(e.target.value)}
                  placeholder="http://localhost:8000/v1"
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="vLLM Base URL"
                />
              </div>

              <div>
                <label htmlFor="settings-docker-url" className="block text-xs text-zinc-500 mb-1">Docker Base URL</label>
                <input
                  id="settings-docker-url"
                  type="text"
                  value={dockerBaseUrl}
                  onChange={(e) => setDockerBaseUrl(e.target.value)}
                  placeholder="http://localhost:8000/v1"
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Docker Base URL"
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
                Smart context: extract search queries → retrieve from history &amp; knowledge → filter relevant sources → extract verbatim quotes. Results appear as focused context in the system prompt and as a <code className="bg-zinc-800 px-1 rounded">smart_context</code> tool call in the conversation.
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
                <p className="text-xs text-zinc-500 mt-0.5">Model that generates JSON search queries from user messages (first step). Leave blank to disable smart context.</p>
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
                <label htmlFor="settings-context-recent-turns" className="block text-xs text-zinc-500 mb-1">Recent thread rounds in context</label>
                <input
                  id="settings-context-recent-turns"
                  type="number"
                  min={1}
                  max={50}
                  value={contextRecentTurns}
                  onChange={(e) => setContextRecentTurns(Number(e.target.value))}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Number of recent user rounds to include verbatim in context"
                />
                <p className="text-xs text-zinc-500 mt-0.5">
                  How many recent user rounds to include verbatim. Each round is one user message plus all assistant/tool
                  messages until the next user message. Applied even when smart context is disabled.
                </p>
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
                <input
                  id="settings-embedding-model"
                  type="text"
                  value={embeddingModel}
                  onChange={(e) => setEmbeddingModel(e.target.value)}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Embedding model"
                />
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
