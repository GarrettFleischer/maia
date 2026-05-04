"use client";

/**
 * @fileoverview Cron jobs view: list scheduled jobs, edit schedules, tools, and wake presets.
 * Rendered inside the app shell so state is preserved when switching tabs.
 * @module app/views/CronView
 */

import { useCallback, useEffect, useState } from "react";
import type { CronJob } from "@/lib/types";
import {
  applyCronWakePreset,
  CRON_WAKE_PRESET_HINTS,
  inferCronWakePreset,
  type CronWakePresetId,
} from "@/lib/cron/wake-presets";

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

/**
 * @brief Cron jobs content (no header). Rendered inside app shell.
 */
export default function CronView() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wakePreset, setWakePreset] = useState<CronWakePresetId>("legacy");
  const [editForm, setEditForm] = useState({
    expression: "",
    taskDescription: "",
    toolName: "",
    toolArgsJson: "{}",
    agentId: "",
    personaId: "",
    personaModel: "",
    cronMessage: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await fetch("/api/cron/jobs");
      if (!r.ok) throw new Error(`Jobs ${r.status}`);
      const data = (await r.json()) as { jobs: CronJob[] };
      setJobs(data.jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const startEdit = (job: CronJob) => {
    setEditingId(job.id);
    const inferred = inferCronWakePreset({
      personaId: job.personaId,
      cronMessage: job.cronMessage,
    });
    setWakePreset(inferred);
    setEditForm({
      expression: job.expression,
      taskDescription: job.taskDescription,
      toolName: job.toolName ?? "cron_echo",
      toolArgsJson: JSON.stringify(job.toolArgs ?? {}, null, 2),
      agentId: job.agentId ?? "",
      personaId: job.personaId ?? "",
      personaModel: job.personaModel ?? "",
      cronMessage: job.cronMessage ?? "",
    });
    setSaveError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setSaveError(null);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    setSaveError(null);
    try {
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(editForm.toolArgsJson) as Record<string, unknown>;
      } catch {
        setSaveError("Invalid JSON in tool args");
        setSaving(false);
        return;
      }
      const res = await fetch(`/api/cron/jobs/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expression: editForm.expression,
          taskDescription: editForm.taskDescription,
          toolName: editForm.toolName,
          toolArgs,
          ...(editForm.agentId.trim() && { agentId: editForm.agentId.trim() }),
          personaId:
            editForm.personaId.trim() === ""
              ? null
              : editForm.personaId.trim(),
          personaModel:
            editForm.personaModel.trim() === ""
              ? null
              : editForm.personaModel.trim(),
          cronMessage:
            editForm.cronMessage.trim() === ""
              ? null
              : editForm.cronMessage,
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

  return (
    <div className="h-full min-h-0 overflow-auto bg-zinc-950 text-zinc-100">
      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold mb-2">Cron jobs</h1>
        <p className="text-sm text-zinc-500 mb-6">
          Scheduled tasks that run on a timer. Each job shows when it will run
          next.
        </p>

        {loading && <p className="text-zinc-500 text-sm">Loading...</p>}
        {error && (
          <p className="text-red-400 text-sm mb-4" role="alert">
            {error}
          </p>
        )}

        {!loading && !error && jobs.length === 0 && (
          <p className="text-zinc-500 text-sm">
            No cron jobs. Jobs are created via agent tools or the system.
          </p>
        )}

        {!loading && jobs.length > 0 && (
          <ul className="space-y-4">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden"
              >
                {editingId === job.id ? (
                  <div className="p-5 space-y-4">
                    <h3 className="font-medium text-sm">Edit job</h3>
                    <div>
                      <label
                        htmlFor="wake-preset"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Wake preset
                      </label>
                      <select
                        id="wake-preset"
                        value={wakePreset}
                        onChange={(e) => {
                          const v = e.target.value as CronWakePresetId;
                          setWakePreset(v);
                          setEditForm((f) => ({
                            ...f,
                            ...applyCronWakePreset(v, {
                              personaId: f.personaId,
                              personaModel: f.personaModel,
                              cronMessage: f.cronMessage,
                            }),
                          }));
                        }}
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600 border border-zinc-700"
                      >
                        <option value="legacy">
                          Tool-first ([CRON] + forced tool below)
                        </option>
                        <option value="prompt_default">
                          Maia prompt — default task review
                        </option>
                        <option value="prompt_custom">
                          Maia prompt — custom message
                        </option>
                        <option value="persona">
                          Delegated persona (maia + slug + model)
                        </option>
                      </select>
                      <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
                        {CRON_WAKE_PRESET_HINTS[wakePreset]}
                      </p>
                    </div>
                    <div>
                      <label
                        htmlFor="edit-expression"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Cron expression (e.g.{" "}
                        <code className="bg-zinc-800 px-1 rounded">
                          */5 * * * *
                        </code>
                        )
                      </label>
                      <input
                        id="edit-expression"
                        type="text"
                        value={editForm.expression}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            expression: e.target.value,
                          }))
                        }
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder="*/5 * * * *"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-agent"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Target agent ID
                      </label>
                      <input
                        id="edit-agent"
                        type="text"
                        value={editForm.agentId}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            agentId: e.target.value,
                          }))
                        }
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder="e.g. maia"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-desc"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Description
                      </label>
                      <input
                        id="edit-desc"
                        type="text"
                        value={editForm.taskDescription}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            taskDescription: e.target.value,
                          }))
                        }
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder="e.g. Daily digest"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-tool"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Tool name
                      </label>
                      <input
                        id="edit-tool"
                        type="text"
                        value={editForm.toolName}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            toolName: e.target.value,
                          }))
                        }
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder="cron_echo"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-args"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Tool args (JSON)
                      </label>
                      <textarea
                        id="edit-args"
                        value={editForm.toolArgsJson}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            toolArgsJson: e.target.value,
                          }))
                        }
                        rows={3}
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder='{"message": "Hello"}'
                      />
                    </div>
                    <p className="text-xs text-zinc-500">
                      Presets adjust persona / cron fields only—expression, agent,
                      description, and tool fields stay as you set them unless you change
                      them here.
                    </p>
                    <div>
                      <label
                        htmlFor="edit-persona-id"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Persona id (catalog slug, optional)
                      </label>
                      <input
                        id="edit-persona-id"
                        type="text"
                        value={editForm.personaId}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            personaId: e.target.value,
                          }))
                        }
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder="e.g. typescript-pro"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-persona-model"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Persona model (whitelist id)
                      </label>
                      <input
                        id="edit-persona-model"
                        type="text"
                        value={editForm.personaModel}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            personaModel: e.target.value,
                          }))
                        }
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder="e.g. ollama/llama3.2"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="edit-cron-message"
                        className="block text-xs text-zinc-500 mb-1"
                      >
                        Cron message (prompt wake; leave empty for tool-first only)
                      </label>
                      <textarea
                        id="edit-cron-message"
                        value={editForm.cronMessage}
                        onChange={(e) =>
                          setEditForm((f) => ({
                            ...f,
                            cronMessage: e.target.value,
                          }))
                        }
                        rows={4}
                        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                        placeholder="Empty + empty persona → legacy tool wake"
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
                        className="px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-sm font-medium"
                      >
                        {saving ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={saving}
                        className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="px-5 pt-4 pb-2 flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">
                            {job.taskDescription || job.id}
                          </span>
                          {job.isBuiltIn && (
                            <span className="text-xs bg-zinc-700 text-zinc-400 px-2 py-0.5 rounded">
                              built-in
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-zinc-400 mt-1">
                          {job.scheduleDescription ?? job.expression}
                        </p>
                        {job.nextRunAt && (
                          <p className="text-xs text-zinc-500 mt-1">
                            Next run: {formatNextRun(job.nextRunAt)}
                            <span className="text-zinc-600 ml-1">
                              ({new Date(job.nextRunAt).toLocaleString()})
                            </span>
                          </p>
                        )}
                        <p className="text-xs text-zinc-600 mt-1 font-mono">
                          {job.agentId} · {job.toolName}
                          {job.personaId ? (
                            <> · persona {job.personaId}</>
                          ) : job.cronMessage != null ? (
                            <> · prompt wake</>
                          ) : (
                            <> · tool-first</>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => startEdit(job)}
                        className="text-xs text-violet-400 hover:text-violet-300 px-2 py-1 rounded shrink-0"
                      >
                        Edit
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
