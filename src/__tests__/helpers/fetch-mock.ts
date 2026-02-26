/**
 * @fileoverview Mock global fetch for component tests (RTL). Install handlers, then restore.
 * @module __tests__/helpers/fetch-mock
 *
 * @note Use in beforeEach/afterEach so fetch is restored after each test.
 */

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Build a Response with JSON body and optional status. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a Response that is a ReadableStream (e.g. for SSE). */
export function streamResponse(
  chunks: string[],
  contentType = "text/event-stream"
): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": contentType },
  });
}

const originalFetch = globalThis.fetch;

/** Install a mock fetch. Handlers are tried in order; first matching URL wins. */
export function installFetchMock(
  handlers: Array<{ url: string | RegExp; handler: FetchHandler }>
): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    let urlStr: string;
    let initPass: RequestInit | undefined;
    if (url instanceof Request) {
      urlStr = url.url;
      try {
        const body = await url.clone().text();
        initPass = { method: url.method, headers: url.headers, body };
      } catch {
        initPass = { method: url.method, headers: url.headers };
      }
    } else {
      urlStr = typeof url === "string" ? url : url.toString();
      initPass = init;
    }
    for (const { url: pattern, handler } of handlers) {
      const matches =
        typeof pattern === "string" ? urlStr.includes(pattern) : pattern.test(urlStr);
      if (matches) return handler(urlStr, initPass);
    }
    throw new Error(`fetch-mock: no handler for ${urlStr}`);
  }) as typeof fetch;
}

/** Restore the original global fetch. */
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}
