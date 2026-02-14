/**
 * @fileoverview Thread service for managing persistent conversation threads
 * between users, agents, and Maia. Supports thread creation, message appending,
 * thread sharing between agents, and paginated message retrieval.
 * @module threads/service
 */

import type { Database, CryptoProvider, Clock, Logger } from "../core/types.js";

/**
 * @brief Thread types supported by the system.
 */
export type ThreadType =
  | "user-maia"
  | "user-agent"
  | "agent-agent"
  | "agent-dm"
  | "maia-agent-checkin";

/**
 * @brief Sender type for thread messages.
 */
export type SenderType = "user" | "agent" | "maia";

/**
 * @brief A conversation thread record.
 */
export interface Thread {
  id: string;
  type: ThreadType;
  title: string | null;
  participants: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * @brief A single message within a thread.
 */
export interface ThreadMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: SenderType;
  content: string;
  createdAt: string;
}

/**
 * @brief A thread share record.
 */
export interface ThreadShare {
  threadId: string;
  sharedWith: string;
  sharedBy: string;
  sharedAt: string;
}

/**
 * @brief A pending DM held during quiet time.
 */
export interface PendingDm {
  id: string;
  senderId: string;
  content: string;
  createdAt: string;
  recipientId: string;
}

/**
 * @brief Dependencies for createThreadService.
 */
export interface ThreadServiceDeps {
  db: Database;
  crypto: CryptoProvider;
  clock: Clock;
  logger: Logger;
}

/**
 * @brief Thread service interface for CRUD operations on threads and messages.
 */
export interface ThreadService {
  /**
   * @brief Creates a new conversation thread.
   * @param type - Thread type (user-maia, user-agent, agent-agent, agent-dm, maia-agent-checkin)
   * @param participants - Array of participant IDs
   * @param title - Optional thread title
   * @returns The created thread
   */
  createThread(type: ThreadType, participants: string[], title?: string): Promise<Thread>;

  /**
   * @brief Appends a message to a thread.
   * @param threadId - Thread to add the message to
   * @param senderId - ID of the sender
   * @param senderType - Type of sender (user, agent, maia)
   * @param content - Message content
   * @returns The created message
   */
  addMessage(threadId: string, senderId: string, senderType: SenderType, content: string): Promise<ThreadMessage>;

  /**
   * @brief Gets a thread by ID.
   * @param id - Thread identifier
   * @returns Thread or undefined if not found
   */
  getThread(id: string): Promise<Thread | undefined>;

  /**
   * @brief Gets paginated messages for a thread.
   * @param threadId - Thread identifier
   * @param limit - Maximum number of messages (default 50)
   * @param offset - Number of messages to skip (default 0)
   * @returns Array of messages ordered by created_at ascending
   */
  getMessages(threadId: string, limit?: number, offset?: number): Promise<ThreadMessage[]>;

  /**
   * @brief Lists threads that a participant is part of.
   * @param participantId - Optional participant ID to filter by
   * @returns Array of threads ordered by updated_at descending
   */
  listThreads(participantId?: string): Promise<Thread[]>;

  /**
   * @brief Shares a thread with another agent.
   * @param threadId - Thread to share
   * @param sharedWith - Agent ID to share with
   * @param sharedBy - Agent ID doing the sharing
   * @returns The share record
   */
  shareThread(threadId: string, sharedWith: string, sharedBy: string): Promise<ThreadShare>;

  /**
   * @brief Gets threads shared with a specific agent.
   * @param agentId - Agent identifier
   * @returns Array of threads shared with the agent
   */
  getSharedThreads(agentId: string): Promise<Thread[]>;

  /**
   * @brief Stores a pending DM for quiet-time hold.
   * @param senderId - Sender ID (e.g. "maia" or agent id)
   * @param content - DM content
   * @param recipientId - Recipient ID (default "user")
   * @returns The pending DM record
   */
  storePendingDm(senderId: string, content: string, recipientId?: string): Promise<PendingDm>;

  /**
   * @brief Gets all pending DMs for a recipient.
   * @param recipientId - Recipient ID (default "user")
   * @returns Array of pending DMs ordered by created_at ascending
   */
  getPendingDms(recipientId?: string): Promise<PendingDm[]>;

  /**
   * @brief Clears all pending DMs for a recipient (after flush).
   * @param recipientId - Recipient ID (default "user")
   */
  clearPendingDms(recipientId?: string): Promise<void>;

  /**
   * @brief Finds or creates a thread of a given type between specific participants.
   * @param type - Thread type
   * @param participants - Array of participant IDs (order-independent match)
   * @param title - Optional title for new thread
   * @returns Existing or new thread
   */
  findOrCreateThread(type: ThreadType, participants: string[], title?: string): Promise<Thread>;

