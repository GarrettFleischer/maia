"use client";

/**
 * @fileoverview Cron schedules: create friendly wakes (timing + Maia or persona + wake-up/custom),
 * list jobs, edit, delete. Rendered inside the app shell.
 * @module app/views/CronView
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { CronJob } from "@/lib/types";
import { describeCronSchedule } from "@/lib/cron/describe";
import { DEFAULT_CRON_WAKE_PROMPT } from "@/lib/cron/default-wake-prompt";
import {
  matchExpressionToPresetId,
  SCHEDULE_PRESETS,
} from "@/lib/cron/schedule-presets";

type PersonaOption = {
  id: string;
  name: string;
  description: string;
  suggestedModelHint?: string;
};

type AgentOption = { id: string; name: string };

function formatNextRun(iso: string): string {
  const d = new Date(iso);
  const diffMs = d.getTime() - Date.now();
  const diffMins = Math.round(diffMs / 60_000);
  if (diffMins < 0) return "next occurrence";
  if (diffMins < 60) return `in ${diffMins} min`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `in ${diffHrs}h`;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeCronBody(body: string): string {
  return body.trim().replace(/\r\n/g, "\n");
}

function isDefaultWakeCronMessage(m: string | null | undefined): boolean {
  if (m == null || String(m).trim() === "") return true;
  return (
    normalizeCronBody(String(m)) ===
    normalizeCronBody(DEFAULT_CRON_WAKE_PROMPT)
  );
}

function wakeSummary(job: CronJob): string {
  if (job.personaId?.trim()) {
    return isDefaultWakeCronMessage(job.cronMessage)
      ? `Persona · ${job.personaId} · default wake`
      : `Persona · ${job.personaId} · custom`;
  }
  return isDefaultWakeCronMessage(job.cronMessage)
    ? "Maia · default wake"
    : "Maia · custom wake";
}

/**
 * @brief Cron schedules UI (no shell header).
 */
