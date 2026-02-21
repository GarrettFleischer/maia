// Global SSE event bus — allows any server module to push events to connected clients
// In production, this module-level singleton is used.
// In tests, pass an AppContext with a FakeEvents instance instead.
import type { SystemSSEEvent } from "./types";
import type { EventBus } from "./context";

type Listener = (event: SystemSSEEvent) => void;

const listeners = new Set<Listener>();

/** Module-level production event bus (singleton). */
export const globalEventBus: EventBus = {
  emit(event: SystemSSEEvent): void {
    for (const listener of listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** @deprecated Use AppContext.events instead. Kept for legacy SSE route compatibility. */
export function subscribe(listener: Listener): () => void {
  return globalEventBus.subscribe(listener);
}

/** @deprecated Use AppContext.events instead. Kept for legacy SSE route compatibility. */
export function emit(event: SystemSSEEvent): void {
  globalEventBus.emit(event);
}
