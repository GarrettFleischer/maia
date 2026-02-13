/**
 * @fileoverview Append-only security audit log. Persists events as JSON lines for
 * reliable parsing, maintains an in-memory copy for fast reads, and supports
 * filtering by type, since date, and limit.
 * @module security/audit-log
 */

import type {
  AuditEntry,
  AuditEventType,
  AuditLog,
  Clock,
  FileSystem,
} from "../core/types.js";

/** @brief Dependencies for createAuditLog */
export interface AuditLogDeps {
  fs: FileSystem;
  clock: Clock;
  logPath: string;
}

/** @brief Options for read() filtering */
export interface AuditReadOptions {
  since?: Date;
  type?: AuditEventType;
  limit?: number;
}

/** @brief JSON line format for each stored entry */
interface StoredEntry {
  timestamp: string;
  type: AuditEventType;
  metadata: Record<string, unknown>;
}

/**
 * @brief Creates an append-only audit log with in-memory cache for fast reads.
 * @param deps - Dependencies: fs, clock, logPath
 * @returns Object implementing the AuditLog interface
 */
export function createAuditLog(deps: AuditLogDeps): AuditLog {
  const { fs, clock, logPath } = deps;
  let entries: AuditEntry[] = [];
  let loaded = false;

  async function ensureLogExists(): Promise<void> {
    const exists = await fs.exists(logPath);
    if (!exists) {
      const lastSep = Math.max(logPath.lastIndexOf("/"), logPath.lastIndexOf("\\"));
      if (lastSep > 0) {
        const dir = logPath.slice(0, lastSep);
        try {
          await fs.mkdir(dir);
        } catch {
          /* directory may already exist */
        }
      }
      await fs.writeFile(logPath, "");
    }
  }

  async function loadEntries(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const exists = await fs.exists(logPath);
    if (!exists) {
      entries = [];
      return;
    }
    const raw = await fs.readFile(logPath);
    entries = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const stored: StoredEntry = JSON.parse(line);
        return {
          timestamp: stored.timestamp,
          type: stored.type,
          metadata: stored.metadata ?? {},
        } as AuditEntry;
      });
  }

  return {
    /**
     * @brief Appends formatted JSON line to log file and in-memory copy.
     * @param event - Audit event type
     * @param metadata - Key-value metadata for the event
     */
    async log(event: AuditEventType, metadata: Record<string, unknown>): Promise<void> {
      await ensureLogExists();
      await loadEntries();
      const timestamp = clock.timestamp();
      const stored: StoredEntry = { timestamp, type: event, metadata };
      const line = JSON.stringify(stored) + "\n";
      await fs.appendFile(logPath, line);
      entries.push({ timestamp, type: event, metadata });
    },

    /**
     * @brief Parses log file and returns AuditEntry[] with optional filtering.
     * @param options - Optional filter: type, since date, limit
     * @returns Promise resolving to array of audit entries
     */
    async read(options?: AuditReadOptions): Promise<AuditEntry[]> {
      await loadEntries();

      let result = [...entries];

      if (options?.since) {
        const sinceMs = options.since.getTime();
        result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
      }

      if (options?.type) {
        result = result.filter((e) => e.type === options.type);
      }

      if (options?.limit !== undefined && options.limit > 0) {
        result = result.slice(-options.limit);
      }

      return result;
    },
  };
}
