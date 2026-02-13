/**
 * @fileoverview Hook execution engine for lifecycle events.
 * @module hooks/runner
 *
 * @note Registers hook definitions with the EventBus and manages their lifecycle.
 */

import type { EventBus } from "../core/types.js";
import type { HookDefinition } from "./types.js";

/**
 * @brief Creates a hook runner that registers lifecycle hooks with the event bus.
 * @param eventBus - The event bus to register hooks with
 * @returns Hook runner with register and clear methods
 *
 * @example
 * const runner = createHookRunner(eventBus);
 * runner.register({ event: "messageReceived", handler: async (data) => { ... } });
 */
export function createHookRunner(eventBus: EventBus) {
  const registered: HookDefinition[] = [];

  return {
    /**
     * @brief Registers a hook definition with the event bus.
     * @param hook - The hook definition to register
     */
    register(hook: HookDefinition): void {
      eventBus.on(hook.event, hook.handler);
      registered.push(hook);
    },

    /**
     * @brief Removes all registered hooks from the event bus.
     */
    clear(): void {
      for (const hook of registered) {
        eventBus.off(hook.event, hook.handler);
      }
      registered.length = 0;
    },

    /**
     * @brief Returns the number of registered hooks.
     * @returns Count of registered hooks
     */
    count(): number {
      return registered.length;
    },
  };
}
