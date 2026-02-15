/**
 * @fileoverview Audit trail page listing audit log entries with filters.
 * @module routes/Audit
 */

import { useEffect, useState } from "preact/hooks";
import { fetchAuditEntries } from "../lib/api-client.js";
import type { AuditEntry } from "../lib/types.js";

interface AuditProps {
  path?: string;
}

/**
 * @brief Audit trail page showing audit log entries (e.g. TOOL_EXECUTION).
 * @returns Preact element
 */
export function Audit(_props: AuditProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [limit, setLimit] = useState(100);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAuditEntries({
        type: typeFilter || undefined,
        limit,
      });
      setEntries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [typeFilter, limit]);

  if (loading && entries.length === 0) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">Audit trail</h1>
        <p class="text-maia-text-dim">Loading audit entries...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">Audit trail</h1>
        <p class="text-maia-error">{error}</p>
      </div>
    );
  }

  return (
    <div class="p-6 max-w-6xl">
      <h1 class="text-2xl font-semibold text-maia-text mb-6">Audit trail</h1>

      <div class="flex flex-wrap items-center gap-3 mb-4">
        <label class="text-sm text-maia-text-dim">
          Type:
          <select
            value={typeFilter}
            onInput={(e) => setTypeFilter((e.target as HTMLSelectElement).value)}
            class="ml-2 bg-maia-surface border border-maia-border rounded-lg px-2 py-1 text-maia-text"
          >
            <option value="">All</option>
            <option value="TOOL_EXECUTION">TOOL_EXECUTION</option>
            <option value="TOOL_CALL">TOOL_CALL</option>
            <option value="AUTH_SUCCESS">AUTH_SUCCESS</option>
            <option value="AUTH_FAILURE">AUTH_FAILURE</option>
          </select>
        </label>
        <label class="text-sm text-maia-text-dim">
          Limit:
          <select
            value={limit}
            onInput={(e) => setLimit(parseInt((e.target as HTMLSelectElement).value, 10))}
            class="ml-2 bg-maia-surface border border-maia-border rounded-lg px-2 py-1 text-maia-text"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
            <option value={500}>500</option>
          </select>
        </label>
        <button
          type="button"
          onClick={load}
          class="px-3 py-1.5 bg-maia-surface border border-maia-border rounded-lg text-sm text-maia-text hover:bg-maia-surface-light"
        >
          Refresh
        </button>
      </div>

      {entries.length === 0 ? (
        <div class="bg-maia-surface border border-maia-border rounded-xl p-8 text-center">
          <p class="text-maia-text-dim">No audit entries found.</p>
        </div>
      ) : (
        <div class="bg-maia-surface border border-maia-border rounded-xl overflow-hidden">
          <div class="overflow-x-auto max-h-[70vh] overflow-y-auto">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-maia-surface-light border-b border-maia-border">
                <tr class="text-left text-maia-text-dim">
                  <th class="px-4 py-2 font-medium">Timestamp</th>
                  <th class="px-4 py-2 font-medium">Type</th>
                  <th class="px-4 py-2 font-medium">Metadata</th>
                </tr>
              </thead>
              <tbody class="text-maia-text">
                {entries.map((entry, i) => (
                  <tr
                    key={`${entry.timestamp}-${i}`}
                    class="border-b border-maia-border/50 hover:bg-maia-surface-light/50"
                  >
                    <td class="px-4 py-2 whitespace-nowrap text-maia-text-dim">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td class="px-4 py-2 font-mono text-maia-accent">{entry.type}</td>
                    <td class="px-4 py-2">
                      <pre class="text-xs overflow-x-auto max-w-xl whitespace-pre-wrap break-words">
                        {JSON.stringify(entry.metadata, null, 0)}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
