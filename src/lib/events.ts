// Global SSE event bus — allows any server module to push events to connected clients
import type { SystemSSEEvent } from "./types";

type Listener = (event: SystemSSEEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(event: SystemSSEEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch { /* ignore */ }
  }
}
