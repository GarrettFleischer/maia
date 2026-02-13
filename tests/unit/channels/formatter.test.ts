/**
 * @fileoverview Unit tests for channel-specific message formatting.
 * @module tests/unit/channels/formatter
 */

import { describe, it, expect } from "bun:test";
import { createMessageFormatter } from "../../../src/channels/formatter.js";

describe("Message Formatter", () => {
  describe("Discord Formatter", () => {
    it("should convert headers to bold text", () => {
      const formatter = createMessageFormatter("discord");
      const result = formatter.format("# Hello World");
      expect(result).not.toContain("# ");
      expect(result).toContain("**Hello World**");
    });

    it("should wrap links in angle brackets", () => {
      const formatter = createMessageFormatter("discord");
      const result = formatter.format("Check https://example.com for more.");
      expect(result).toContain("<https://example.com>");
    });

    it("should split messages longer than 2000 chars", () => {
      const formatter = createMessageFormatter("discord");
      const longMessage = "x".repeat(3000);
      const parts = formatter.splitIfNeeded(longMessage, 2000);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0].length).toBeLessThanOrEqual(2000);
    });
  });

  describe("Telegram Formatter", () => {
    it("should convert markdown bold to HTML bold", () => {
      const formatter = createMessageFormatter("telegram");
      const result = formatter.format("**bold text**");
      expect(result).toContain("<b>bold text</b>");
    });

    it("should convert markdown italic to HTML italic", () => {
      const formatter = createMessageFormatter("telegram");
      const result = formatter.format("*italic text*");
      expect(result).toContain("<i>italic text</i>");
    });

    it("should convert markdown code to HTML code", () => {
      const formatter = createMessageFormatter("telegram");
      const result = formatter.format("`inline code`");
      expect(result).toContain("<code>inline code</code>");
    });

    it("should split messages longer than 4096 chars", () => {
      const formatter = createMessageFormatter("telegram");
      const longMessage = "x".repeat(5000);
      const parts = formatter.splitIfNeeded(longMessage, 4096);
      expect(parts.length).toBeGreaterThan(1);
    });
  });

  describe("CLI Formatter", () => {
    it("should pass through markdown content", () => {
      const formatter = createMessageFormatter("cli");
      const input = "# Header\n\n**bold** and *italic*";
      const result = formatter.format(input);
      expect(result).toContain("Header");
    });

    it("should not split messages (no limit)", () => {
      const formatter = createMessageFormatter("cli");
      const longMessage = "x".repeat(100000);
      const parts = formatter.splitIfNeeded(longMessage, Infinity);
      expect(parts).toHaveLength(1);
    });
  });

  describe("WebChat Formatter", () => {
    it("should pass through markdown/HTML content", () => {
      const formatter = createMessageFormatter("webchat");
      const input = "# Hello\n\nThis is **bold**.";
      const result = formatter.format(input);
      expect(result).toContain("Hello");
      expect(result).toContain("bold");
    });
  });
});
