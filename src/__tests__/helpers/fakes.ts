/**
 * Test fakes for FileSystemAdapter, HttpClient, EventBus and ProcessRunner.
 * All fakes are fully in-memory — no disk or network I/O.
 */
import nodePath from "path";
import type {
  FileSystemAdapter,
  HttpClient,
  HttpResponse,
  EventBus,
  ProcessRunner,
  AppContext,
} from "@/lib/context";
import type { SystemSSEEvent } from "@/lib/types";
import { makeTestDb } from "./db";

// ─── FakeFs ───────────────────────────────────────────────────────────────────

export class FakeFs implements FileSystemAdapter {
  private files = new Map<string, string>();

  seed(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  readFile(path: string): string {
    if (!this.files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return this.files.get(path)!;
  }

  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  appendFile(path: string, content: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + content);
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }

  listDir(dirPath: string): string[] {
    const sep = nodePath.sep;
    const prefix = dirPath.endsWith(sep) ? dirPath : dirPath + sep;
    return Array.from(this.files.keys())
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length).split(sep)[0])
      .filter((v, i, a) => a.indexOf(v) === i); // unique
  }

  rename(from: string, to: string): void {
    const content = this.readFile(from);
    this.files.set(to, content);
    this.files.delete(from);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  mkdirp(_path: string): void {
    // No-op in memory
  }

  /** Inspect — return all stored paths and their content */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}

// ─── FakeHttp ─────────────────────────────────────────────────────────────────

export type FakeHttpHandler = (url: string, init?: RequestInit) => Promise<FakeResponse>;

export class FakeResponse implements HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  private _body: string;
  readonly body: ReadableStream<Uint8Array> | null = null;

  constructor(status: number, body: string) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._body = body;
  }

  async text(): Promise<string> { return this._body; }
  async json(): Promise<unknown> { return JSON.parse(this._body); }
}

export class FakeHttp implements HttpClient {
  private handlers: Array<{ pattern: string | RegExp; handler: FakeHttpHandler }> = [];

  /** Register a handler for URLs matching the given string or regex */
  on(pattern: string | RegExp, handler: FakeHttpHandler): this {
    this.handlers.push({ pattern, handler });
    return this;
  }

  /** Convenience: respond with a fixed JSON body */
  onJson(pattern: string | RegExp, status: number, body: unknown): this {
    return this.on(pattern, async () => new FakeResponse(status, JSON.stringify(body)));
  }

  async fetch(url: string, init?: RequestInit): Promise<HttpResponse> {
    for (const { pattern, handler } of this.handlers) {
      const matches =
        typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
      if (matches) return handler(url, init);
    }
    throw new Error(`FakeHttp: no handler for ${url}`);
  }
}

// ─── FakeEvents ───────────────────────────────────────────────────────────────

export class FakeEvents implements EventBus {
  emitted: SystemSSEEvent[] = [];
  private listeners = new Set<(event: SystemSSEEvent) => void>();

  emit(event: SystemSSEEvent): void {
    this.emitted.push(event);
    for (const l of this.listeners) l(event);
  }

  subscribe(listener: (event: SystemSSEEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reset captured events between tests */
  reset(): void {
    this.emitted = [];
  }
}

// ─── FakeProcessRunner ─────────────────────────────────────────────────────────

/**
 * In-memory ProcessRunner for tests. Configure via onExec() to return
 * fixed stdout/stderr/exitCode or to assert on the command.
 */
export class FakeProcessRunner implements ProcessRunner {
  private handler: (
    cmd: string,
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }> = async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });

  /** Last command and options passed to exec (for assertions). */
  lastExec: { cmd: string; opts?: { cwd?: string; timeout?: number } } | null = null;

  /**
   * Set the handler for exec(). Handler receives cmd and opts, returns result.
   */
  onExec(
    handler: (
      cmd: string,
      opts?: { cwd?: string; timeout?: number },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  ): this {
    this.handler = handler;
    return this;
  }

  /** Convenience: always return the given result for any exec call. */
  setResult(result: { stdout: string; stderr: string; exitCode: number }): this {
    this.handler = async () => result;
    return this;
  }

  async exec(
    cmd: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.lastExec = { cmd, opts };
    return this.handler(cmd, opts);
  }
}

// ─── makeTestContext ──────────────────────────────────────────────────────────

/**
 * Build a complete AppContext with fresh in-memory dependencies.
 * Pass overrides to replace individual adapters.
 */
export function makeTestContext(overrides: Partial<AppContext> = {}): AppContext {
  return {
    db: makeTestDb(),
    fs: new FakeFs(),
    http: new FakeHttp(),
    events: new FakeEvents(),
    processRunner: new FakeProcessRunner(),
    sandboxContainerName: "test-sandbox",
    ...overrides,
  };
}
