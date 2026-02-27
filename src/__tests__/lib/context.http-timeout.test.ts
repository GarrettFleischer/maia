/**
 * @fileoverview Sanity checks for the long-timeout HttpClient wrapper.
 * @module __tests__/lib/context.http-timeout.test
 */
import { describe, it, expect } from "bun:test";
import { makeNativeFetchClient } from "@/lib/context";

describe("makeNativeFetchClient", () => {
  it("returns an HttpClient with a fetch function", () => {
    const client = makeNativeFetchClient();
    expect(typeof client.fetch).toBe("function");
  });
});

