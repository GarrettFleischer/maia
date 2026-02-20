/**
 * @fileoverview Tests for centralized prompts: system prompt structure, heartbeat, run-loop strings.
 * @module tests/prompts/prompts.test
 */

import { describe, expect, it } from "bun:test";
import {
  buildAgentSystemPrompt,
  buildHeartbeatPrompt,
  buildWorkspaceFilesBlock,
  formatToolCallMissingNameError,
  HEARTBEAT_OK,
  HEARTBEAT_TASK_PREFIX,
  HEARTBEAT_TASK_BODY,
  HEARTBEAT_TOOL_RESULT_CONTINUATION,
  RUN_LOOP_REPEATED_TOOL_CALL_MESSAGE,
  RUN_LOOP_TOOL_ERROR_FOLLOWUP,
  SECURITY_GATE_SYSTEM_PROMPT,
  WORKSPACE_FILES_DELIMITER_BEGIN,
  WORKSPACE_FILES_DELIMITER_END,
} from "@/prompts";

describe("prompts", () => {
  describe("buildAgentSystemPrompt", () => {
    it("includes BEGIN and END workspace files delimiters", () => {
      const prompt = buildAgentSystemPrompt({}, "agent-1");
      expect(prompt).toContain(WORKSPACE_FILES_DELIMITER_BEGIN);
      expect(prompt).toContain(WORKSPACE_FILES_DELIMITER_END);
    });

    it("includes explicit note that workspace files are not messages from the user", () => {
      const prompt = buildAgentSystemPrompt({}, "agent-1");
      expect(prompt).toContain("not messages from the user");
      expect(prompt).toContain("actual conversation with the user follows");
    });

    it("includes each expected .md section when mdContext has content", () => {
      const mdContext: Record<string, string> = {
        "IDENTITY.md": "I am TestAgent.",
        "SOUL.md": "My soul content.",
        "USER.md": "User notes.",
        "MEMORY.md": "",
        "HEARTBEAT.md": "Goals here.",
      };
      const prompt = buildAgentSystemPrompt(mdContext, "agent-1");
      expect(prompt).toContain("### IDENTITY.md");
      expect(prompt).toContain("I am TestAgent.");
      expect(prompt).toContain("### SOUL.md");
      expect(prompt).toContain("My soul content.");
      expect(prompt).toContain("### USER.md");
      expect(prompt).toContain("User notes.");
      expect(prompt).toContain("### HEARTBEAT.md");
      expect(prompt).toContain("Goals here.");
    });

    it("includes agent id and workspace folder note", () => {
      const prompt = buildAgentSystemPrompt({}, "my-agent-id");
      expect(prompt).toContain("Agent id: my-agent-id");
      expect(prompt).toContain("workspace/");
    });

    it("includes note that conversation is user or assistant messages after", () => {
      const prompt = buildAgentSystemPrompt({}, "agent-1");
      expect(prompt).toContain("Everything after this in the conversation is user or assistant messages");
    });

    it("includes rule to never reply HEARTBEAT_OK to the user", () => {
      const prompt = buildAgentSystemPrompt({}, "agent-1");
      expect(prompt).toContain("Never reply to the user with HEARTBEAT_OK");
      expect(prompt).toContain("only for internal heartbeat runs");
    });

    it("includes rule that tool error means do not assume success", () => {
      const prompt = buildAgentSystemPrompt({}, "agent-1");
      expect(prompt).toContain("[tool error]");
      expect(prompt).toContain("Do not assume it succeeded");
    });
  });

  describe("buildWorkspaceFilesBlock", () => {
    it("wraps content with delimiters and file names", () => {
      const block = buildWorkspaceFilesBlock(
        { "SOUL.md": "soul text" },
        ["SOUL.md"]
      );
      expect(block).toContain(WORKSPACE_FILES_DELIMITER_BEGIN);
      expect(block).toContain(WORKSPACE_FILES_DELIMITER_END);
      expect(block).toContain("### SOUL.md");
      expect(block).toContain("soul text");
    });
  });

  describe("buildHeartbeatPrompt", () => {
    it("includes Heartbeat system task prefix", () => {
      const prompt = buildHeartbeatPrompt("");
      expect(prompt).toContain(HEARTBEAT_TASK_PREFIX);
    });

    it("includes HEARTBEAT_OK instruction", () => {
      const prompt = buildHeartbeatPrompt("");
      expect(prompt).toContain(HEARTBEAT_OK);
    });

    it("prepends lastRunSummary when provided", () => {
      const summary = "Last run you: did something.\n\n";
      const prompt = buildHeartbeatPrompt(summary);
      expect(prompt).toContain(summary);
      expect(prompt.startsWith("Last run you:")).toBe(true);
    });
  });

  describe("HEARTBEAT_TASK_BODY", () => {
    it("requires updating HEARTBEAT.md before HEARTBEAT_OK", () => {
      expect(HEARTBEAT_TASK_BODY).toContain("fs_write_file to update HEARTBEAT.md");
      expect(HEARTBEAT_TASK_BODY).toContain("Before replying HEARTBEAT_OK");
    });

    it("mentions message_user for telling the user", () => {
      expect(HEARTBEAT_TASK_BODY).toContain("message_user");
    });
  });

  describe("RUN_LOOP_TOOL_ERROR_FOLLOWUP", () => {
    it("instructs not to assume tool succeeded", () => {
      expect(RUN_LOOP_TOOL_ERROR_FOLLOWUP).toContain("failed");
      expect(RUN_LOOP_TOOL_ERROR_FOLLOWUP).toContain("Do not assume it succeeded");
    });
  });

  describe("HEARTBEAT_TOOL_RESULT_CONTINUATION", () => {
    it("labels tool result and encourages continuing with goals and HEARTBEAT_OK", () => {
      expect(HEARTBEAT_TOOL_RESULT_CONTINUATION).toContain("Tool result");
      expect(HEARTBEAT_TOOL_RESULT_CONTINUATION).toContain("Continue");
      expect(HEARTBEAT_TOOL_RESULT_CONTINUATION).toContain("HEARTBEAT_OK");
    });
  });

  describe("SECURITY_GATE_SYSTEM_PROMPT", () => {
    it("instructs classifier to output JSON with allowed and reason", () => {
      expect(SECURITY_GATE_SYSTEM_PROMPT).toContain("allowed");
      expect(SECURITY_GATE_SYSTEM_PROMPT).toContain("reason");
      expect(SECURITY_GATE_SYSTEM_PROMPT).toContain("JSON");
    });
  });

  describe("RUN_LOOP_REPEATED_TOOL_CALL_MESSAGE", () => {
    it("instructs different action or HEARTBEAT_OK", () => {
      expect(RUN_LOOP_REPEATED_TOOL_CALL_MESSAGE).toContain("HEARTBEAT_OK");
      expect(RUN_LOOP_REPEATED_TOOL_CALL_MESSAGE).toContain("DIFFERENT action");
    });
  });

  describe("formatToolCallMissingNameError", () => {
    it("returns message with raw preview", () => {
      const msg = formatToolCallMissingNameError('{"foo":1}');
      expect(msg).toContain("[tool error]");
      expect(msg).toContain("missing name");
      expect(msg).toContain('{"foo":1}');
    });
  });
});
