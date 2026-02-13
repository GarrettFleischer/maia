/**
 * @fileoverview Event bus implementation using the Observer pattern.
 * @module core/events
 *
 * @note Provides lifecycle hooks for the Maia system. Handlers are called
 * sequentially and may be async. The bus is injected via MaiaContext.
 */

import type { EventBus, MaiaEvent, EventHandler } from "./types.js";

/**
 * @brief Creates an event bus for lifecycle hooks and event-driven communication.
 * @returns EventBus implementation
 *
 * @example
 * const bus = createEventBus();
 * bus.on("messageReceived", async (data) => { console.log(data); });
 * await bus.emit("messageReceived", { content: "hello" });
 */
export function createEventBus(): EventBus {
  const handlers = new Map<MaiaEvent, Set<EventHandler>>();

  return {
    on(event: MaiaEvent, handler: EventHandler): void {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
    },

    off(event: MaiaEvent, handler: EventHandler): void {
      handlers.get(event)?.delete(handler);
    },

    async emit(event: MaiaEvent, data: Record<string, unknown>): Promise<void> {
      const eventHandlers = handlers.get(event);
      if (!eventHandlers) return;

      for (const handler of eventHandlers) {
        await handler(data);
      }
    },
  };
}
