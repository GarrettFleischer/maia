/**
 * @fileoverview Real HTTP client adapter wrapping the global fetch API.
 * @module adapters/http-client
 *
 * @note Uses the global fetch() available in Bun. Supports timeout
 * via AbortSignal.timeout(). Maps Response headers to a plain object.
 */

import type { HttpClient, HttpRequestOptions, HttpResponse } from "../core/types.js";

/**
 * @brief Creates a real HTTP client backed by the global fetch API.
 * @returns HttpClient implementation using fetch()
 *
 * @example
 * const http = createRealHttpClient();
 * const res = await http.fetch("https://api.example.com/data");
 * console.log(res.status, res.body);
 */
export function createRealHttpClient(): HttpClient {
  return {
    /**
     * @brief Performs an HTTP request using the global fetch API.
     * @param url - Full URL to fetch
     * @param options - Optional request options (method, headers, body, timeout)
     * @returns HttpResponse with status, headers, body, and ok flag
     * @throws If the request is aborted (timeout) or a network error occurs
     */
    async fetch(url: string, options?: HttpRequestOptions): Promise<HttpResponse> {
      const fetchOptions: RequestInit = {};

      if (options?.method) {
        fetchOptions.method = options.method;
      }

      if (options?.headers) {
        fetchOptions.headers = options.headers;
      }

      if (options?.body) {
        fetchOptions.body = options.body;
      }

      // Handle abort signals: combine user signal with timeout signal
      if (options?.timeout || options?.signal) {
        if (options?.timeout && options?.signal) {
          // Combine both signals
          const timeoutSignal = AbortSignal.timeout(options.timeout);
          fetchOptions.signal = AbortSignal.any([options.signal, timeoutSignal]);
        } else if (options?.timeout) {
          fetchOptions.signal = AbortSignal.timeout(options.timeout);
        } else if (options?.signal) {
          fetchOptions.signal = options.signal;
        }
      }

      const response = await globalThis.fetch(url, fetchOptions);

      // Convert Headers to plain object
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const body = await response.text();

      return {
        status: response.status,
        headers,
        body,
        ok: response.ok,
      };
    },
  };
}
