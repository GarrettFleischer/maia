"use client";

import { use, useCallback, useEffect, useState } from "react";
import type { AgentDefinition, Task } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";

const STATUS_LABELS: Record<Task["status"], string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

const STATUS_COLORS: Record<Task["status"], string> = {
  todo: "text-zinc-400 bg-zinc-800",
  in_progress: "text-violet-300 bg-violet-900/50",
  done: "text-green-400 bg-green-900/50",
};

const COLUMN_HEADER_COLORS: Record<Task["status"], string> = {
  todo: "border-zinc-700",
  in_progress: "border-violet-700",
  done: "border-green-700",
};

const COLUMNS: Task["status"][] = ["todo", "in_progress", "done"];

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Pre-resolved promise for tests when Next.js does not pass params/searchParams; avoids conditional use() call. */
const RESOLVED_EMPTY = Promise.resolve({} as Record<string, string | string[] | undefined>);

/** Props for tasks page; params/searchParams are Promises in Next.js 15 and must be unwrapped with use(). */
type TasksPageProps = {
  params?: Promise<Record<string, string | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

interface TaskCardProps {
  task: Task;
  agents: AgentDefinition[];
  onUpdate: (id: string, patch: { status?: Task["status"]; note?: string; assignedTo?: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function TaskCard({ task, agents, onUpdate, onDelete }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const nextStatus = task.status === "todo" ? "in_progress" : task.status === "in_progress" ? "done" : null;
  const prevStatus = task.status === "done" ? "in_progress" : task.status === "in_progress" ? "todo" : null;

  async function changeStatus(status: Task["status"]) {
    setSaving(true);
    await onUpdate(task.id, { status });
    setSaving(false);
  }

  async function submitNote() {
    if (!noteText.trim()) return;
    setSaving(true);
    await onUpdate(task.id, { note: noteText.trim() });
    setNoteText("");
    setSaving(false);
  }

  const assignedAgent = agents.find((a) => a.id === task.assignedTo);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <div
        className="px-4 pt-3 pb-2 cursor-pointer hover:bg-zinc-800/50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium leading-snug">{task.title}</span>
          <span className="text-zinc-600 text-xs mt-0.5 shrink-0">{expanded ? "▲" : "▼"}</span>
        </div>
        {task.description && (
          <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{task.description}</p>
        )}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <span className="text-xs text-zinc-600">by {task.createdBy}</span>
          {task.assignedTo && (
            <span className="text-xs bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded-full">
              → {assignedAgent?.name ?? task.assignedTo}
            </span>
          )}
          {task.notes.length > 0 && (
            <span className="text-xs text-zinc-600">{task.notes.length} note{task.notes.length !== 1 ? "s" : ""}</span>
          )}
          <span className="text-xs text-zinc-700 ml-auto">{timeAgo(task.updatedAt)}</span>
        </div>
      </div>

      {/* Status change buttons */}
      <div className="px-4 pb-3 flex gap-1.5 flex-wrap">
        {prevStatus && (
          <button
            onClick={() => changeStatus(prevStatus)}
            disabled={saving}
            className="text-xs px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors disabled:opacity-50"
          >
            ← {STATUS_LABELS[prevStatus]}
          </button>
        )}
        {nextStatus && (
          <button
            onClick={() => changeStatus(nextStatus)}
            disabled={saving}
            className="text-xs px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-50"
          >
            {STATUS_LABELS[nextStatus]} →
          </button>
        )}
      </div>

      {/* Expanded: notes + add note */}
      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-3">
          {/* Assign */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-500 shrink-0">Assign to</label>
            <select
              value={task.assignedTo ?? ""}
              onChange={(e) => onUpdate(task.id, { assignedTo: e.target.value || null })}
              className="flex-1 bg-zinc-800 text-xs text-zinc-300 rounded-lg px-2 py-1 border border-zinc-700 focus:outline-none focus:ring-1 focus:ring-violet-600"
            >
              <option value="">— unassigned —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* Notes list */}
          {task.notes.length > 0 && (
            <div className="space-y-2">
              {task.notes.map((n, i) => (
                <div key={i} className="bg-zinc-800/60 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-zinc-400">{n.agentId}</span>
                    <span className="text-xs text-zinc-600">{timeAgo(n.timestamp)}</span>
                  </div>
                  <p className="text-xs text-zinc-300 whitespace-pre-wrap">{n.content}</p>
                </div>
              ))}
            </div>
          )}

          {/* Add note */}
          <div className="flex gap-2">
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note…"
              rows={2}
              className="flex-1 bg-zinc-800 text-xs text-zinc-200 rounded-lg px-3 py-2 border border-zinc-700 focus:outline-none focus:ring-1 focus:ring-violet-600 resize-none placeholder:text-zinc-600"
            />
            <button
              onClick={submitNote}
              disabled={saving || !noteText.trim()}
              className="text-xs px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50 self-start"
            >
              Add
            </button>
          </div>

          {/* Delete task */}
          <div className="pt-2 border-t border-zinc-800">
            <button
              type="button"
              onClick={async () => {
                if (!window.confirm("Delete this task? This cannot be undone.")) return;
                setDeleting(true);
                await onDelete(task.id);
                setDeleting(false);
              }}
              disabled={deleting}
              className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-900/50 text-zinc-400 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete task"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TasksPage(props: TasksPageProps = {}) {
  use(props.params ?? RESOLVED_EMPTY as Promise<Record<string, string | undefined>>);
  use(props.searchParams ?? RESOLVED_EMPTY);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchTasks = useCallback(async () => {
    const r = await fetch("/api/tasks");
    const d = await r.json();
    setTasks(d.tasks ?? []);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/tasks").then((r) => r.json()),
      fetch("/api/agents").then((r) => r.json()),
    ]).then(([td, ad]) => {
      setTasks(td.tasks ?? []);
      setAgents(ad.agents ?? []);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("tasks_changed", () => {
      fetchTasks();
    });
    return () => es.close();
  }, [fetchTasks]);

  const handleUpdate = useCallback(async (
    id: string,
    patch: { status?: Task["status"]; note?: string; assignedTo?: string | null }
  ) => {
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await fetchTasks();
  }, [fetchTasks]);

  const handleDelete = useCallback(async (id: string) => {
    const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (res.ok) await fetchTasks();
  }, [fetchTasks]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: newTitle.trim(),
        description: newDesc.trim() || undefined,
        assignedTo: newAssignee || undefined,
      }),
    });
    setNewTitle("");
    setNewDesc("");
    setNewAssignee("");
    setShowForm(false);
    setCreating(false);
    await fetchTasks();
  }

  const byStatus = (status: Task["status"]) => tasks.filter((t) => t.status === status);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader subtitle="Tasks" />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Page heading */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold">Task Board</h1>
          <button
            onClick={() => setShowForm((s) => !s)}
            className="text-sm px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors"
          >
            {showForm ? "Cancel" : "+ New Task"}
          </button>
        </div>

        {/* New task form */}
        {showForm && (
          <form
            onSubmit={handleCreate}
            className="bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-4 mb-6 space-y-3"
          >
            <h2 className="text-sm font-medium">New Task</h2>
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Task title"
              required
              className="w-full bg-zinc-800 text-sm rounded-lg px-3 py-2 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-violet-600 placeholder:text-zinc-600"
            />
            <textarea
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className="w-full bg-zinc-800 text-sm rounded-lg px-3 py-2 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-violet-600 placeholder:text-zinc-600 resize-none"
            />
            <div className="flex items-center gap-3">
              <select
                value={newAssignee}
                onChange={(e) => setNewAssignee(e.target.value)}
                className="bg-zinc-800 text-sm text-zinc-300 rounded-lg px-3 py-2 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-violet-600"
              >
                <option value="">Assign to… (optional)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <button
                type="submit"
                disabled={creating || !newTitle.trim()}
                className="px-4 py-2 text-sm rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create Task"}
              </button>
            </div>
          </form>
        )}

        {loading && <p className="text-zinc-500 text-sm">Loading tasks…</p>}

        {/* Kanban columns */}
        {!loading && (
          <div className="grid grid-cols-3 gap-4">
            {COLUMNS.map((status) => {
              const col = byStatus(status);
              return (
                <div key={status} className={`border-t-2 ${COLUMN_HEADER_COLORS[status]} pt-3`}>
                  {/* Column header */}
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <span className="text-sm font-medium">{STATUS_LABELS[status]}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[status]}`}>
                      {col.length}
                    </span>
                  </div>

                  {/* Cards */}
                  <div className="space-y-2">
                    {col.length === 0 && (
                      <p className="text-xs text-zinc-700 px-1">No tasks</p>
                    )}
                    {col.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        agents={agents}
                        onUpdate={handleUpdate}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
