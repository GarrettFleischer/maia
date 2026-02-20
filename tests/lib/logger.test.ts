/**
 * @fileoverview Tests for the Maia logger (log level and debug output).
 * @module tests/lib/logger.test
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  getLogLevel,
  isDebug,
  debug,
  info,
  warn,
  error,
} from "@/lib/logger";

describe("logger", () => {
  const originalEnv = process.env.MAIA_LOG_LEVEL;

  afterEach(() => {
    process.env.MAIA_LOG_LEVEL = originalEnv;
  });

  describe("getLogLevel", () => {
    it("returns 'info' when MAIA_LOG_LEVEL is unset", () => {
      delete process.env.MAIA_LOG_LEVEL;
      expect(getLogLevel()).toBe("info");
    });

    it("returns 'debug' when MAIA_LOG_LEVEL=debug", () => {
      process.env.MAIA_LOG_LEVEL = "debug";
      expect(getLogLevel()).toBe("debug");
    });

    it("returns 'info' when MAIA_LOG_LEVEL=info", () => {
      process.env.MAIA_LOG_LEVEL = "info";
      expect(getLogLevel()).toBe("info");
    });

    it("returns 'warn' when MAIA_LOG_LEVEL=warn", () => {
      process.env.MAIA_LOG_LEVEL = "warn";
      expect(getLogLevel()).toBe("warn");
    });

    it("returns 'error' when MAIA_LOG_LEVEL=error", () => {
      process.env.MAIA_LOG_LEVEL = "error";
      expect(getLogLevel()).toBe("error");
    });

    it("treats unknown value as info", () => {
      process.env.MAIA_LOG_LEVEL = "trace";
      expect(getLogLevel()).toBe("info");
    });
  });

  describe("isDebug", () => {
    it("returns true only when MAIA_LOG_LEVEL is debug", () => {
      process.env.MAIA_LOG_LEVEL = "debug";
      expect(isDebug()).toBe(true);
    });

    it("returns false when MAIA_LOG_LEVEL is info", () => {
      process.env.MAIA_LOG_LEVEL = "info";
      expect(isDebug()).toBe(false);
    });

    it("returns false when MAIA_LOG_LEVEL is unset", () => {
      delete process.env.MAIA_LOG_LEVEL;
      expect(isDebug()).toBe(false);
    });
  });

  describe("debug()", () => {
    it("calls console.debug when log level is debug", () => {
      process.env.MAIA_LOG_LEVEL = "debug";
      const consoleSpy = mock(() => {});
      const orig = console.debug;
      console.debug = consoleSpy;
      try {
        debug("heartbeat", { agentId: "a1" });
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        const firstCall = (consoleSpy.mock.calls as unknown as [string][])[0];
        const firstArg = firstCall?.[0] ?? "";
        expect(firstArg).toContain("heartbeat");
        expect(firstArg).toContain("a1");
      } finally {
        console.debug = orig;
      }
    });

    it("does not call console when log level is info", () => {
      process.env.MAIA_LOG_LEVEL = "info";
      const consoleSpy = mock(() => {});
      const orig = console.debug;
      console.debug = consoleSpy;
      try {
        debug("heartbeat", { agentId: "a1" });
        expect(consoleSpy).toHaveBeenCalledTimes(0);
      } finally {
        console.debug = orig;
      }
    });
  });

  describe("info(), warn(), error()", () => {
    it("info logs when level is info or debug", () => {
      process.env.MAIA_LOG_LEVEL = "info";
      const consoleSpy = mock(() => {});
      const orig = console.info;
      console.info = consoleSpy;
      try {
        info("test");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      } finally {
        console.info = orig;
      }
    });

    it("warn logs when level is warn, info, or debug", () => {
      process.env.MAIA_LOG_LEVEL = "warn";
      const consoleSpy = mock(() => {});
      const orig = console.warn;
      console.warn = consoleSpy;
      try {
        warn("test");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      } finally {
        console.warn = orig;
      }
    });

    it("error always logs", () => {
      process.env.MAIA_LOG_LEVEL = "error";
      const consoleSpy = mock(() => {});
      const orig = console.error;
      console.error = consoleSpy;
      try {
        error("test");
        expect(consoleSpy).toHaveBeenCalledTimes(1);
      } finally {
        console.error = orig;
      }
    });
  });
});
