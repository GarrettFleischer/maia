/**
 * @fileoverview Serializes async work per session id; supports reentrant calls (e.g. persona_run inside Maia tools).
 * @module lib/history/session-lock
 */

const chains = new Map<string, Promise<unknown>>();
/** Depth of nested `runExclusive` calls while a session's queued job is running (not concurrent callers). */
const reentrantDepth = new Map<string, number>();

/**
 * @brief Runs `fn` after any prior exclusive work for `sessionId` has finished. Nested calls for the same session run immediately (reentrant).
 * @param sessionId - Session to serialize on
 * @param fn - Async work (e.g. runAgent)
 * @returns Result of fn
 */
export function runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  if ((reentrantDepth.get(sessionId) ?? 0) > 0) {
    reentrantDepth.set(sessionId, (reentrantDepth.get(sessionId) ?? 0) + 1);
    return Promise.resolve(fn()).finally(() => {
      reentrantDepth.set(sessionId, (reentrantDepth.get(sessionId) ?? 1) - 1);
    }) as Promise<T>;
  }

  const prev = chains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(() => {
    reentrantDepth.set(sessionId, 1);
    return Promise.resolve(fn()).finally(() => {
      reentrantDepth.set(sessionId, 0);
    });
  });
  chains.set(sessionId, next);
  return next.finally(() => {
    if (chains.get(sessionId) === next) {
      chains.delete(sessionId);
    }
  }) as Promise<T>;
}
