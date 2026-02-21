// Next.js instrumentation hook — runs once on server startup (not during build)
import type { AppContext } from "./lib/context";

let _appCtx: AppContext | null = null;

/** Returns the production AppContext — only valid after register() has run. */
export function getAppContext(): AppContext {
  if (!_appCtx) throw new Error("AppContext not yet initialized");
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
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("./lib/db");
    const {
      makeNodeFsAdapter,
      makeNativeFetchClient,
      makeNodeProcessRunner,
    } = await import("./lib/context");
    const { globalEventBus } = await import("./lib/events");
    const { initMaiaAgent } = await import("./lib/init");

    _appCtx = {
      db: getDb(),
      fs: makeNodeFsAdapter(),
      http: makeNativeFetchClient(),
      events: globalEventBus,
      processRunner: makeNodeProcessRunner(),
      sandboxContainerName: process.env.SANDBOX_CONTAINER_NAME ?? "maia-sandbox",
    };

    initMaiaAgent(_appCtx);
  }
}
