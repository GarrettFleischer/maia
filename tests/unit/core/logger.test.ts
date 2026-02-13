/**
 * @fileoverview Unit tests for structured logger with redaction.
 * @module tests/unit/core/logger
 */

import { describe, it, expect } from "bun:test";
import { createLogger } from "../../../src/core/logger.js";

describe("Logger", () => {
  it("should log messages at all levels", () => {
    const output: string[] = [];
    const logger = createLogger({
      level: "debug",
      write: (line: string) => output.push(line),
    });

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(output).toHaveLength(4);
    expect(output[0]).toContain("debug message");
    expect(output[1]).toContain("info message");
    expect(output[2]).toContain("warn message");
    expect(output[3]).toContain("error message");
  });

  it("should respect log level filtering", () => {
    const output: string[] = [];
    const logger = createLogger({
      level: "warn",
      write: (line: string) => output.push(line),
    });

    logger.debug("should not appear");
    logger.info("should not appear");
    logger.warn("should appear");
    logger.error("should appear");

    expect(output).toHaveLength(2);
  });

  it("should include metadata in log output", () => {
    const output: string[] = [];
    const logger = createLogger({
      level: "info",
      write: (line: string) => output.push(line),
    });

    logger.info("request", { method: "GET", path: "/api/chat" });

    expect(output[0]).toContain("GET");
    expect(output[0]).toContain("/api/chat");
  });

  it("should redact sensitive values", () => {
    const output: string[] = [];
    const logger = createLogger({
      level: "info",
      write: (line: string) => output.push(line),
    });

    logger.info("auth", { token: "sk-proj-12345", password: "secret123" });

    expect(output[0]).not.toContain("sk-proj-12345");
    expect(output[0]).not.toContain("secret123");
    expect(output[0]).toContain("[REDACTED]");
  });

  it("should redact Bearer tokens in values", () => {
    const output: string[] = [];
    const logger = createLogger({
      level: "info",
      write: (line: string) => output.push(line),
    });

    logger.info("header", { authorization: "Bearer my-token-abc" });

    expect(output[0]).not.toContain("my-token-abc");
    expect(output[0]).toContain("[REDACTED]");
  });

  it("should include timestamp in log output", () => {
    const output: string[] = [];
    const logger = createLogger({
      level: "info",
      write: (line: string) => output.push(line),
    });

    logger.info("test");

    // Should contain ISO timestamp pattern
    expect(output[0]).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
