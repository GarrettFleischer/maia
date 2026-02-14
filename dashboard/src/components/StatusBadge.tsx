/**
 * @fileoverview Status badge component for displaying agent states.
 * @module components/StatusBadge
 */

interface StatusBadgeProps {
  status: "active" | "running" | "idle" | "offline";
  size?: "sm" | "md";
}

const STATUS_COLORS = {
  active: "bg-maia-success",
  running: "bg-maia-warning",
  idle: "bg-maia-text-dim",
  offline: "bg-maia-error",
};

const STATUS_LABELS = {
  active: "Active",
  running: "Running",
  idle: "Idle",
  offline: "Offline",
};

/**
 * @brief Renders a colored dot badge indicating agent status.
 * @param props - status and optional size
 * @returns Preact element
 */
export function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const dotSize = size === "sm" ? "w-2 h-2" : "w-3 h-3";

  return (
    <span class="inline-flex items-center gap-1.5">
      <span class={`${dotSize} rounded-full ${STATUS_COLORS[status]} inline-block`} />
      <span class="text-xs text-maia-text-dim">{STATUS_LABELS[status]}</span>
    </span>
  );
}