  /**
   * @brief Gets the ISO timestamp of the most recent message sent by an agent in any agent-dm thread.
   * Used to skip check-ins when the agent has recently DMed the user or Maia.
   * @param agentId - Agent ID (participant in agent-dm threads)
   * @returns ISO timestamp of latest message sent by agentId in agent-dm threads, or null if none
   */
  getLastDmSentAt(agentId: string): Promise<string | null>;

  /**
   * @brief Gets all threads a participant is in and their messages since a timestamp.
   * Used for check-in security review to gather recent conversation for each agent.
   * @param participantId - Participant ID (e.g. agent id)
   * @param sinceIso - ISO timestamp; only messages with created_at >= this are returned
   * @returns Array of { threadId, threadType, messages } for each thread that has messages in the window
   */
  getMessagesForParticipantSince(
    participantId: string,
    sinceIso: string
  ): Promise<{ threadId: string; threadType: ThreadType; messages: ThreadMessage[] }[]>;
}

/**
 * @brief Database row type for threads table.
 */
interface ThreadRow {
  id: string;
  type: string;
  title: string | null;
  participants: string;
  created_at: string;
  updated_at: string;
}

/**
 * @brief Database row type for thread_messages table.
 */
interface MessageRow {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  created_at: string;
}

/**
 * @brief Database row type for pending_dms table.
 */
interface PendingDmRow {
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
  recipient_id: string;
}

/**
 * @brief Converts a ThreadRow to a Thread.
 * @param row - Database row
 * @returns Thread object
 */
function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    type: row.type as ThreadType,
    title: row.title,
    participants: JSON.parse(row.participants) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @brief Converts a MessageRow to a ThreadMessage.
 * @param row - Database row
 * @returns ThreadMessage object
 */
function rowToMessage(row: MessageRow): ThreadMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderId: row.sender_id,
    senderType: row.sender_type as SenderType,
    content: row.content,
    createdAt: row.created_at,
  };
}

/**
 * @brief Creates a thread service instance.
 * @param deps - Dependencies: db, crypto, clock, logger
 * @returns ThreadService interface
 *
 * @example
 * const threadService = createThreadService({ db, crypto, clock, logger });
 * const thread = await threadService.createThread("user-maia", ["user", "maia"], "General chat");
 * await threadService.addMessage(thread.id, "user", "user", "Hello Maia!");
 */
