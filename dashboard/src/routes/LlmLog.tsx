/**
 * @fileoverview LLM prompt/response log page with filters and expandable rows.
 * @module routes/LlmLog
 */

import { useEffect, useState } from "preact/hooks";
import { fetchLlmCalls } from "../lib/api-client.js";
import type { LlmCall } from "../lib/types.js";

interface LlmLogProps {
  path?: string;
}

/**
 * @brief Summary line for an LLM call (first user message + response length).
 */
function callSummary(call: LlmCall): string {
  const lastUser = [...call.requestMessages].reverse().find((m) => m.role === "user");
  const userPreview = lastUser
    ? (lastUser.content.slice(0, 60) + (lastUser.content.length > 60 ? "…" : ""))
    : "(no user message)";
  const respLen = call.responseContent?.length ?? 0;
  return `${userPreview} → ${respLen} chars`;
}

/**
 * @brief Single row: summary + expandable full request/response.
 */
function LlmCallRow({ call }: { call: LlmCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="border-b border-maia-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        class="w-full flex items-center gap-3 px-4 py-2 text-left text-sm text-maia-text hover:bg-maia-surface-light/50"
      >
        <span class="text-maia-text-dim shrink-0">{expanded ? "▼" : "▶"}</span>
        <span class="shrink-0 text-maia-text-dim">
          {new Date(call.createdAt).toLocaleString()}
        </span>
        <span class="font-mono text-maia-accent shrink-0">{call.agentId}</span>
        {call.threadId && (
          <span class="text-maia-text-dim shrink-0 truncate max-w-32" title={call.threadId}>
            thread:{call.threadId.slice(0, 8)}…
          </span>
        )}
        <span class="truncate flex-1 text-maia-text-dim">{callSummary(call)}</span>
      </button>
      {expanded && (
        <div class="px-4 pb-4 pt-0 space-y-3 bg-maia-bg/50">
          <div>
            <div class="text-xs font-medium text-maia-text-dim mb-1">Request messages</div>
            <pre class="text-xs overflow-x-auto max-h-48 overflow-y-auto p-3 bg-maia-surface rounded-lg whitespace-pre-wrap wrap-break-word text-maia-text">
              {JSON.stringify(call.requestMessages, null, 2)}
            </pre>
          </div>
          <div>
            <div class="text-xs font-medium text-maia-text-dim mb-1">Response content</div>
            <pre class="text-xs overflow-x-auto max-h-48 overflow-y-auto p-3 bg-maia-surface rounded-lg whitespace-pre-wrap wrap-break-word text-maia-text">
              {call.responseContent || "(empty)"}
            </pre>
          </div>
          {call.responseToolCalls && call.responseToolCalls.length > 0 && (
            <div>
              <div class="text-xs font-medium text-maia-text-dim mb-1">Tool calls</div>
              <pre class="text-xs overflow-x-auto max-h-32 overflow-y-auto p-3 bg-maia-surface rounded-lg whitespace-pre-wrap wrap-break-word text-maia-text">
                {JSON.stringify(call.responseToolCalls, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * @brief LLM log page listing prompts and responses with filters.
 * @returns Preact element
 */
export function LlmLog(_props: LlmLogProps) {
  const [calls, setCalls] = useState<LlmCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState("");
  const [threadFilter, setThreadFilter] = useState("");
  const [sinceFilter, setSinceFilter] = useState("");
  const [limit, setLimit] = useState(50);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchLlmCalls({
        agentId: agentFilter.trim() || undefined,
        threadId: threadFilter.trim() || undefined,
        since: sinceFilter.trim() || undefined,
        limit,
      });
      setCalls(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [agentFilter, threadFilter, sinceFilter, limit]);

  if (loading && calls.length === 0) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">LLM log</h1>
        <p class="text-maia-text-dim">Loading LLM calls...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">LLM log</h1>
        <p class="text-maia-error">{error}</p>
      </div>
    );
  }

  return (
    <div class="p-6 max-w-6xl">
      <h1 class="text-2xl font-semibold text-maia-text mb-6">LLM log</h1>

      <div class="flex flex-wrap items-center gap-3 mb-4">
        <label class="text-sm text-maia-text-dim">
          Agent:
          <input
            type="text"
            value={agentFilter}
            onInput={(e) => setAgentFilter((e.target as HTMLInputElement).value)}
            placeholder="e.g. maia"
            class="ml-2 w-28 bg-maia-surface border border-maia-border rounded-lg px-2 py-1 text-maia-text text-sm"
          />
        </label>
        <label class="text-sm text-maia-text-dim">
          Thread ID:
          <input
            type="text"
            value={threadFilter}
            onInput={(e) => setThreadFilter((e.target as HTMLInputElement).value)}
            placeholder="optional"
            class="ml-2 w-40 bg-maia-surface border border-maia-border rounded-lg px-2 py-1 text-maia-text text-sm"
          />
        </label>
        <label class="text-sm text-maia-text-dim">
          Since (ISO):
          <input
            type="text"
            value={sinceFilter}
            onInput={(e) => setSinceFilter((e.target as HTMLInputElement).value)}
            placeholder="optional"
            class="ml-2 w-44 bg-maia-surface border border-maia-border rounded-lg px-2 py-1 text-maia-text text-sm"
          />
        </label>
        <label class="text-sm text-maia-text-dim">
          Limit:
          <select
            value={limit}
            onInput={(e) => setLimit(parseInt((e.target as HTMLSelectElement).value, 10))}
            class="ml-2 bg-maia-surface border border-maia-border rounded-lg px-2 py-1 text-maia-text"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={250}>250</option>
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

      {calls.length === 0 ? (
        <div class="bg-maia-surface border border-maia-border rounded-xl p-8 text-center">
          <p class="text-maia-text-dim">No LLM calls found.</p>
        </div>
      ) : (
        <div class="bg-maia-surface border border-maia-border rounded-xl overflow-hidden">
          <div class="overflow-x-auto max-h-[70vh] overflow-y-auto">
            {calls.map((call) => (
              <LlmCallRow key={call.id} call={call} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
