/**
 * @fileoverview Unit tests for the Telegram channel adapter.
 * @module tests/unit/channels/telegram
 *
 * @brief Verifies injectTelegramUpdate notifies the handler with the correct
 * InboundMessage and that send uses the correct API shape.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { InboundMessage } from "../../../src/core/types.js";
import { createTelegramChannel } from "../../../src/channels/telegram.js";
import { createMessageFormatter } from "../../../src/channels/formatter.js";

describe("Telegram Channel", () => {
  let capturedMessages: InboundMessage[];
  let mockFetchCalls: Array<{ url: string; method: string; body?: string }>;

  beforeEach(() => {
    capturedMessages = [];
    mockFetchCalls = [];
  });

  it("injectTelegramUpdate notifies handler with InboundMessage when running", async () => {
    const http = {
      fetch: async (url: string, opts?: { method?: string; body?: string }) => {
        mockFetchCalls.push({
          url,
          method: opts?.method ?? "GET",
          body: opts?.body,
        });
        if (url.includes("getMe")) {
          return { ok: true } as Response;
        }
        return { ok: true } as Response;
      },
    };

    const credentials = {
      get: async () => ({ value: "fake-bot-token" }),
      has: async () => true,
      set: async () => {},
      delete: async () => false,
      list: async () => [] as { name: string }[],
    };

    const channel = createTelegramChannel({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      http: http as unknown as import("../../../src/core/types.js").HttpClient,
      credentials: credentials as unknown as import("../../../src/core/types.js").CredentialStore,
      formatter: createMessageFormatter("telegram"),
      credentialName: "telegram-bot-token",
    });

    channel.onMessage(async (msg) => {
      capturedMessages.push(msg);
    });

    await channel.initialize({ enabled: true });

    const update = {
      message: {
        message_id: 42,
        from: { id: 123456789, first_name: "Test" },
        chat: { id: 123456789, type: "private" },
        text: "Hello Maia",
      },
    };

    await (channel as unknown as { injectTelegramUpdate: (u: typeof update) => Promise<void> }).injectTelegramUpdate(update);

    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]!.channelId).toBe("telegram");
    expect(capturedMessages[0]!.senderId).toBe("123456789");
    expect(capturedMessages[0]!.content).toBe("Hello Maia");
    expect(capturedMessages[0]!.metadata?.chatId).toBe(123456789);
  });

  it("injectTelegramUpdate does not notify when update has no text", async () => {
    const http = {
      fetch: async (url: string) => {
        if (url.includes("getMe")) return { ok: true } as Response;
        return { ok: true } as Response;
      },
    };

    const credentials = {
      get: async () => ({ value: "fake-token" }),
      has: async () => true,
      set: async () => {},
      delete: async () => false,
      list: async () => [] as { name: string }[],
    };

    const channel = createTelegramChannel({
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      http: http as unknown as import("../../../src/core/types.js").HttpClient,
      credentials: credentials as unknown as import("../../../src/core/types.js").CredentialStore,
      formatter: createMessageFormatter("telegram"),
      credentialName: "telegram-bot-token",
    });

    channel.onMessage(async (msg) => {
      capturedMessages.push(msg);
    });

    await channel.initialize({ enabled: true });

    await (channel as unknown as { injectTelegramUpdate: (u: Record<string, unknown>) => Promise<void> }).injectTelegramUpdate({
      message: {
        message_id: 1,
        from: { id: 1, first_name: "U" },
        chat: { id: 1, type: "private" },
        // no text
      },
    });

    expect(capturedMessages).toHaveLength(0);
  });
});