export function createThreadService(deps: ThreadServiceDeps): ThreadService {
  const { db, crypto, clock, logger } = deps;

  return {
    async createThread(type: ThreadType, participants: string[], title?: string): Promise<Thread> {
      const id = crypto.randomUUID();
      const now = clock.timestamp();
      const participantsJson = JSON.stringify(participants.sort());

      await db.execute(
        `INSERT INTO threads (id, type, title, participants, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, type, title ?? null, participantsJson, now, now]
      );

      logger.debug("Thread created", { id, type, participants });

      return {
        id,
        type,
        title: title ?? null,
        participants: participants.sort(),
        createdAt: now,
        updatedAt: now,
      };
    },

    async addMessage(
      threadId: string,
      senderId: string,
      senderType: SenderType,
      content: string
    ): Promise<ThreadMessage> {
      const id = crypto.randomUUID();
      const now = clock.timestamp();

      await db.execute(
        `INSERT INTO thread_messages (id, thread_id, sender_id, sender_type, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, threadId, senderId, senderType, content, now]
      );

      // Update thread's updated_at timestamp
      await db.execute(
        `UPDATE threads SET updated_at = ? WHERE id = ?`,
        [now, threadId]
      );

      logger.debug("Message added to thread", { threadId, senderId, senderType });

      return {
        id,
        threadId,
        senderId,
        senderType,
        content,
        createdAt: now,
      };
    },

    async getThread(id: string): Promise<Thread | undefined> {
      const rows = await db.query<ThreadRow>(
        `SELECT id, type, title, participants, created_at, updated_at
         FROM threads WHERE id = ?`,
        [id]
      );
      if (rows.length === 0) return undefined;
      return rowToThread(rows[0]);
    },

    async getMessages(threadId: string, limit = 50, offset = 0): Promise<ThreadMessage[]> {
      const rows = await db.query<MessageRow>(
        `SELECT id, thread_id, sender_id, sender_type, content, created_at
         FROM thread_messages
         WHERE thread_id = ?
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`,
        [threadId, limit, offset]
      );
      return rows.map(rowToMessage);
    },

    async listThreads(participantId?: string): Promise<Thread[]> {
      if (participantId) {
        // Match threads where participant is in the JSON array
        // SQLite JSON: participants is stored as a JSON array string
        const rows = await db.query<ThreadRow>(
          `SELECT id, type, title, participants, created_at, updated_at
           FROM threads
           WHERE participants LIKE ?
           ORDER BY updated_at DESC`,
          [`%"${participantId}"%`]
        );
        return rows.map(rowToThread);
      }

      const rows = await db.query<ThreadRow>(
        `SELECT id, type, title, participants, created_at, updated_at
         FROM threads
         ORDER BY updated_at DESC`
      );
      return rows.map(rowToThread);
    },

    async shareThread(threadId: string, sharedWith: string, sharedBy: string): Promise<ThreadShare> {
      const now = clock.timestamp();

      await db.execute(
        `INSERT OR REPLACE INTO thread_shares (thread_id, shared_with, shared_by, shared_at)
         VALUES (?, ?, ?, ?)`,
        [threadId, sharedWith, sharedBy, now]
      );

      logger.debug("Thread shared", { threadId, sharedWith, sharedBy });

      return {
        threadId,
        sharedWith,
        sharedBy,
        sharedAt: now,
      };
    },

    async getSharedThreads(agentId: string): Promise<Thread[]> {
      const rows = await db.query<ThreadRow>(
        `SELECT t.id, t.type, t.title, t.participants, t.created_at, t.updated_at
         FROM threads t
         INNER JOIN thread_shares ts ON ts.thread_id = t.id
         WHERE ts.shared_with = ?
         ORDER BY t.updated_at DESC`,
        [agentId]
      );
      return rows.map(rowToThread);
    },

    async storePendingDm(senderId: string, content: string, recipientId = "user"): Promise<PendingDm> {
      const id = crypto.randomUUID();
      const now = clock.timestamp();

      await db.execute(
        `INSERT INTO pending_dms (id, sender_id, content, created_at, recipient_id)
         VALUES (?, ?, ?, ?, ?)`,
        [id, senderId, content, now, recipientId]
      );

      logger.debug("Pending DM stored", { id, senderId, recipientId });

      return { id, senderId, content, createdAt: now, recipientId };
    },

    async getPendingDms(recipientId = "user"): Promise<PendingDm[]> {
      const rows = await db.query<PendingDmRow>(
        `SELECT id, sender_id, content, created_at, recipient_id
         FROM pending_dms
         WHERE recipient_id = ?
         ORDER BY created_at ASC`,
        [recipientId]
      );
      return rows.map((r) => ({
        id: r.id,
        senderId: r.sender_id,
        content: r.content,
        createdAt: r.created_at,
        recipientId: r.recipient_id,
      }));
    },

    async clearPendingDms(recipientId = "user"): Promise<void> {
      await db.execute(
        `DELETE FROM pending_dms WHERE recipient_id = ?`,
        [recipientId]
      );
      logger.debug("Pending DMs cleared", { recipientId });
    },

    async findOrCreateThread(
      type: ThreadType,
      participants: string[],
      title?: string
    ): Promise<Thread> {
      const sorted = participants.sort();
      const participantsJson = JSON.stringify(sorted);

      // Try to find an existing thread with the same type and participants
      const rows = await db.query<ThreadRow>(
        `SELECT id, type, title, participants, created_at, updated_at
         FROM threads
         WHERE type = ? AND participants = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
        [type, participantsJson]
      );

      if (rows.length > 0) {
        return rowToThread(rows[0]);
      }

      // Create a new thread
      return this.createThread(type, sorted, title);
    },

    async getLastDmSentAt(agentId: string): Promise<string | null> {
      const rows = await db.query<{ created_at: string }>(
        `SELECT m.created_at
         FROM thread_messages m
         INNER JOIN threads t ON t.id = m.thread_id
         WHERE t.type = 'agent-dm' AND t.participants LIKE ? AND m.sender_id = ?
         ORDER BY m.created_at DESC
         LIMIT 1`,
        [`%"${agentId}"%`, agentId]
      );
      return rows.length > 0 ? rows[0].created_at : null;
    },

    async getMessagesForParticipantSince(
      participantId: string,
      sinceIso: string
    ): Promise<{ threadId: string; threadType: ThreadType; messages: ThreadMessage[] }[]> {
      const threads = await this.listThreads(participantId);
      const out: { threadId: string; threadType: ThreadType; messages: ThreadMessage[] }[] = [];
      for (const thread of threads) {
        const rows = await db.query<MessageRow>(
          `SELECT id, thread_id, sender_id, sender_type, content, created_at
           FROM thread_messages
           WHERE thread_id = ? AND created_at >= ?
           ORDER BY created_at ASC`,
          [thread.id, sinceIso]
        );
        if (rows.length > 0) {
          out.push({
            threadId: thread.id,
            threadType: thread.type,
            messages: rows.map(rowToMessage),
          });
        }
      }
      return out;
    },
  };
}
