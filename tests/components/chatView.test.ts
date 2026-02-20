/**
 * @fileoverview Tests for ChatView helpers: shouldShowThinkingIndicator.
 * @module tests/components/chatView.test
 */

import { describe, expect, it } from "bun:test";
import {
  shouldShowThinkingIndicator,
  STREAMING_MESSAGE_ID,
} from "@/app/components/chatViewHelpers";

describe("shouldShowThinkingIndicator", () => {
  it("returns true for streaming message with null content", () => {
    expect(
      shouldShowThinkingIndicator({ id: STREAMING_MESSAGE_ID, content: null }),
    ).toBe(true);
  });

  it("returns true for streaming message with empty string content", () => {
    expect(
      shouldShowThinkingIndicator({ id: STREAMING_MESSAGE_ID, content: "" }),
    ).toBe(true);
  });

  it("returns true for streaming message with whitespace-only content", () => {
    expect(
      shouldShowThinkingIndicator({
        id: STREAMING_MESSAGE_ID,
        content: "   \n ",
      }),
    ).toBe(true);
  });

  it("returns false for streaming message with non-empty content", () => {
    expect(
      shouldShowThinkingIndicator({
        id: STREAMING_MESSAGE_ID,
        content: "Hello",
      }),
    ).toBe(false);
  });

  it("returns false for non-streaming message with empty content", () => {
    expect(
      shouldShowThinkingIndicator({ id: "assistant-123", content: "" }),
    ).toBe(false);
  });

  it("returns false for non-streaming message with content", () => {
    expect(shouldShowThinkingIndicator({ id: "user-456", content: "Hi" })).toBe(
      false,
    );
  });
});
