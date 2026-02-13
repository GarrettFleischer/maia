/**
 * @fileoverview Session manager for chat conversations. Handles message storage,
 * token estimation, and context compaction when the conversation exceeds the
 * context window threshold.
 * @module agent/session
 */

import type { ChatMessage, Clock, Logger } from "../core/types.js";

/** @brief Dependencies for createSessionManager */
export interface SessionManagerDeps {
  contextWindowSize: number;
  compactionThresholdPercent: number;
  preserveRecentMessages: number;
  logger: Logger;
  clock: Clock;
}

/** @brief Internal session storage structure */
interface SessionData {
  id: string;
  messages: ChatMessage[];
}

/** @brief Session manager interface */
export interface SessionManager {
  create(): { id: string; messages: ChatMessage[] };
  addMessage(sessionId: string, message: ChatMessage): void;
  getMessages(sessionId: string): ChatMessage[];
  estimateTokens(sessionId: string): number;
  needsCompaction(sessionId: string): boolean;
  compact(sessionId: string, summary: string): Promise<void>;
}

/**
 * @brief Generates a random hex string for session IDs.
 * @returns A 32-character hex string
 */
function randomHexId(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @brief Creates a session manager for chat conversations.
 * @param deps - Dependencies: contextWindowSize, compactionThresholdPercent,
 *   preserveRecentMessages, logger, clock
 * @returns SessionManager instance with create, addMessage, getMessages,
 *   estimateTokens, needsCompaction, and compact methods
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const {
    contextWindowSize,
    compactionThresholdPercent,
    preserveRecentMessages,
    logger,
  } = deps;

  const sessions = new Map<string, SessionData>();

  return {
    create(): { id: string; messages: ChatMessage[] } {
      const id = randomHexId();
      const session: SessionData = { id, messages: [] };
      sessions.set(id, session);
      logger.debug("Session created", { sessionId: id });
      return { id, messages: session.messages };
    },

    addMessage(sessionId: string, message: ChatMessage): void {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      session.messages.push(message);
    },

    getMessages(sessionId: string): ChatMessage[] {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      return session.messages;
    },

    estimateTokens(sessionId: string): number {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const totalChars = session.messages.reduce(
        (sum, msg) => sum + (msg.content?.length ?? 0),
        0
      );
      return Math.ceil(totalChars / 4);
    },

    needsCompaction(sessionId: string): boolean {
      const tokens = this.estimateTokens(sessionId);
      const threshold = contextWindowSize * (compactionThresholdPercent / 100);
      return tokens > threshold;
    },

    async compact(sessionId: string, summary: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      const recent = session.messages.slice(-preserveRecentMessages);
      const summaryMessage: ChatMessage = {
        role: "system",
        content: `[Previous conversation summary]: ${summary}`,
      };
      session.messages = [summaryMessage, ...recent];
      logger.debug("Session compacted", {
        sessionId,
        preservedMessages: recent.length,
      });
    },
  };
}
