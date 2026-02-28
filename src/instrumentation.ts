// Next.js instrumentation hook — runs once on server startup (not during build)
import type { AppContext } from "./lib/context";

let _appCtx: AppContext | null = null;
let _registerPromise: Promise<void> | null = null;

/** Returns the production AppContext — only valid after register() has run. */
export function getAppContext(): AppContext {
  if (!_appCtx) throw new Error("AppContext not yet initialized");
  return _appCtx;
}

/**
 * Returns the AppContext, running register() once if not yet initialized.
 * Use in route handlers when the process may handle requests before instrumentation ran (e.g. dev workers).
 * After resolving, ticks the LLM queue processor once so jobs are processed even when the
 * instrumentation timer is not running in this process.
 */
export async function ensureAppContext(): Promise<AppContext> {
  if (_appCtx) {
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const node = await import("./instrumentation-node");
      node.tickQueueProcessor();
    }
    return _appCtx;
  }
  if (!_registerPromise) _registerPromise = register();
  await _registerPromise;
  if (!_appCtx) throw new Error("AppContext not yet initialized");
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const node = await import("./instrumentation-node");
    node.tickQueueProcessor();
  }
  return _appCtx;
}

/**
 * Inject a test AppContext. For use in API route tests only.
 * @internal
 */
export function _setTestContext(ctx: AppContext): void {
  _appCtx = ctx;
}

export async function register() {
  if (_appCtx) return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    _appCtx = await registerNode();
  }
}
