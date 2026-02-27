/**
 * AppContext — single dependency-injection container threaded through the
 * entire application.  Every module that needs I/O receives an AppContext
 * instead of importing globals directly.
 *
 * Production wiring lives in src/instrumentation.ts.
 * Test wiring lives in src/__tests__/helpers/.
 */
import { exec } from "child_process";
import { promisify } from "util";
import type { SystemSSEEvent } from "./types";

const execAsync = promisify(exec);

// ─── Database adapter ─────────────────────────────────────────────────────────

/**
 * Structural interface matching the subset of better-sqlite3's Database API
 * actually used by this codebase. This allows tests to substitute bun:sqlite.
 */
export interface DbStatement {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface DbAdapter {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  pragma(pragma: string, options?: unknown): unknown;
}

// ─── FileSystem adapter ───────────────────────────────────────────────────────

export interface FileSystemAdapter {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  appendFile(path: string, content: string): void;
  deleteFile(path: string): void;
  listDir(path: string): string[];
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

// ─── HTTP client adapter ──────────────────────────────────────────────────────

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}

export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<HttpResponse>;
}

// ─── Event bus adapter ────────────────────────────────────────────────────────

export interface EventBus {
  emit(event: SystemSSEEvent): void;
  subscribe(listener: (event: SystemSSEEvent) => void): () => void;
}

// ─── Process runner adapter ───────────────────────────────────────────────────

/**
 * Options for process execution (e.g. timeout, cwd).
 * Used by the terminal tool when running commands in the sandbox container.
 */
export interface ExecOptions {
  /** Working directory (for process runners that support it). */
  cwd?: string;
  /** Timeout in milliseconds. */
  timeout?: number;
}

/**
 * Runs a shell command and returns stdout, stderr, and exit code.
 * Production implementation uses child_process.exec; tests use a fake.
 */
export interface ProcessRunner {
  exec(
    cmd: string,
    opts?: ExecOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ─── AppContext ───────────────────────────────────────────────────────────────

/**
 * Minimal page interface for one-off browser (fetch_web_page).
 * Used by tests to inject a fake; production uses Playwright Page.
 */
export interface OneOffBrowserPage {
  goto(url: string): Promise<void>;
  evaluate<R>(pageFunction: () => R): Promise<R>;
}

/**
 * One-off browser launcher for fetch_web_page. When provided (e.g. in tests), fetch_web_page uses it instead of real Playwright.
 */
export type LaunchOneOffBrowser = () => Promise<{
  page: OneOffBrowserPage;
  close(): Promise<void>;
}>;

/**
 * Session browser getter for browser_* tools. When provided (e.g. in tests), tools use it instead of getOrCreatePage from browser-session.
 */
export type GetBrowserPage = (
  sessionId: string
) => Promise<{ browser: { close(): Promise<void> }; page: import("playwright").Page }>;

export interface AppContext {
  db: DbAdapter;
  fs: FileSystemAdapter;
  http: HttpClient;
  events: EventBus;
  /** Runs shell commands (e.g. docker exec). Injected for testability. */
  processRunner: ProcessRunner;
  /** Sandbox container name for terminal_exec. Defaults to maia-sandbox if unset. */
  sandboxContainerName?: string;
  /** Optional one-off browser launcher for fetch_web_page. When set (e.g. in tests), fetch_web_page uses it instead of launching real Playwright. */
  launchOneOffBrowser?: LaunchOneOffBrowser;
  /** Optional session browser getter for browser_* tools. When set (e.g. in tests), tools use it instead of getOrCreatePage. */
  getBrowserPage?: GetBrowserPage;
}

// ─── Production adapters ──────────────────────────────────────────────────────

import nodeFs from "fs";
import { fetch as undiciFetch, Agent } from "undici";

export function makeNodeFsAdapter(): FileSystemAdapter {
  return {
    readFile: (p) => nodeFs.readFileSync(p, "utf8"),
    writeFile: (p, c) => nodeFs.writeFileSync(p, c, "utf8"),
    appendFile: (p, c) => nodeFs.appendFileSync(p, c, "utf8"),
    deleteFile: (p) => nodeFs.rmSync(p, { recursive: false }),
    listDir: (p) => nodeFs.readdirSync(p),
    rename: (f, t) => nodeFs.renameSync(f, t),
    exists: (p) => nodeFs.existsSync(p),
    mkdirp: (p) => { nodeFs.mkdirSync(p, { recursive: true }); },
  };
}

/**
 * Long-timeout Undici agent used for Ollama chat/embed and other HTTP calls.
 * Uses a very large headersTimeout so slow models have ample time to respond.
 */
const LONG_TIMEOUT_AGENT = new Agent({
  // Allow up to 10 minutes for response headers (in milliseconds).
  headersTimeout: 600_000,
  // Disable body timeout so large responses are not cut off prematurely.
  bodyTimeout: 0,
});

export function makeNativeFetchClient(): HttpClient {
  return {
    fetch: (url, init) => {
      const opts = init ?? {};
      const body = opts.body === null ? undefined : opts.body;
      const undiciInit = { ...opts, body, dispatcher: LONG_TIMEOUT_AGENT } as Parameters<
        typeof undiciFetch
      >[1];
      return undiciFetch(url, undiciInit) as Promise<HttpResponse>;
    },
  };
}

// ─── Process runner (production) ───────────────────────────────────────────────

/**
 * Production ProcessRunner using Node.js child_process.exec.
 * @returns ProcessRunner that runs commands with optional timeout.
 */
export function makeNodeProcessRunner(): ProcessRunner {
  return {
    async exec(cmd, opts) {
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          timeout: opts?.timeout,
          cwd: opts?.cwd,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(err),
          exitCode: e.code ?? 1,
        };
      }
    },
  };
}
