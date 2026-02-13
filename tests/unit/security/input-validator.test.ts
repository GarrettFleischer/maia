/**
 * @fileoverview Unit tests for Zod-based request validation.
 * @module tests/unit/security/input-validator
 */

import { describe, it, expect } from "bun:test";
import { validateChatRequest, validateMemoryStoreRequest, validateMemorySearchRequest } from "../../../src/security/input-validator.js";

describe("Input Validator", () => {
  describe("Chat Request", () => {
    it("should accept a valid chat request", () => {
      const result = validateChatRequest({
        message: "Hello!",
      });
      expect(result.success).toBe(true);
    });

    it("should accept chat request with optional fields", () => {
      const result = validateChatRequest({
        message: "Hello!",
        sessionId: "sess_123",
        private: true,
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty message", () => {
      const result = validateChatRequest({
        message: "",
      });
      expect(result.success).toBe(false);
    });

    it("should reject missing message field", () => {
      const result = validateChatRequest({});
      expect(result.success).toBe(false);
    });

    it("should reject non-string message", () => {
      const result = validateChatRequest({
        message: 12345,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("Memory Store Request", () => {
    it("should accept a valid memory store request", () => {
      const result = validateMemoryStoreRequest({
        text: "User prefers dark mode",
        category: "preference",
        importance: 0.8,
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid category", () => {
      const result = validateMemoryStoreRequest({
        text: "test",
        category: "invalid",
        importance: 0.5,
      });
      expect(result.success).toBe(false);
    });

    it("should reject importance out of range", () => {
      const result = validateMemoryStoreRequest({
        text: "test",
        category: "fact",
        importance: 1.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("Memory Search Request", () => {
    it("should accept a valid search request", () => {
      const result = validateMemorySearchRequest({
        query: "TypeScript preferences",
      });
      expect(result.success).toBe(true);
    });

    it("should accept search with optional filters", () => {
      const result = validateMemorySearchRequest({
        query: "TypeScript",
        category: "preference",
        limit: 10,
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty query", () => {
      const result = validateMemorySearchRequest({
        query: "",
      });
      expect(result.success).toBe(false);
    });
  });
});
