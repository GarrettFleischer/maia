"use client";

/**
 * @fileoverview Settings content: AI providers, whitelist, embedding model, per-agent model.
 * Used by the app shell (SettingsView with hideHeader) and by the standalone settings route (with redirect).
 * @module app/settings/SettingsContent
 */

import { use, useEffect, useId, useMemo, useRef, useState } from "react";
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

/** Pencil icon for edit action. */
function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

/** Trash icon for remove action. */
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

/** Icon indicating the model supports tool/function calling. */
function ToolsSupportedIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** Icon indicating the model does not support tool/function calling. */
function ToolsUnsupportedIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

/** Provider icon: Ollama (Boxicons llama, https://boxicons.com). */
function LlamaIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M7.73 2.01c-.19.03-.41.13-.57.25-.48.36-.85 1.13-1.01 2.1-.06.36-.1.87-.1 1.25 0 .45.05 1.03.13 1.43.02.09.03.17.02.17 0 0-.08.06-.16.13-.27.22-.58.55-.79.85a4.56 4.56 0 0 0-.78 1.95c-.04.28-.05.85-.02 1.13.08.65.27 1.2.61 1.7l.11.16-.03.05c-.22.38-.41.92-.5 1.44-.07.41-.08.52-.08 1.08s0 .67.07 1.06c.08.46.24.95.42 1.28.06.11.2.33.22.34 0 0-.01.06-.04.12a6.3 6.3 0 0 0-.46 1.56c-.05.35-.06.46-.06.83 0 .47.03.69.12 1.07v.05h1.24l-.04-.08c-.25-.46-.27-1.31-.06-2.16.1-.39.21-.68.41-1.08l.12-.24v-.15c0-.14 0-.15-.05-.24a.7.7 0 0 0-.16-.21c-.14-.13-.24-.28-.32-.45-.35-.77-.42-1.91-.17-2.88.1-.4.27-.77.45-.96.12-.13.19-.29.19-.44s-.06-.3-.19-.44c-.37-.4-.6-.88-.68-1.44-.12-.8.09-1.67.57-2.36.47-.68 1.13-1.11 1.87-1.23.17-.03.47-.02.65 0 .19.03.31.02.43-.03.15-.07.22-.16.31-.36.08-.18.14-.28.3-.48.2-.24.38-.41.68-.61.34-.23.74-.39 1.13-.47.14-.03.21-.03.47-.03s.33 0 .47.03c.57.12 1.14.41 1.6.83.1.09.33.38.41.5.03.05.08.15.11.22.09.2.16.29.31.36.12.06.24.07.42.04.29-.05.51-.04.79.01.95.19 1.78.98 2.15 2.03.32.92.23 1.89-.25 2.63-.08.12-.16.23-.28.35-.25.27-.25.6 0 .88.41.45.67 1.56.59 2.53-.05.64-.22 1.22-.44 1.55-.04.06-.12.16-.19.22-.08.08-.13.14-.16.21-.04.09-.05.11-.05.24v.15l.12.24c.21.4.32.69.41 1.08.21.84.19 1.68-.05 2.15l-.04.08h1.22l.02-.06s.02-.08.03-.11c.02-.06.05-.25.07-.43s.02-.85 0-1.05c-.09-.73-.25-1.31-.5-1.86a.4.4 0 0 1-.04-.12s.05-.06.09-.13c.31-.47.51-1.07.6-1.86.03-.22.03-1.15 0-1.36-.07-.54-.15-.9-.29-1.27-.06-.15-.21-.48-.27-.58l-.03-.05.11-.16c.33-.5.53-1.05.61-1.7.03-.28.02-.85-.02-1.13a4.56 4.56 0 0 0-.78-1.95 4.6 4.6 0 0 0-.95-.98s0-.08.02-.17c.17-.91.17-2.04-.01-2.92-.16-.77-.45-1.38-.82-1.73-.3-.28-.6-.4-.96-.38-.83.05-1.5 1-1.76 2.51-.04.24-.08.53-.08.6 0 .03 0 .05-.01.05s-.06-.03-.12-.06c-.64-.38-1.35-.58-2.05-.58s-1.41.2-2.05.58c-.06.04-.12.06-.12.06s-.01-.02-.01-.05c0-.08-.04-.37-.08-.6-.24-1.35-.79-2.25-1.52-2.47-.1-.03-.39-.05-.49-.03Zm.24 1.17c.21.16.44.63.57 1.16.02.09.05.2.06.24 0 .04.02.13.03.19.06.3.08.63.08 1.03v.39l-.1.15-.1.15h-.23c-.27 0-.54.03-.8.1-.09.02-.18.05-.2.05-.03 0-.03 0-.05-.12-.08-.64-.08-1.35.01-1.94.1-.66.34-1.25.58-1.43.06-.04.07-.04.13.01Zm8.19-.01c.14.1.3.38.41.74.23.71.3 1.69.18 2.62-.02.12-.02.13-.05.12-.02 0-.11-.03-.2-.05-.26-.07-.53-.1-.8-.1h-.23l-.1-.15-.1-.15v-.39c0-.56.06-.99.18-1.48.13-.52.36-.99.57-1.15.06-.05.07-.05.13-.01Z" />
      <path d="M11.78 10.39c-.31.03-.4.04-.55.07-.24.05-.57.16-.79.27-.78.38-1.32 1.02-1.49 1.76-.03.15-.04.2-.04.44s0 .3.04.44c.22.97 1.11 1.68 2.26 1.81.25.03 1.33.03 1.58 0 .92-.1 1.72-.61 2.08-1.31.09-.19.14-.31.18-.5.03-.14.04-.19.04-.44s0-.3-.04-.44c-.24-1.07-1.28-1.92-2.56-2.08-.17-.02-.6-.04-.71-.03Zm.54.78c.43.05.86.2 1.2.43.19.12.45.38.56.55.14.21.22.42.25.68.02.12 0 .21-.04.4-.07.29-.28.59-.56.8-.13.1-.41.24-.57.29-.32.1-.53.12-1.27.11-.49 0-.57 0-.71-.03-.48-.09-.85-.28-1.12-.57-.22-.23-.32-.45-.38-.79-.02-.16.02-.42.11-.65.11-.27.41-.61.7-.8.34-.22.78-.38 1.18-.43.16-.02.49-.02.64 0Z" />
      <path d="M11.45 12.22c-.11.06-.19.21-.16.32.03.12.13.24.29.34.09.05.09.06.1.11 0 .03 0 .12-.02.2a1 1 0 0 0-.03.19c0 .06.06.16.12.21.05.04.06.04.21.05.14 0 .17 0 .22-.02.14-.07.18-.2.12-.44-.04-.2-.03-.23.07-.3.11-.07.23-.18.27-.26.07-.15 0-.32-.15-.4a.3.3 0 0 0-.15-.03c-.1 0-.17.02-.3.1l-.07.04-.04-.03c-.18-.11-.22-.12-.33-.12-.08 0-.12 0-.16.03ZM7.96 10.55a.86.86 0 0 0-.54.53c-.05.13-.07.33-.05.43.05.26.26.49.5.56.3.08.53.03.73-.17a.85.85 0 0 0 .24-.37c.05-.11.05-.13.05-.29v-.17l-.06-.12c-.1-.2-.27-.34-.47-.39a.86.86 0 0 0-.39 0ZM15.63 10.55c-.2.05-.37.2-.47.39l-.06.12v.17c0 .16 0 .18.05.29.06.16.13.26.24.37.2.2.43.25.73.17.17-.05.35-.19.43-.36.07-.15.09-.25.07-.41-.05-.38-.27-.65-.6-.75a.86.86 0 0 0-.39 0Z" />
    </svg>
  );
}