export default function CronView() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newTitle, setNewTitle] = useState("");
  const [scheduleTab, setScheduleTab] = useState<"quick" | "custom">("quick");
  const [presetId, setPresetId] = useState(SCHEDULE_PRESETS[0].id);
  const [customCron, setCustomCron] = useState("0 9 * * *");
  const [wakeKind, setWakeKind] = useState<"wake_up" | "custom">("wake_up");
  const [delegateTo, setDelegateTo] = useState<"maia" | "persona">("maia");
  const [createPersonaId, setCreatePersonaId] = useState("");
  const [createPersonaModel, setCreatePersonaModel] = useState("");
  const [createCustomBody, setCreateCustomBody] = useState("");
  const [boardTaskTitle, setBoardTaskTitle] = useState("");
  const [boardTaskAssign, setBoardTaskAssign] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editScheduleTab, setEditScheduleTab] = useState<"quick" | "custom">("quick");
  const [editPresetId, setEditPresetId] = useState(SCHEDULE_PRESETS[0].id);
  const [editCustomCron, setEditCustomCron] = useState("0 9 * * *");
  const [editWakeKind, setEditWakeKind] = useState<"wake_up" | "custom">("wake_up");
  const [editDelegateTo, setEditDelegateTo] = useState<"maia" | "persona">("maia");
  const [editPersonaId, setEditPersonaId] = useState("");
  const [editPersonaModel, setEditPersonaModel] = useState("");
  const [editCustomBody, setEditCustomBody] = useState("");
  const [editTaskDescription, setEditTaskDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<{
    jobId: string;
    message: string;
  } | null>(null);

  const resolvedExpression = useMemo(() => {
    if (scheduleTab === "custom") return customCron.trim();
    const p = SCHEDULE_PRESETS.find((x) => x.id === presetId);
    return p?.expression ?? "0 9 * * *";
  }, [scheduleTab, presetId, customCron]);

  const createScheduleHint = useMemo(
    () => describeCronSchedule(resolvedExpression),
    [resolvedExpression],
  );

  const editResolvedSchedule = useMemo(() => {
    if (editScheduleTab === "quick") {
      const p = SCHEDULE_PRESETS.find((x) => x.id === editPresetId);
      return p?.expression ?? "0 9 * * *";
    }
    return editCustomCron.trim();
  }, [editScheduleTab, editPresetId, editCustomCron]);

  const editScheduleHint = useMemo(
    () => describeCronSchedule(editResolvedSchedule),
    [editResolvedSchedule],
  );

  const loadAll = useCallback(async () => {
    try {
      const [jr, pr, ar, sr] = await Promise.all([
        fetch("/api/cron/jobs"),
        fetch("/api/personas"),
        fetch("/api/agents"),
        fetch("/api/settings"),
      ]);
      if (!jr.ok) throw new Error(`Jobs ${jr.status}`);
      const jdata = (await jr.json()) as { jobs: CronJob[] };
      setJobs(jdata.jobs);
      if (pr.ok) {
        const pdata = (await pr.json()) as { personas: PersonaOption[] };
        setPersonas(pdata.personas ?? []);
      }
      if (ar.ok) {
        const adata = (await ar.json()) as { agents: AgentOption[] };
        setAgents(adata.agents ?? []);
      }
      if (sr.ok) {
        const sdata = (await sr.json()) as { whitelistedModels: string[] };
        setModels(sdata.whitelistedModels ?? []);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (personas.length && !createPersonaId) {
      setCreatePersonaId(personas[0].id);
    }
  }, [personas, createPersonaId]);

  useEffect(() => {
    if (models.length && !createPersonaModel) {
      setCreatePersonaModel(models[0]);
    }
  }, [models, createPersonaModel]);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) {
      setCreateError("Give this schedule a short name.");
      return;
    }
    if (scheduleTab === "custom" && !resolvedExpression.trim()) {
      setCreateError(
        "Enter a valid 5-field cron expression (or switch to Quick picks).",
      );
      return;
    }
    if (delegateTo === "persona" && !createPersonaId.trim()) {
      setCreateError("Pick a persona for this wake.");
      return;
    }
    if (delegateTo === "persona" && !createPersonaModel.trim()) {
      setCreateError("Pick a model for the persona.");
      return;
    }
    if (wakeKind === "custom" && !createCustomBody.trim()) {
      setCreateError("Enter custom wake instructions, or switch to Wake up.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const body: Record<string, unknown> = {
        expression: resolvedExpression,
        taskDescription: title,
        wakeType: wakeKind,
        delegateTo,
        personaId: delegateTo === "persona" ? createPersonaId.trim() : undefined,
        personaModel:
          delegateTo === "persona" ? createPersonaModel.trim() : undefined,
        customMessage: wakeKind === "custom" ? createCustomBody.trim() : undefined,
      };
      const bt = boardTaskTitle.trim();
      if (bt) {
        body.boardTask = {
          title: bt,
          assignedTo: boardTaskAssign.trim() || null,
        };
      }
      const res = await fetch("/api/cron/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setCreateError(data.error ?? `Could not create (${res.status})`);
        return;
      }
      setNewTitle("");
      setBoardTaskTitle("");
      setCreateCustomBody("");
      await loadAll();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (job: CronJob) => {
    setDeleteNotice(null);
    setEditingId(job.id);
    const matchedPreset = matchExpressionToPresetId(job.expression);
    setEditScheduleTab(matchedPreset ? "quick" : "custom");
    setEditPresetId(matchedPreset ?? SCHEDULE_PRESETS[0].id);
    setEditCustomCron(job.expression);
    setEditTaskDescription(job.taskDescription);
    setEditDelegateTo(job.personaId?.trim() ? "persona" : "maia");
    setEditWakeKind(isDefaultWakeCronMessage(job.cronMessage) ? "wake_up" : "custom");
    setEditCustomBody(
      isDefaultWakeCronMessage(job.cronMessage) ? "" : (job.cronMessage ?? ""),
    );
    setEditPersonaId(job.personaId ?? "");
    setEditPersonaModel(job.personaModel ?? "");
    setSaveError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setSaveError(null);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    if (editScheduleTab === "custom" && !editCustomCron.trim()) {
      setSaveError(
        "Enter a valid 5-field cron expression (or switch to Quick picks).",
      );
      return;
    }
    if (editDelegateTo === "persona" && !editPersonaId.trim()) {
      setSaveError("Pick a persona for this wake.");
      return;
    }
    if (editDelegateTo === "persona" && !editPersonaModel.trim()) {
      setSaveError("Pick a model for the persona.");
      return;
    }
    if (editWakeKind === "custom" && !editCustomBody.trim()) {
      setSaveError("Enter custom wake instructions, or switch to Wake up.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/cron/jobs/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expression: editResolvedSchedule,
          taskDescription: editTaskDescription.trim(),
          personaId:
            editDelegateTo === "persona" ? editPersonaId.trim() || null : null,
          personaModel:
            editDelegateTo === "persona" ? editPersonaModel.trim() || null : null,
          cronMessage: editWakeKind === "wake_up" ? null : editCustomBody.trim(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setSaveError(body.error ?? `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      const updated = (await res.json()) as CronJob;
      setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
      setEditingId(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const deleteJob = async (id: string) => {
    if (!globalThis.confirm?.("Delete this schedule? This cannot be undone.")) {
      return;
    }
    setDeleteNotice(null);
    setDeletingId(id);
    try {
      const res = await fetch(`/api/cron/jobs/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setDeleteNotice({
          jobId: id,
          message: body.error ?? `Delete failed (${res.status})`,
        });
        return;
      }
      setJobs((prev) => prev.filter((j) => j.id !== id));
      setDeleteNotice(null);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-auto bg-zinc-950 text-zinc-100">
      <main className="max-w-3xl mx-auto px-4 py-8 pb-16">
        <h1 className="text-xl font-semibold tracking-tight">Schedules</h1>
        <p className="text-sm text-zinc-500 mt-1 mb-8 max-w-xl">
          Run a <strong className="text-zinc-300">wake up</strong> (review tasks,
          move work forward, propose new tasks if goals are not met) on a timer,
          or send <strong className="text-zinc-300">custom instructions</strong>{" "}
          to Maia or a catalog persona.
        </p>

        <section
          aria-labelledby="new-schedule-heading"
          className="mb-10 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-lg shadow-black/20"
        >
          <h2 id="new-schedule-heading" className="text-sm font-semibold text-zinc-200 mb-4">
            New schedule
          </h2>
          <form
            aria-label="New schedule form"
            onSubmit={submitCreate}
            className="space-y-5"
          >
            <div>
              <label htmlFor="cron-title" className="block text-xs font-medium text-zinc-400 mb-1.5">
                Name
              </label>
              <input
                id="cron-title"
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Morning task sweep"
                className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>

            <div>
              <span className="block text-xs font-medium text-zinc-400 mb-2">When</span>
              <div className="flex gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => setScheduleTab("quick")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    scheduleTab === "quick"
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-800/80"
                  }`}
                >
                  Quick picks
                </button>
                <button
                  type="button"
                  onClick={() => setScheduleTab("custom")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    scheduleTab === "custom"
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-800/80"
                  }`}
                >
                  Custom cron
                </button>
              </div>
              {scheduleTab === "quick" ? (
                <select
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value)}
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                >
                  {SCHEDULE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.expression})
                    </option>
                  ))}
                </select>
              ) : (
                <div>
                  <input
                    type="text"
                    value={customCron}
                    onChange={(e) => setCustomCron(e.target.value)}
                    placeholder="5-field cron e.g. 0 */6 * * *"
                    className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                  <p className="text-xs text-zinc-500 mt-1.5">
                    Uses standard 5-field cron (minute hour day month weekday).
                  </p>
                </div>
              )}
              <p className="text-xs text-zinc-500 mt-2" aria-live="polite">
                {createScheduleHint}
              </p>
            </div>

            <div>
              <span className="block text-xs font-medium text-zinc-400 mb-2">What to send</span>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-3 has-[:checked]:border-violet-500 has-[:checked]:ring-1 has-[:checked]:ring-violet-500/40">
                  <input
                    type="radio"
                    name="wakeKind"
                    checked={wakeKind === "wake_up"}
                    onChange={() => setWakeKind("wake_up")}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-zinc-200">Wake up</span>
                    <span className="text-xs text-zinc-500 leading-snug">
                      Default checklist: task board, progress, new tasks if the broader goal is not done.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-3 has-[:checked]:border-violet-500 has-[:checked]:ring-1 has-[:checked]:ring-violet-500/40">
                  <input
                    type="radio"
                    name="wakeKind"
                    checked={wakeKind === "custom"}
                    onChange={() => setWakeKind("custom")}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-zinc-200">Custom</span>
                    <span className="text-xs text-zinc-500 leading-snug">
                      Your instructions become the full wake message each run.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {wakeKind === "custom" && (
              <div>
                <label htmlFor="cron-custom-body" className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Custom wake message
                </label>
                <textarea
                  id="cron-custom-body"
                  rows={5}
                  value={createCustomBody}
                  onChange={(e) => setCreateCustomBody(e.target.value)}
                  placeholder="Instructions for this run…"
                  className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>
            )}

            <div>
              <span className="block text-xs font-medium text-zinc-400 mb-1">
                Run as
              </span>
              <p className="text-xs text-zinc-500 mb-2 leading-snug">
                Always Maia. Persona is a harness on the same orchestrator run.
              </p>
              {!loading && (!personas.length || !models.length) && (
                <p className="text-xs text-amber-500/90 mb-2 leading-snug">
                  Persona harness needs catalog personas and at least one whitelisted
                  model in Settings.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setCreateError(null);
                    setDelegateTo("maia");
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                    delegateTo === "maia"
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  Maia (orchestrator)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!personas.length || !models.length) {
                      setCreateError(
                        "Add catalog personas under data/personas/catalog and whitelist a model in Settings to use a persona harness.",
                      );
                      return;
                    }
                    setCreateError(null);
                    setDelegateTo("persona");
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                    delegateTo === "persona"
                      ? "bg-violet-600 text-white"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  Catalog persona
                </button>
              </div>
            </div>

            {delegateTo === "persona" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="cron-persona" className="block text-xs font-medium text-zinc-400 mb-1.5">
                    Persona
                  </label>
                  <select
                    id="cron-persona"
                    value={createPersonaId}
                    onChange={(e) => setCreatePersonaId(e.target.value)}
                    className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm"
                  >
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="cron-model" className="block text-xs font-medium text-zinc-400 mb-1.5">
                    Model (whitelist)
                  </label>
                  <select
                    id="cron-model"
                    value={createPersonaModel}
                    onChange={(e) => setCreatePersonaModel(e.target.value)}
                    className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm font-mono"
                  >
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-dashed border-zinc-700 p-4">
              <p className="text-xs font-medium text-zinc-400 mb-2">Optional: board task</p>
              <p className="text-xs text-zinc-600 mb-3">
                Creates a Kanban reminder linked in the description. Assignee is only for the
                task card—Maia still runs this schedule.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  type="text"
                  value={boardTaskTitle}
                  onChange={(e) => setBoardTaskTitle(e.target.value)}
                  placeholder="Task title (optional)"
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                />
                <select
                  value={boardTaskAssign}
                  onChange={(e) => setBoardTaskAssign(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                  aria-label="Assign task to"
                >
                  <option value="">Unassigned</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.id})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {createError && (
              <p className="text-sm text-red-400" role="alert">
                {createError}
              </p>
            )}

            <button
              type="submit"
              disabled={creating}
              className="w-full rounded-xl bg-violet-600 py-3 text-sm font-semibold text-white hover:bg-violet-500 disabled:bg-zinc-700 sm:w-auto sm:px-8"
            >
              {creating ? "Creating…" : "Create schedule"}
            </button>
          </form>
        </section>

        <h2 className="text-sm font-semibold text-zinc-300 mb-3">Your schedules</h2>
        {loading && <p className="text-zinc-500 text-sm">Loading…</p>}
        {error && (
          <p className="text-red-400 text-sm mb-4" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && jobs.length === 0 && (
          <p className="text-zinc-500 text-sm">No jobs yet. Create one above.</p>
        )}

        {!loading && jobs.length > 0 && (
          <ul className="space-y-3">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/60 overflow-hidden"
              >
                {editingId === job.id ? (
                  <div
                    className="p-5 space-y-4"
                    data-testid="cron-edit-panel"
                  >
                    <h3 className="font-medium text-sm text-zinc-200">Edit schedule</h3>
                    <div>
                      <span className="block text-xs text-zinc-500 mb-2">When</span>
                      <div className="flex gap-2 mb-3">
                        <button
                          type="button"
                          onClick={() => {
                            const matched = matchExpressionToPresetId(editCustomCron);
                            if (matched) setEditPresetId(matched);
                            else {
                              setEditPresetId(SCHEDULE_PRESETS[0].id);
                              setEditCustomCron(SCHEDULE_PRESETS[0].expression);
                            }
                            setEditScheduleTab("quick");
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                            editScheduleTab === "quick"
                              ? "bg-violet-600 text-white"
                              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-800/80"
                          }`}
                        >
                          Quick picks
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (editScheduleTab === "quick") {
                              const p = SCHEDULE_PRESETS.find((x) => x.id === editPresetId);
                              setEditCustomCron(p?.expression ?? editCustomCron);
                            }
                            setEditScheduleTab("custom");
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                            editScheduleTab === "custom"
                              ? "bg-violet-600 text-white"
                              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-800/80"
                          }`}
                        >
                          Custom cron
                        </button>
                      </div>
                      {editScheduleTab === "quick" ? (
                        <select
                          value={editPresetId}
                          onChange={(e) => setEditPresetId(e.target.value)}
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                          aria-label="Edit schedule quick pick"
                        >
                          {SCHEDULE_PRESETS.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label} ({p.expression})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div>
                          <input
                            type="text"
                            value={editCustomCron}
                            onChange={(e) => setEditCustomCron(e.target.value)}
                            placeholder="5-field cron e.g. 0 */6 * * *"
                            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                            aria-label="Edit schedule custom cron expression"
                          />
                          <p className="text-xs text-zinc-500 mt-1.5">
                            Uses standard 5-field cron (minute hour day month weekday).
                          </p>
                        </div>
                      )}
                      <p className="text-xs text-zinc-500 mt-2" aria-live="polite">
                        {editScheduleHint}
                      </p>
                    </div>
                    <div>
                      <span className="block text-xs font-medium text-zinc-400 mb-2">What to send</span>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-3 has-[:checked]:border-violet-500 has-[:checked]:ring-1 has-[:checked]:ring-violet-500/40">
                          <input
                            type="radio"
                            name="editWakeKind"
                            checked={editWakeKind === "wake_up"}
                            onChange={() => setEditWakeKind("wake_up")}
                            className="mt-1"
                          />
                          <span>
                            <span className="block text-sm font-medium text-zinc-200">Wake up</span>
                            <span className="text-xs text-zinc-500 leading-snug">
                              Default checklist on the task board.
                            </span>
                          </span>
                        </label>
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-950/50 p-3 has-[:checked]:border-violet-500 has-[:checked]:ring-1 has-[:checked]:ring-violet-500/40">
                          <input
                            type="radio"
                            name="editWakeKind"
                            checked={editWakeKind === "custom"}
                            onChange={() => setEditWakeKind("custom")}
                            className="mt-1"
                          />
                          <span>
                            <span className="block text-sm font-medium text-zinc-200">Custom</span>
                            <span className="text-xs text-zinc-500 leading-snug">
                              Your text is the full wake message each run.
                            </span>
                          </span>
                        </label>
                      </div>
                    </div>
                    {editWakeKind === "custom" && (
                      <div>
                        <label htmlFor="edit-custom-body" className="block text-xs font-medium text-zinc-400 mb-1.5">
                          Custom wake message
                        </label>
                        <textarea
                          id="edit-custom-body"
                          rows={5}
                          value={editCustomBody}
                          onChange={(e) => setEditCustomBody(e.target.value)}
                          placeholder="Instructions for this run…"
                          className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                        />
                      </div>
                    )}
                    <div>
                      <span className="block text-xs font-medium text-zinc-400 mb-1">
                        Run as
                      </span>
                      <p className="text-xs text-zinc-500 mb-2 leading-snug">
                        Always Maia. Persona is a harness on the same orchestrator run.
                      </p>
                      {!loading && (!personas.length || !models.length) && (
                        <p className="text-xs text-amber-500/90 mb-2 leading-snug">
                          Persona harness needs catalog personas and at least one whitelisted
                          model in Settings.
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSaveError(null);
                            setEditDelegateTo("maia");
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                            editDelegateTo === "maia"
                              ? "bg-violet-600 text-white"
                              : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          Maia (orchestrator)
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (!personas.length || !models.length) {
                              setSaveError(
                                "Add catalog personas and whitelist a model in Settings to use a persona harness.",
                              );
                              return;
                            }
                            setSaveError(null);
                            setEditDelegateTo("persona");
                            if (personas.length && !editPersonaId.trim()) {
                              setEditPersonaId(personas[0].id);
                            }
                            if (models.length && !editPersonaModel.trim()) {
                              setEditPersonaModel(models[0]);
                            }
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                            editDelegateTo === "persona"
                              ? "bg-violet-600 text-white"
                              : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          Catalog persona
                        </button>
                      </div>
                    </div>
                    {editDelegateTo === "persona" && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label htmlFor="edit-persona" className="block text-xs font-medium text-zinc-400 mb-1.5">
                            Persona
                          </label>
                          <select
                            id="edit-persona"
                            value={editPersonaId}
                            onChange={(e) => setEditPersonaId(e.target.value)}
                            className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm"
                          >
                            {editPersonaId &&
                              !personas.some((p) => p.id === editPersonaId) && (
                                <option value={editPersonaId}>
                                  {editPersonaId} (on this job)
                                </option>
                              )}
                            {personas.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} ({p.id})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="edit-model" className="block text-xs font-medium text-zinc-400 mb-1.5">
                            Model (whitelist)
                          </label>
                          <select
                            id="edit-model"
                            value={editPersonaModel}
                            onChange={(e) => setEditPersonaModel(e.target.value)}
                            className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm font-mono"
                          >
                            {editPersonaModel &&
                              !models.includes(editPersonaModel) && (
                                <option value={editPersonaModel}>
                                  {editPersonaModel} (on this job)
                                </option>
                              )}
                            {models.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                    <div>
                      <label htmlFor="edit-desc" className="block text-xs text-zinc-500 mb-1">
                        Name
                      </label>
                      <input
                        id="edit-desc"
                        type="text"
                        value={editTaskDescription}
                        onChange={(e) => setEditTaskDescription(e.target.value)}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                      />
                    </div>
                    {saveError && (
                      <p className="text-red-400 text-sm" role="alert">
                        {saveError}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={saving}
                        className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium hover:bg-violet-500 disabled:bg-zinc-700"
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={saving}
                        className="rounded-lg bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="px-5 py-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-sm text-zinc-100">
                            {job.taskDescription || job.id}
                          </span>
                          {job.isBuiltIn && (
                            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                              built-in
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-zinc-400 mt-1">
                          {job.scheduleDescription ?? job.expression}
                        </p>
                        {job.nextRunAt && (
                          <p className="text-xs text-zinc-500 mt-1">
                            Next: {formatNextRun(job.nextRunAt)}
                            <span className="text-zinc-600 ml-1">
                              ({new Date(job.nextRunAt).toLocaleString()})
                            </span>
                          </p>
                        )}
                        <p className="text-xs text-zinc-600 mt-2 font-mono truncate">
                          {job.expression} · {job.agentId} · {wakeSummary(job)}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(job)}
                          className="rounded-lg px-3 py-1.5 text-xs font-medium text-violet-400 ring-1 ring-violet-500/30 hover:bg-violet-500/10"
                        >
                          Edit
                        </button>
                        {!job.isBuiltIn && (
                          <button
                            type="button"
                            onClick={() => deleteJob(job.id)}
                            disabled={deletingId === job.id}
                            className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-400/90 ring-1 ring-red-500/20 hover:bg-red-500/10 disabled:opacity-50"
                          >
                            {deletingId === job.id ? "…" : "Delete"}
                          </button>
                        )}
                      </div>
                    </div>
                    {deleteNotice?.jobId === job.id && (
                      <p className="text-sm text-red-400 mt-2" role="alert">
                        {deleteNotice.message}
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
