/**
 * @fileoverview RTL tests for ChatInputBar (controlled textarea + send button).
 * Verifies keyboard submit behavior and disabled state handling.
 * @module __tests__/app/components/ChatInputBar.test
 */

import { describe, it, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import ChatInputBar from "@/app/components/ChatInputBar";

/**
 * @brief Test wrapper to simulate controlled ChatInputBar usage.
 * @param props - Initial disabled flag for the input.
 * @returns JSX element for rendering in tests.
 */
function ControlledInput(props: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <ChatInputBar
      value={value}
      onChange={setValue}
      onSubmit={() => {
        // no-op in this wrapper; individual tests attach spies instead.
      }}
      disabled={props.disabled}
    />
  );
}

describe("ChatInputBar", () => {
  it("calls onChange when the user types and enables send when non-empty", () => {
    const changes: string[] = [];
    const handleChange = (v: string) => {
      changes.push(v);
    };
    const { rerender } = render(
      <ChatInputBar value="" onChange={handleChange} onSubmit={() => {}} />,
    );

    const textarea = screen.getByPlaceholderText(/Message Maia/i);
    const sendButton = screen.getByRole("button", { name: "Send message" });

    expect(sendButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "Hello" } });
    expect(changes).toContain("Hello");

    // Simulate parent updating value to match latest change.
    rerender(
      <ChatInputBar
        value="Hello"
        onChange={handleChange}
        onSubmit={() => {}}
      />,
    );
    expect(sendButton).not.toBeDisabled();
  });

  it("invokes onSubmit on Enter without Shift and not on Shift+Enter", () => {
    let submitCount = 0;
    const handleSubmit = () => {
      submitCount += 1;
    };
    render(
      <ChatInputBar value="Hi" onChange={() => {}} onSubmit={handleSubmit} />,
    );
    const textarea = screen.getByPlaceholderText(/Message Maia/i);

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(submitCount).toBe(0);

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(submitCount).toBe(1);
  });

  it("disables send button when disabled prop is true even with text", () => {
    render(<ControlledInput disabled />);
    const textarea = screen.getByPlaceholderText(/Message Maia/i);
    const sendButton = screen.getByRole("button", { name: "Send message" });

    fireEvent.change(textarea, { target: { value: "Cannot send" } });
    expect(sendButton).toBeDisabled();
  });
});