/** Provider icon: OpenRouter. */
function RouterIcon({ className }: { className?: string }) {
  const clipId = useId();
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden
    >
      <defs>
        <clipPath id={clipId}>
          <path fill="#fff" d="M0 0h512v512H0z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M358.485 41.75l154.027 87.573v1.856l-155.605 86.634.362-45.162-17.514-.64c-22.592-.598-34.368.042-48.384 2.346-22.699 3.734-43.478 12.31-67.136 28.843l-46.208 32.107c-6.059 4.16-10.56 7.168-14.507 9.706l-10.987 6.87-8.469 4.992 8.213 4.906 11.307 7.211c10.155 6.699 24.96 16.981 57.621 39.808 23.68 16.533 44.438 25.109 67.136 28.843l6.4.96c14.806 1.941 29.334 2.005 60.267.704l.469-46.059 154.027 87.573v1.856l-155.605 86.656.298-39.722-13.546.469c-29.568.896-45.59.043-66.944-3.456-36.139-5.973-69.547-19.755-104.128-43.925l-46.038-32a467.072 467.072 0 00-16.106-10.624l-9.963-5.974c-5.38-3.1-10.785-6.157-16.213-9.173C62.037 314.24 12.01 301.141 0 301.141v-90.197l2.987.085c12.032-.149 62.08-13.269 81.258-23.978l21.675-12.374 9.344-5.845c9.131-5.973 22.869-15.488 57.301-39.531 34.582-24.17 67.968-37.973 104.128-43.925 24.576-4.053 42.112-4.544 81.366-2.944l.426-40.683z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

/** Small icon for "supports reasoning" in model dropdown (lightbulb). */
function ReasoningIcon({
  supported,
  className,
}: {
  supported: boolean;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
      {!supported && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
}

/** Copy icon for copying params from a model row. */
function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

/** Paste icon for pasting params into a model row. */
function PasteIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="m21 15-3.5 3.5a2 2 0 0 1-2.8 0L10 12" />
    </svg>
  );
}

/** Sort order for whitelisted models: group by provider then by name (ollama, openrouter only). */
const MODEL_PROVIDER_SORT_ORDER: Record<string, number> = {
  ollama: 0,
  openrouter: 1,
};

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
  const [contextQueryModel, setContextQueryModel] = useState("");
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
  /** Raw text for "Add model" when using custom/other; also used by tests that type full id. */
  const [newModelInput, setNewModelInput] = useState("");
  /** Provider for add-model: Ollama (list from server) or OpenRouter (curated list). */
  const [addModelProvider, setAddModelProvider] = useState<
    "ollama" | "openrouter"
  >("ollama");
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");
  /** Copied model params for paste-between-models; null when nothing copied. */
  const [copiedModelParams, setCopiedModelParams] =
    useState<ModelGenerationParams | null>(null);
  /** Model id that was copied (for tooltip / aria). */
  const [copiedFromModelId, setCopiedFromModelId] = useState<string | null>(
    null,
  );
  const [modelCapabilities, setModelCapabilities] = useState<
    Record<string, ModelCapabilities>
  >({});
  /** Set of model ids that are downloaded on Ollama (only ollama/* ids). */
  const [downloadedOllamaModels, setDownloadedOllamaModels] = useState<
    Set<string>
  >(new Set());
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
  /** Agent id whose model dropdown is open; null when none. */
  const [openModelDropdownAgentId, setOpenModelDropdownAgentId] = useState<
    string | null
  >(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  /** Which provider dropdown is open on Models tab: "add" or model entry id or null. */
  const [openProviderDropdown, setOpenProviderDropdown] = useState<
    "add" | string | null
  >(null);
  const providerDropdownRef = useRef<HTMLDivElement | null>(null);

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
      setContextQueryModel(settingsData.contextQueryModel);
      setContextReasoningEffort(settingsData.contextReasoningEffort);
      setEmbeddingModel(settingsData.embeddingModel);
      setEmbedMaxContentLength(settingsData.embedMaxContentLength);
      setArchiveDurationValue(settingsData.archiveDurationValue);
      setArchiveDurationUnit(settingsData.archiveDurationUnit);
      setModelEntries(
        (settingsData.whitelistedModels ?? []).map((id) => {
          const normalizedId = id.startsWith("ollama/")
            ? id
            : id.startsWith("openrouter/")
              ? id
              : `ollama/${id.includes("/") ? id.slice(id.indexOf("/") + 1) : id}`;
          return {
            id: normalizedId,
            params: (settingsData.modelParams ?? {})[id] ?? {},
          };
        }),
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

  /** Close model dropdown when clicking outside. */
  useEffect(() => {
    if (openModelDropdownAgentId === null) return;
    const onMouseDown = (e: MouseEvent) => {
      const el = modelDropdownRef.current;
      if (el && !el.contains(e.target as Node))
        setOpenModelDropdownAgentId(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openModelDropdownAgentId]);

  /** Close provider dropdown (Models tab) when clicking outside. */
  useEffect(() => {
    if (openProviderDropdown === null) return;
    const onMouseDown = (e: MouseEvent) => {
      const el = providerDropdownRef.current;
      if (el && !el.contains(e.target as Node)) setOpenProviderDropdown(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openProviderDropdown]);

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
      contextQueryModel,
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

    const capRes = await fetch("/api/model-capabilities");
    const capData = (await capRes.json()) as {
      modelCapabilities: Record<string, ModelCapabilities>;
    };
    setModelCapabilities(capData.modelCapabilities ?? {});

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
    if (!trimmed) return;
    const id =
      addModelProvider === "openrouter"
        ? `openrouter/${trimmed}`
        : `ollama/${trimmed}`;
    if (whitelistedModels.includes(id)) return;
    setModelEntries((prev) => [...prev, { id, params: {} }]);
    setNewModelInput("");
  };

  /** Provider segment of a model id for display and sort; unknown defaults to ollama. */
  const getProviderFromId = (id: string): string =>
    id.startsWith("ollama/")
      ? "ollama"
      : id.startsWith("openrouter/")
        ? "openrouter"
        : "ollama";

  /** Model name (everything after first slash) for display and sort. */
  const getModelNameFromId = (id: string): string =>
    id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;

  /** Preview text: last segment only (after last slash) so long paths show the important part. */
  const getModelPreviewName = (id: string): string => {
    const name = getModelNameFromId(id);
    return name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  };

  const removeWhitelistModel = (index: number) => {
    setModelEntries((prev) => prev.filter((_, i) => i !== index));
    if (editingModelIndex === index) {
      setEditingModelIndex(null);
      setEditValue("");
    } else if (editingModelIndex != null && editingModelIndex > index) {
      setEditingModelIndex(editingModelIndex - 1);
    }
  };

  const startEditWhitelistModel = (index: number) => {
    setEditingModelIndex(index);
    setEditValue(getModelNameFromId(modelEntries[index]!.id));
  };

  const cancelEditWhitelistModel = () => {
    setEditingModelIndex(null);
    setEditValue("");
  };

  const saveEditWhitelistModel = () => {
    if (editingModelIndex == null) return;
    const trimmed = editValue.trim();
    if (!trimmed) return;
    const currentId = modelEntries[editingModelIndex]!.id;
    const provider = getProviderFromId(currentId);
    const newId = `${provider}/${trimmed}`;
    const isDuplicate = modelEntries.some(
      (e, i) => i !== editingModelIndex && e.id === newId,
    );
    if (isDuplicate) return;
    setModelEntries((prev) =>
      prev.map((e, i) => (i === editingModelIndex ? { ...e, id: newId } : e)),
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
   * Copies the ollama pull command for the given model to the clipboard.
   * @param modelId - Full model id (e.g. "ollama/llama3.2"); prefix is stripped for the command.
   */
  const copyOllamaPullCommand = async (modelId: string) => {
    const name = modelId.startsWith("ollama/") ? modelId.slice(7) : modelId;
    const command = `ollama pull ${name}`;
    await navigator.clipboard.writeText(command);
  };

  /** Copy a model row's params into in-memory clipboard for pasting to another row. */
  const copyModelParams = (index: number) => {
    const entry = modelEntries[index];
    if (!entry) return;
    setCopiedModelParams(
      JSON.parse(JSON.stringify(entry.params)) as ModelGenerationParams,
    );
    setCopiedFromModelId(entry.id);
  };

  /** Paste previously copied params onto the model row at the given index. */
  const pasteModelParams = (index: number) => {
    if (!copiedModelParams) return;
    setModelEntries((prev) =>
      prev.map((e, i) =>
        i === index
          ? {
              ...e,
              params: JSON.parse(
                JSON.stringify(copiedModelParams),
              ) as ModelGenerationParams,
            }
          : e,
      ),
    );
  };

  /** Sorted by provider (ollama, openrouter) then model name (case-insensitive). */
  const sortedModelEntries = useMemo(
    () =>
      [...modelEntries].sort((a, b) => {
        const providerA = getProviderFromId(a.id);
        const providerB = getProviderFromId(b.id);
        const orderA = MODEL_PROVIDER_SORT_ORDER[providerA] ?? 3;
        const orderB = MODEL_PROVIDER_SORT_ORDER[providerB] ?? 3;
        if (orderA !== orderB) return orderA - orderB;
        const nameA = getModelNameFromId(a.id).toLowerCase();
        const nameB = getModelNameFromId(b.id).toLowerCase();
        return nameA.localeCompare(nameB);
      }),
    [modelEntries],
  );

  /**
   * Set the provider prefix for the model at the given index.
   * Persists as provider/name in modelEntries; Save sends these ids to the DB (whitelistedModels, modelParams).
   */
  const setEntryProvider = (index: number, provider: string) => {
    const allowed = ["ollama", "openrouter"] as const;
    if (!allowed.includes(provider as (typeof allowed)[number])) return;
    setModelEntries((prev) => {
      const entry = prev[index];
      if (!entry) return prev;
      const name = getModelNameFromId(entry.id);
      const newId = `${provider}/${name}`;
      if (newId === entry.id) return prev;
      return prev.map((e, i) => (i === index ? { ...e, id: newId } : e));
    });
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

  /** Display label: "Provider" + actual model name (last segment only) so the name is readable. */
  const formatModelLabel = (modelId: string): string => {
    const provider = getProviderFromId(modelId);
    const name = getModelPreviewName(modelId);
    const providerLabel =
      provider === "ollama"
        ? "Ollama"
        : provider === "openrouter"
          ? "OpenRouter"
          : provider;
    return `${providerLabel} ${name}`.trim();
  };

  /** Sorts model ids: installed (Ollama downloaded) first, then by provider (Ollama, OpenRouter), then by model name. */
  const sortModelOptionsForAgent = (options: string[]): string[] =>
    [...options].sort((a, b) => {
      const isInstalledA = a.startsWith("ollama/")
        ? downloadedOllamaModels.has(a)
        : true;
      const isInstalledB = b.startsWith("ollama/")
        ? downloadedOllamaModels.has(b)
        : true;
      if (isInstalledA !== isInstalledB) return isInstalledA ? -1 : 1;
      const orderA = MODEL_PROVIDER_SORT_ORDER[getProviderFromId(a)] ?? 2;
      const orderB = MODEL_PROVIDER_SORT_ORDER[getProviderFromId(b)] ?? 2;
      if (orderA !== orderB) return orderA - orderB;
      return getModelNameFromId(a).localeCompare(
        getModelNameFromId(b),
        undefined,
        { sensitivity: "base" },
      );
    });

  const getModelOptionLabel = (modelId: string): string => {
    const capabilities = modelCapabilities[modelId];
    const isOllama =
      capabilities?.provider === "ollama" || modelId.startsWith("ollama/");
    const isAvailable = !isOllama || downloadedOllamaModels.has(modelId);
    return `${isAvailable ? "✓ " : ""}${formatModelLabel(modelId)}`;
  };

  const wrapperClass = props.hideHeader
    ? "h-full min-h-0 flex flex-col bg-zinc-950 text-zinc-100"
    : "min-h-screen bg-zinc-950 text-zinc-100";

  const tabList = settings && (
    <div
      role="tablist"
      aria-label="Settings sections"
      className="flex flex-wrap gap-1"
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
  );

  /** Tabs and Save button in one row so Save is always visible. */
  const tabsAndSave = settings && (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
      {tabList}
      <button
        onClick={save}
        disabled={saving}
        className="shrink-0 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-sm font-medium transition-colors"
      >
        {saved ? "Saved ✓" : saving ? "Saving..." : "Save Settings"}
      </button>
    </div>
  );

  /** Tab panels only; shared by app-shell (scroll area) and standalone main. */
  const settingsPanels = settings && (
    <>
      <div
        id="settings-tab-providers"
        role="tabpanel"
        aria-labelledby="tab-providers"
        hidden={activeTab !== "providers"}
        className="space-y-6"
      >
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <h2 className="font-medium text-sm text-zinc-300">AI Providers</h2>

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
          <h2 className="font-medium text-sm text-zinc-300">Agent System</h2>

          <p className="text-xs text-zinc-500">
            When an agent calls the{" "}
            <code className="bg-zinc-800 px-1 rounded">smart_context</code>{" "}
            tool, the query model is used to extract search queries, retrieve
            from history and data files, and filter relevant sources. Leave
            blank if you do not want agents to use that tool.
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
              Model used when an agent calls the smart_context tool. Leave blank
              to disable.
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
                setContextReasoningEffort(e.target.value as ReasoningEffort)
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
              Model for indexing files under the data folder and for history
              semantic search (chat_find, knowledge_search). Must be in
              whitelist.
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
              onChange={(e) => setEmbedMaxContentLength(Number(e.target.value))}
              className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
              aria-label="Max characters per embed chunk"
            />
            <p className="text-xs text-zinc-500 mt-0.5">
              Truncation limit to avoid Ollama context-length errors. 4000 is
              safe for 2048-token default.
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
                  {(buildResult ?? rebuildResult)!.knowledgeIndexed} data files,{" "}
                  {(buildResult ?? rebuildResult)!.historyIndexed} history
                  vectors.
                </p>
              )}
            {rebuildError && !buildingEmbeddings && !rebuildingEmbeddings && (
              <p className="text-xs text-red-400">{rebuildError}</p>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            Build: index new/changed data files and history. Clear & Rebuild:
            delete all and re-index from scratch (use after changing embedding
            model).
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
                  setArchiveDurationValue(Math.max(0, Number(e.target.value)))
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
            considered archived and excluded from knowledge_search by default.
            Agents can pass include_archived: true to include them. Results
            always include last_modified per file. Set to 0 to disable
            archiving.
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
            Model id and optional generation params (e.g. temperature, top_p)
            are stored together so renaming a model keeps its params. For Ollama
            models: reasoning + tools icons show capabilities (all models); for
            Ollama not downloaded, copy icon to get pull command.
          </p>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div
              className="relative shrink-0"
              ref={
                openProviderDropdown === "add" ? providerDropdownRef : undefined
              }
            >
              <button
                type="button"
                onClick={() =>
                  setOpenProviderDropdown((p) => (p === "add" ? null : "add"))
                }
                className="flex items-center justify-center rounded-lg bg-zinc-800 p-2 focus:outline-none focus:ring-2 focus:ring-violet-600"
                aria-label={`Model provider: ${addModelProvider === "ollama" ? "Ollama" : "OpenRouter"}`}
                aria-expanded={openProviderDropdown === "add"}
                aria-haspopup="listbox"
              >
                {addModelProvider === "ollama" ? (
                  <LlamaIcon className="text-zinc-400" />
                ) : (
                  <RouterIcon className="text-zinc-400" />
                )}
              </button>
              {openProviderDropdown === "add" && (
                <ul
                  role="listbox"
                  aria-label="Model provider"
                  className="absolute left-0 top-full z-10 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-lg"
                >
                  <li
                    role="option"
                    title="Ollama"
                    aria-selected={addModelProvider === "ollama"}
                    onClick={() => {
                      setAddModelProvider("ollama");
                      setNewModelInput("");
                      setOpenProviderDropdown(null);
                    }}
                    className="flex cursor-pointer items-center justify-center px-3 py-2 hover:bg-zinc-700 aria-selected:bg-zinc-700"
                  >
                    <LlamaIcon className="text-zinc-400" />
                  </li>
                  <li
                    role="option"
                    title="OpenRouter"
                    aria-selected={addModelProvider === "openrouter"}
                    onClick={() => {
                      setAddModelProvider("openrouter");
                      setNewModelInput("");
                      setOpenProviderDropdown(null);
                    }}
                    className="flex cursor-pointer items-center justify-center px-3 py-2 hover:bg-zinc-700 aria-selected:bg-zinc-700"
                  >
                    <RouterIcon className="text-zinc-400" />
                  </li>
                </ul>
              )}
            </div>
            <input
              type="text"
              value={newModelInput}
              onChange={(e) => setNewModelInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addWhitelistModel()}
              placeholder={
                addModelProvider === "ollama"
                  ? "Model name (e.g. llama3.2)"
                  : "Model (e.g. anthropic/claude-3.5-haiku)"
              }
              className="flex-1 min-w-[180px] bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
              aria-label="Model name or id"
            />
            <button
              type="button"
              onClick={addWhitelistModel}
              className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-sm shrink-0"
            >
              Add
            </button>
          </div>
          <div className="space-y-2">
            {sortedModelEntries.map((entry) => {
              const realIndex = modelEntries.findIndex(
                (e) => e.id === entry.id,
              );
              const isEditing = editingModelIndex === realIndex;
              const params = entry.params;
              const cap = modelCapabilities[entry.id];
              const reasoningKnown = cap?.supportsReasoning !== undefined;
              const toolsKnown = cap?.supportsTools !== undefined;
              const capabilityTooltip =
                reasoningKnown || toolsKnown
                  ? [
                      reasoningKnown
                        ? `Reasoning: ${cap?.supportsReasoning ? "Supported" : "Not supported"}`
                        : null,
                      toolsKnown
                        ? `Tools: ${cap?.supportsTools ? "Supported" : "Not supported"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(". ")
                  : "Capabilities unknown";
              const optionsRecord = (params.options ?? {}) as Record<
                string,
                unknown
              >;
              const numCtxValue =
                typeof optionsRecord["num_ctx"] === "number"
                  ? (optionsRecord["num_ctx"] as number)
                  : undefined;
              const numCtxId = `settings-model-${realIndex}-num-ctx`;
              return (
                <div
                  key={entry.id}
                  className="border border-zinc-800 rounded-lg overflow-hidden"
                >
                  <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50">
                    <div
                      className="relative shrink-0"
                      ref={
                        openProviderDropdown === entry.id
                          ? providerDropdownRef
                          : undefined
                      }
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setOpenProviderDropdown((p) =>
                            p === entry.id ? null : entry.id,
                          )
                        }
                        className="flex items-center justify-center rounded-lg bg-zinc-800 p-1.5 focus:outline-none focus:ring-2 focus:ring-violet-600"
                        aria-label={`Provider for ${entry.id}: ${getProviderFromId(entry.id) === "ollama" ? "Ollama" : "OpenRouter"}`}
                        aria-expanded={openProviderDropdown === entry.id}
                        aria-haspopup="listbox"
                      >
                        {entry.id.startsWith("ollama/") ? (
                          <LlamaIcon className="text-zinc-400" />
                        ) : (
                          <RouterIcon className="text-zinc-400" />
                        )}
                      </button>
                      {openProviderDropdown === entry.id && (
                        <ul
                          role="listbox"
                          aria-label={`Provider for ${entry.id}`}
                          className="absolute left-0 top-full z-10 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-lg"
                        >
                          <li
                            role="option"
                            title="Ollama"
                            aria-selected={
                              getProviderFromId(entry.id) === "ollama"
                            }
                            onClick={() => {
                              setEntryProvider(realIndex, "ollama");
                              setOpenProviderDropdown(null);
                            }}
                            className="flex cursor-pointer items-center justify-center px-2 py-1.5 hover:bg-zinc-700 aria-selected:bg-zinc-700"
                          >
                            <LlamaIcon
                              className="text-zinc-400"
                            />
                          </li>
                          <li
                            role="option"
                            title="OpenRouter"
                            aria-selected={
                              getProviderFromId(entry.id) === "openrouter"
                            }
                            onClick={() => {
                              setEntryProvider(realIndex, "openrouter");
                              setOpenProviderDropdown(null);
                            }}
                            className="flex cursor-pointer items-center justify-center px-2 py-1.5 hover:bg-zinc-700 aria-selected:bg-zinc-700"
                          >
                            <RouterIcon
                              className="text-zinc-400"
                            />
                          </li>
                        </ul>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveEditWhitelistModel();
                              if (e.key === "Escape")
                                cancelEditWhitelistModel();
                            }}
                            className="flex-1 min-w-0 bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                            aria-label="Edit model name"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={saveEditWhitelistModel}
                            className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded shrink-0"
                            aria-label="Save edit"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditWhitelistModel}
                            className="text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded shrink-0"
                            aria-label="Cancel edit"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => copyModelParams(realIndex)}
                            className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded shrink-0"
                            aria-label={`Copy params from ${entry.id}`}
                            title="Copy params to paste on another model"
                          >
                            <CopyIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => pasteModelParams(realIndex)}
                            disabled={!copiedModelParams}
                            className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                            aria-label={
                              copiedModelParams
                                ? `Paste params from ${copiedFromModelId ?? "model"}`
                                : "Paste params (copy a model first)"
                            }
                            title={
                              copiedModelParams
                                ? `Paste params from ${copiedFromModelId ?? "model"}`
                                : "Copy a model's params first"
                            }
                          >
                            <PasteIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeWhitelistModel(realIndex)}
                            className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded shrink-0"
                            aria-label={`Remove ${entry.id}`}
                          >
                            <TrashIcon />
                          </button>
                        </>
                      ) : (
                        <>
                          <span
                            className="text-xs font-mono text-zinc-400 bg-zinc-800 rounded px-2 py-1 flex-1 min-w-0 truncate"
                            title={getModelNameFromId(entry.id)}
                          >
                            {getModelPreviewName(entry.id)}
                          </span>
                          <button
                            type="button"
                            onClick={() => startEditWhitelistModel(realIndex)}
                            className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded shrink-0"
                            aria-label={`Edit ${entry.id}`}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => copyModelParams(realIndex)}
                            className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded shrink-0"
                            aria-label={`Copy params from ${entry.id}`}
                            title="Copy params to paste on another model"
                          >
                            <CopyIcon />
                          </button>
                          <button
                            type="button"
                            onClick={() => pasteModelParams(realIndex)}
                            disabled={!copiedModelParams}
                            className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                            aria-label={
                              copiedModelParams
                                ? `Paste params from ${copiedFromModelId ?? "model"}`
                                : "Paste params (copy a model first)"
                            }
                            title={
                              copiedModelParams
                                ? `Paste params from ${copiedFromModelId ?? "model"}`
                                : "Copy a model's params first"
                            }
                          >
                            <PasteIcon />
                          </button>
                        </>
                      )}
                    </div>
                    <div className="shrink-0 ml-auto flex items-center justify-center gap-1">
                      {(reasoningKnown || toolsKnown) && (
                        <span
                          className="flex flex-col items-center gap-0.5"
                          title={capabilityTooltip}
                          aria-label={`${entry.id}: ${capabilityTooltip}`}
                        >
                          {reasoningKnown && (
                            <ReasoningIcon
                              supported={cap?.supportsReasoning !== false}
                              className={
                                cap?.supportsReasoning !== false
                                  ? "text-emerald-500/90"
                                  : "text-zinc-500"
                              }
                            />
                          )}
                          {toolsKnown &&
                            (cap?.supportsTools !== false ? (
                              <ToolsSupportedIcon className="text-emerald-500/90" />
                            ) : (
                              <ToolsUnsupportedIcon className="text-zinc-500" />
                            ))}
                        </span>
                      )}
                      {entry.id.startsWith("ollama/") &&
                        !downloadedOllamaModels.has(entry.id) && (
                          <button
                            type="button"
                            onClick={() => copyOllamaPullCommand(entry.id)}
                            className="text-amber-500 hover:text-amber-400 inline-flex items-center"
                            aria-label={`Copy ollama pull command for ${entry.id}. ${capabilityTooltip}`}
                            title={`Copy command: ollama pull … ${capabilityTooltip}`}
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
                              <rect
                                width="14"
                                height="14"
                                x="8"
                                y="8"
                                rx="2"
                                ry="2"
                              />
                              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                          </button>
                        )}
                    </div>
                  </div>
                  {isEditing && (
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
                              updateModelParam(realIndex, {
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
                              updateModelParam(realIndex, {
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
                              updateModelParam(realIndex, {
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
                              updateModelParam(realIndex, {
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
                              updateModelParam(realIndex, {
                                presence_penalty: parseNum(e.target.value),
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
                              updateModelParam(realIndex, {
                                repetition_penalty: parseNum(e.target.value),
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
                            numCtxValue === undefined ? "" : String(numCtxValue)
                          }
                          onChange={(e) => {
                            const raw = e.target.value;
                            const trimmed = raw.trim();
                            const n =
                              trimmed === "" ? undefined : Number(trimmed);
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
                              updateModelParam(realIndex, {
                                options: undefined,
                              });
                            } else {
                              updateModelParam(realIndex, {
                                options: nextOptions,
                              });
                            }
                          }}
                          placeholder="e.g. 16384"
                          className="w-full bg-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                          aria-label="Context window (num_ctx, tokens)"
                        />
                        <p className="text-xs text-zinc-500 mt-0.5">
                          Per-model context window in tokens. For Ollama, this
                          sets options.num_ctx.
                        </p>
                      </div>
                      <div></div>
                    </div>
                  )}
                </div>
              );
            })}
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
              Reasoning effort is applied via the correct API for each model
              (Ollama think / OpenRouter reasoning.effort).
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
              const installedOrCurrent = modelOptions.filter((id) => {
                if (!id.startsWith("ollama/")) return true;
                if (id === agent.model) return true;
                return downloadedOllamaModels.has(id);
              });
              const sortedModelOptions =
                sortModelOptionsForAgent(installedOrCurrent);
              const effortOptions = ["off", "low", "medium", "high"] as const;
              const capabilities = modelCapabilities[agent.model];
              const reasoningKnown =
                capabilities?.supportsReasoning !== undefined;
              const toolsKnown = capabilities?.supportsTools !== undefined;
              const reasoningDisabled =
                !reasoningKnown || capabilities?.supportsReasoning === false;
              const supportsTools = capabilities?.supportsTools === true;
              const isDropdownOpen = openModelDropdownAgentId === agent.id;
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
                  <div
                    className="relative flex flex-1 min-w-0 items-center gap-2"
                    ref={isDropdownOpen ? modelDropdownRef : undefined}
                  >
                    <button
                      type="button"
                      id={`agent-model-${agent.id}`}
                      role="combobox"
                      disabled={saving}
                      onClick={() =>
                        setOpenModelDropdownAgentId((prev) =>
                          prev === agent.id ? null : agent.id,
                        )
                      }
                      className="flex flex-1 min-w-0 items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-left text-sm focus:outline-none focus:ring-2 focus:ring-violet-600 disabled:opacity-60"
                      aria-label={`Model for ${label}`}
                      aria-expanded={isDropdownOpen}
                      aria-haspopup="listbox"
                    >
                      <span
                        className="min-w-0 flex-1 truncate flex items-center gap-1.5"
                        aria-label={formatModelLabel(agent.model)}
                      >
                        {agent.model.startsWith("ollama/") ? (
                          <LlamaIcon className="shrink-0 text-zinc-400" />
                        ) : (
                          <RouterIcon className="shrink-0 text-zinc-400" />
                        )}
                        <span className="min-w-0 truncate">
                          {getModelPreviewName(agent.model)}
                        </span>
                      </span>
                      {reasoningKnown && (
                        <ReasoningIcon
                          supported={!reasoningDisabled}
                          className={
                            reasoningDisabled
                              ? "shrink-0 text-zinc-500"
                              : "shrink-0 text-emerald-500/90"
                          }
                        />
                      )}
                      {toolsKnown &&
                        (supportsTools ? (
                          <ToolsSupportedIcon className="shrink-0 text-emerald-500/90" />
                        ) : (
                          <ToolsUnsupportedIcon className="shrink-0 text-zinc-500" />
                        ))}
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`shrink-0 text-zinc-400 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
                        aria-hidden
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                    {isDropdownOpen && (
                      <ul
                        role="listbox"
                        aria-label={`Model options for ${label}`}
                        className="absolute left-0 top-full z-10 mt-1 max-h-60 w-full min-w-48 overflow-auto rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-lg"
                      >
                        {sortedModelOptions.map((m) => {
                          const cap = modelCapabilities[m];
                          const reasoningKnown =
                            cap?.supportsReasoning !== undefined;
                          const toolsKnown = cap?.supportsTools !== undefined;
                          const suppReasoning =
                            cap?.supportsReasoning !== false;
                          const suppTools = cap?.supportsTools !== false;
                          const isSelected = m === agent.model;
                          return (
                            <li
                              key={m}
                              role="option"
                              aria-selected={isSelected}
                              aria-label={formatModelLabel(m)}
                              onClick={() => {
                                setAgentModel(agent.id, m);
                                setOpenModelDropdownAgentId(null);
                              }}
                              className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 aria-selected:bg-zinc-700"
                            >
                              {reasoningKnown && (
                                <ReasoningIcon
                                  supported={suppReasoning}
                                  className={
                                    suppReasoning
                                      ? "shrink-0 text-emerald-500/90"
                                      : "shrink-0 text-zinc-500"
                                  }
                                />
                              )}
                              {toolsKnown &&
                                (suppTools ? (
                                  <ToolsSupportedIcon className="shrink-0 text-emerald-500/90" />
                                ) : (
                                  <ToolsUnsupportedIcon className="shrink-0 text-zinc-500" />
                                ))}
                              <span
                                className="min-w-0 truncate flex items-center gap-1.5"
                                aria-label={formatModelLabel(m)}
                              >
                                {m.startsWith("ollama/") ? (
                                  <LlamaIcon className="shrink-0 text-zinc-400" />
                                ) : (
                                  <RouterIcon className="shrink-0 text-zinc-400" />
                                )}
                                <span className="min-w-0 truncate">
                                  {getModelPreviewName(m)}
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  <select
                    id={`agent-reasoning-${agent.id}`}
                    value={reasoningDisabled ? "off" : agent.reasoningEffort}
                    onChange={(e) =>
                      setAgentReasoningEffort(
                        agent.id,
                        e.target.value as AgentDefinition["reasoningEffort"],
                      )
                    }
                    disabled={saving || reasoningDisabled}
                    className="w-28 shrink-0 bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600 disabled:opacity-60 disabled:cursor-not-allowed"
                    aria-label={`Reasoning effort for ${label}`}
                    title={
                      reasoningDisabled
                        ? "Model does not support reasoning"
                        : undefined
                    }
                  >
                    {reasoningDisabled ? (
                      <option value="off">N/A</option>
                    ) : (
                      effortOptions.map((eff) => (
                        <option key={eff} value={eff}>
                          {eff === "off"
                            ? "Off"
                            : eff.charAt(0).toUpperCase() + eff.slice(1)}
                        </option>
                      ))
                    )}
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
            Skills are markdown files with a name and description. They are
            matched to the user message by semantic similarity and their
            instructions are injected into the system prompt when relevant.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <label htmlFor="skills-scope" className="text-xs text-zinc-500">
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
                  onChange={(e) => setSkillFormDescription(e.target.value)}
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
    </>
  );

  return (
    <div className={wrapperClass}>
      {!props.hideHeader && (
        <AppHeader activeView="settings" subtitle="Settings" />
      )}

      {props.hideHeader ? (
        <>
          <div className="shrink-0 border-b border-zinc-800 bg-zinc-950">
            <div className="max-w-2xl mx-auto px-4 pt-6 pb-3">
              <h1 className="text-xl font-semibold">Settings</h1>
              {!settings && <p className="text-zinc-500 text-sm">Loading...</p>}
              {tabsAndSave}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <main
              className="max-w-2xl mx-auto px-4 py-6 space-y-6"
              role="main"
              aria-label="Settings content"
            >
              {settingsPanels}
            </main>
          </div>
        </>
      ) : (
        <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
          <h1 className="text-xl font-semibold">Settings</h1>
          {!settings && <p className="text-zinc-500 text-sm">Loading...</p>}
          {tabsAndSave}
          {settingsPanels}
        </main>
      )}
    </div>
  );
}
