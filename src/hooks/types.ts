/**
 * @fileoverview Lifecycle hook type definitions.
 * @module hooks/types
 */

import type { MaiaEvent, EventHandler } from "../core/types.js";

/**
 * @brief Hook definition for lifecycle events.
 */
export interface HookDefinition {
  event: MaiaEvent;
  handler: EventHandler;
  priority?: number;
}
