/**
 * @fileoverview Sandbox path resolution for Maia. All agent-accessible paths live under ~/.maia.
 * @module lib/sandbox
 */

import os from "node:os";
import path from "node:path";

/**
 * Resolves the Maia sandbox root directory.
 * @brief Uses MAIA_HOME if set, otherwise ~/.maia
 * @param env - Process env (default process.env)
 * @param homedir - Function returning home dir (default os.homedir)
 * @returns Absolute path to sandbox root
 */
export function resolveSandboxRoot(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
  homedir: () => string = os.homedir
): string {
  const home = homedir();
  const maiaHome = (env.MAIA_HOME ?? "").trim();
  if (maiaHome !== "") {
    return path.isAbsolute(maiaHome) ? maiaHome : path.join(home, maiaHome);
  }
  return path.join(home, ".maia");
}

/**
 * Resolves a path under the sandbox, ensuring it does not escape.
 * @brief Rejects if the resolved path is outside the sandbox root.
 * @param sandboxRoot - Sandbox root (e.g. from resolveSandboxRoot)
 * @param requestedPath - Path relative to sandbox or absolute within sandbox
 * @returns Resolved absolute path under sandbox, or null if escape attempt
 */
export function resolveWithinSandbox(
  sandboxRoot: string,
  requestedPath: string
): string | null {
  const normalizedRoot = path.normalize(path.resolve(sandboxRoot));
  const resolved = path.resolve(normalizedRoot, requestedPath);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}
