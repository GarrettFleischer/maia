/** Honest leaf: drop Working-strip timer keys that are no longer visible. */
export function pruneActivityStartedKeys(
  started: Map<string, number>,
  visibleKeys: ReadonlySet<string>,
): void {
  for (const key of [...started.keys()]) {
    if (!visibleKeys.has(key)) started.delete(key)
  }
}

export function activityLineKey(line: { seq: number; task_id?: string }): string {
  return line.task_id ?? `router-${line.seq}`
}
