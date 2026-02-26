/**
 * @fileoverview Single thread row in the thread list: label, relative time, optional rename and delete.
 * @module app/components/ThreadListItem
 *
 * @brief Renders one thread with label, time, and optional rename/delete controls.
 */

import { useState, useCallback, useEffect } from "react";
import type { SessionMeta } from "@/lib/types";

export interface ThreadListItemProps {
  /** Session metadata for this thread. */
  session: SessionMeta;
  /** Whether this thread is the currently active one. */
  isActive: boolean;
  /** Called when the row is clicked. */
  onSelect: () => void;
  /** Optional map of agent id → display name for sidebar labels. */
  agentNameMap?: Map<string, string>;
  /** Optional: called when user requests delete; if provided, a delete control is shown. */
  onDelete?: (sessionId: string) => void;
  /** Optional: called when user renames; if provided, a rename (edit) control is shown. */
  onRename?: (sessionId: string, name: string) => void;
}

/**
 * Format session updatedAt as relative time (e.g. "2m", "1h", "3d").
 * @param isoDate - ISO date string
 * @returns Human-readable relative time without "ago" suffix
 */
function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString();
}

/**
 * Resolve a participant id to display name (agent name or id).
 * @param id - Participant id (e.g. "user", "maia")
 * @param agentNameMap - Optional map of agent id → name
 * @returns Display string for the participant
 */
function resolveParticipantName(id: string, agentNameMap?: Map<string, string>): string {
  return agentNameMap?.get(id) ?? id;
}

/**
 * Derive display label from session name and participants/type.
 * @param session - Session metadata
 * @param agentNameMap - Optional map of agent id → display name
 * @returns Label string for the thread
 */
export function getThreadLabel(session: SessionMeta, agentNameMap?: Map<string, string>): string {
  if (session.name?.trim()) return session.name.trim();
  if (session.type === "agents" && session.participants.length >= 2) {
    return session.participants.map((p) => resolveParticipantName(p, agentNameMap)).join(" ↔ ");
  }
  if (session.type === "user" && session.participants.length >= 2) {
    const other = session.participants.filter((p) => p !== "user")[0];
    const display = other ? resolveParticipantName(other, agentNameMap) : null;
    return display ? `Chat with ${display}` : "Chat";
  }
  return "New thread";
}

/** Trash icon for delete action. */
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

/** Pencil icon for rename action. */
function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

export default function ThreadListItem({ session, isActive, onSelect, agentNameMap, onDelete, onRename }: ThreadListItemProps) {
  const label = getThreadLabel(session, agentNameMap);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label && onRename) {
      onRename(session.id, trimmed);
    }
    setIsEditing(false);
    setEditValue(label);
  }, [editValue, label, onRename, session.id]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditValue(label);
  }, [label]);

  useEffect(() => {
    if (isEditing) setEditValue(label);
  }, [isEditing, label]);

  return (
    <div
      className={`rounded-lg text-sm transition-colors flex items-center gap-1 border ${
        isActive
          ? "bg-violet-600/30 text-violet-200 border-violet-500/50"
          : "hover:bg-zinc-800 text-zinc-300 border-transparent"
      }`}
    >
      {isEditing ? (
        <div className="flex-1 min-w-0 flex items-center px-2 py-1.5 gap-1">
          <input
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") cancelEdit();
            }}
            onBlur={commitRename}
            className="flex-1 min-w-0 px-2 py-1 text-sm rounded bg-zinc-800 text-zinc-100 border border-zinc-600 focus:border-violet-500 focus:outline-none"
            aria-label="Thread name"
            autoFocus
          />
          {onDelete && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onDelete(session.id);
              }}
              className="shrink-0 p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              aria-label="Delete thread"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 min-w-0 text-left px-3 py-2.5 flex items-center gap-2 rounded-l-lg"
          aria-current={isActive ? "true" : undefined}
        >
          <span className="flex-1 min-w-0 truncate" title={label}>
            {label}
          </span>
          <span className="shrink-0 text-xs text-zinc-500" title={session.updatedAt}>
            {formatRelativeTime(session.updatedAt)}
          </span>
        </button>
      )}
      {onRename && !isEditing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsEditing(true);
          }}
          className="shrink-0 p-2 rounded-r-lg text-zinc-500 hover:text-violet-400 hover:bg-violet-500/10 transition-colors"
          aria-label="Rename thread"
        >
          <PencilIcon />
        </button>
      )}
    </div>
  );
}
