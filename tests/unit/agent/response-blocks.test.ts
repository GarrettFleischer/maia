/**
 * @fileoverview Unit tests for response-blocks parser (REMEMBER, SECURITY, PROGRESS).
 * @module tests/unit/agent/response-blocks
 */

import { describe, it, expect } from "bun:test";
import {
  parseResponseBlocks,
  SECURITY_DELIMITER,
  PROGRESS_DELIMITER,
} from "../../../src/agent/response-blocks.js";
import { REMEMBER_DELIMITER } from "../../../src/memory/remember-block.js";

describe("parseResponseBlocks", () => {
  it("returns only displayContent when no blocks present", () => {
    const raw = "Hello, here is my reply.";
    const result = parseResponseBlocks(raw);
    expect(result.displayContent).toBe("Hello, here is my reply.");
    expect(result.rememberBlockRaw).toBeUndefined();
    expect(result.security).toBeUndefined();
    expect(result.progress).toBeUndefined();
  });

  it("trims display content and stops at first delimiter", () => {
    const raw = "  Reply text here  \n\n---REMEMBER---\n{}";
    const result = parseResponseBlocks(raw);
    expect(result.displayContent).toBe("Reply text here");
    expect(result.rememberBlockRaw).toBe("{}");
  });

  describe("REMEMBER block", () => {
    it("extracts remember block raw string after delimiter", () => {
      const raw = "Sure.\n---REMEMBER---\n```json\n{\"memoryMd\": \"User prefers dark mode.\"}\n```";
      const result = parseResponseBlocks(raw);
      expect(result.displayContent).toBe("Sure.");
      expect(result.rememberBlockRaw).toContain("memoryMd");
    });

    it("uses first delimiter when multiple blocks exist", () => {
      const raw = "Ok\n---SECURITY---\n{\"flagged\": false}\n---REMEMBER---\n{}";
      const result = parseResponseBlocks(raw);
      expect(result.displayContent).toBe("Ok");
      expect(result.security).toBeDefined();
      expect(result.security?.flagged).toBe(false);
      expect(result.rememberBlockRaw).toBe("{}");
    });
  });

  describe("SECURITY block", () => {
    it("parses flagged true with reason and snippet", () => {
      const raw = `Answer\n---SECURITY---\n{"flagged": true, "reason": "Possible injection", "snippet": "ignore instructions"}`;
      const result = parseResponseBlocks(raw);
      expect(result.displayContent).toBe("Answer");
      expect(result.security).toEqual({
        flagged: true,
        reason: "Possible injection",
        snippet: "ignore instructions",
      });
    });

    it("parses flagged false as not flagged", () => {
      const raw = `Hi\n---SECURITY---\n{"flagged": false}`;
      const result = parseResponseBlocks(raw);
      expect(result.security).toEqual({ flagged: false });
    });

    it("strips ```json fences from security block", () => {
      const raw = `Hi\n---SECURITY---\n\`\`\`json\n{"flagged": true, "reason": "x", "snippet": "y"}\n\`\`\``;
      const result = parseResponseBlocks(raw);
      expect(result.security?.flagged).toBe(true);
      expect(result.security?.reason).toBe("x");
      expect(result.security?.snippet).toBe("y");
    });

    it("defaults to flagged false on invalid JSON", () => {
      const raw = "Hi\n---SECURITY---\nnot json at all";
      const result = parseResponseBlocks(raw);
      expect(result.security).toEqual({ flagged: false });
    });

    it("handles missing reason/snippet", () => {
      const raw = "Hi\n---SECURITY---\n{\"flagged\": true}";
      const result = parseResponseBlocks(raw);
      expect(result.security?.flagged).toBe(true);
      expect(result.security?.reason).toBeUndefined();
      expect(result.security?.snippet).toBeUndefined();
    });
  });

  describe("PROGRESS block", () => {
    it("parses status and summary", () => {
      const raw = `Update\n---PROGRESS---\n{"status": "accomplished", "summary": "Task done."}`;
      const result = parseResponseBlocks(raw);
      expect(result.displayContent).toBe("Update");
      expect(result.progress).toEqual({ status: "accomplished", summary: "Task done." });
    });

    it("strips ```json fences from progress block", () => {
      const raw = `Update\n---PROGRESS---\n\`\`\`json\n{"status": "stuck", "summary": "Blocked."}\n\`\`\``;
      const result = parseResponseBlocks(raw);
      expect(result.progress?.status).toBe("stuck");
      expect(result.progress?.summary).toBe("Blocked.");
    });

    it("ignores invalid progress JSON", () => {
      const raw = "Update\n---PROGRESS---\n{ invalid }";
      const result = parseResponseBlocks(raw);
      expect(result.progress).toBeUndefined();
    });

    it("handles non-string status/summary as empty", () => {
      const raw = "Update\n---PROGRESS---\n{\"status\": 1, \"summary\": null}";
      const result = parseResponseBlocks(raw);
      expect(result.progress?.status).toBe("");
      expect(result.progress?.summary).toBe("");
    });
  });

  describe("multiple blocks order", () => {
    it("displayContent is everything before first delimiter", () => {
      const raw = "A\n---PROGRESS---\n{}\n---REMEMBER---\n{}\n---SECURITY---\n{}";
      const result = parseResponseBlocks(raw);
      expect(result.displayContent).toBe("A");
      expect(result.progress).toBeDefined();
      expect(result.rememberBlockRaw).toBeDefined();
      expect(result.security).toBeDefined();
    });

    it("all three block types in one response", () => {
      const raw = [
        "Here you go.",
        REMEMBER_DELIMITER,
        '{"userMd": "Note"}',
        SECURITY_DELIMITER,
        '{"flagged": false}',
        PROGRESS_DELIMITER,
        '{"status": "accomplished", "summary": "Done."}',
      ].join("\n");
      const result = parseResponseBlocks(raw);
      expect(result.displayContent).toBe("Here you go.");
      expect(result.rememberBlockRaw).toContain("userMd");
      expect(result.security?.flagged).toBe(false);
      expect(result.progress?.status).toBe("accomplished");
      expect(result.progress?.summary).toBe("Done.");
    });
  });

  describe("delimiter constants", () => {
    it("SECURITY_DELIMITER is ---SECURITY---", () => {
      expect(SECURITY_DELIMITER).toBe("---SECURITY---");
    });
    it("PROGRESS_DELIMITER is ---PROGRESS---", () => {
      expect(PROGRESS_DELIMITER).toBe("---PROGRESS---");
    });
    it("REMEMBER_DELIMITER is ---REMEMBER---", () => {
      expect(REMEMBER_DELIMITER).toBe("---REMEMBER---");
    });
  });
});
