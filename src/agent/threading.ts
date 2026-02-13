/**
 * @fileoverview Conversation thread tracker. Manages multiple conversation
 * threads by topic, allowing creation, message storage, and topic-based lookup.
 * @module agent/threading
 */

import type { ChatMessage } from "../core/types.js";

/** @brief Internal thread storage structure */
interface ThreadData {
  id: string;
  topic: string;
  messages: ChatMessage[];
}

/** @brief Thread tracker interface */
export interface ThreadTracker {
  createThread(topic: string): { id: string; topic: string };
  addMessage(threadId: string, message: ChatMessage): void;
  getMessages(threadId: string): ChatMessage[];
  listThreads(): Array<{ id: string; topic: string }>;
  findByTopic(query: string): { id: string; topic: string } | undefined;
}

/**
 * @brief Generates a random hex string for thread IDs.
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
 * @brief Creates a thread tracker for managing conversation threads.
 * @returns ThreadTracker instance with createThread, addMessage, getMessages,
 *   listThreads, and findByTopic methods
 */
export function createThreadTracker(): ThreadTracker {
  const threads = new Map<string, ThreadData>();

  return {
    createThread(topic: string): { id: string; topic: string } {
      const id = randomHexId();
      const thread: ThreadData = { id, topic, messages: [] };
      threads.set(id, thread);
      return { id, topic };
    },

    addMessage(threadId: string, message: ChatMessage): void {
      const thread = threads.get(threadId);
      if (!thread) {
        throw new Error(`Unknown thread: ${threadId}`);
      }
      thread.messages.push(message);
    },

    getMessages(threadId: string): ChatMessage[] {
      const thread = threads.get(threadId);
      if (!thread) {
        throw new Error(`Unknown thread: ${threadId}`);
      }
      return thread.messages;
    },

    listThreads(): Array<{ id: string; topic: string }> {
      return Array.from(threads.values()).map((t) => ({
        id: t.id,
        topic: t.topic,
      }));
    },

    findByTopic(query: string): { id: string; topic: string } | undefined {
      const lowerQuery = query.toLowerCase();
      for (const thread of threads.values()) {
        if (thread.topic.toLowerCase().includes(lowerQuery)) {
          return { id: thread.id, topic: thread.topic };
        }
      }
      return undefined;
    },
  };
}
