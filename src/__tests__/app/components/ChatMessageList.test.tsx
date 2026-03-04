/**
 * @fileoverview RTL tests for ChatMessageList (message bubbles, markdown rendering).
 * @module __tests__/app/components/ChatMessageList.test
 */

import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import ChatMessageList from "@/app/components/ChatMessageList";
import type { ChatMessageListItem } from "@/app/components/ChatMessageList";

describe("ChatMessageList", () => {
  it("renders agent message with markdown bold as strong", () => {
    const messages: ChatMessageListItem[] = [
      { role: "agent", content: "Here is **bold text** and more." },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    const strong = screen.getByText("bold text");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.getByText(/Here is/)).toBeInTheDocument();
  });

  it("renders agent message with inline code as code element", () => {
    const messages: ChatMessageListItem[] = [
      { role: "agent", content: "Run `npm install` to install." },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    const code = screen.getByText("npm install");
    expect(code.tagName).toBe("CODE");
  });

  it("renders user message as plain text (no markdown)", () => {
    const messages: ChatMessageListItem[] = [
      { role: "user", content: "Say **hello** literally." },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    // User content is shown as-is; ** should not create a strong element
    expect(screen.getByText("Say **hello** literally.")).toBeInTheDocument();
  });

  it("renders streaming token with markdown", () => {
    render(
      <ChatMessageList
        messages={[]}
        currentToken="Answer: **yes**"
        loading={false}
      />,
    );
    const strong = screen.getByText("yes");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders persisted thinking message in a Thinking bubble", () => {
    const messages: ChatMessageListItem[] = [
      { role: "thinking", content: "Let me consider the options first." },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(
      screen.getByText(/Let me consider the options first\./),
    ).toBeInTheDocument();
  });

  it("renders streaming thinking in a Thinking bubble with cursor", () => {
    render(
      <ChatMessageList
        messages={[]}
        currentToken=""
        currentThinking="Reasoning step..."
        loading={true}
      />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText(/Reasoning step\.\.\./)).toBeInTheDocument();
  });

  it("renders terminal_exec result with readable stdout (not JSON-escaped newlines)", () => {
    const messages: ChatMessageListItem[] = [
      {
        role: "tool",
        tool: "terminal_exec",
        args: { command: "ls -la" },
        result: {
          stdout: "file1.txt\nfile2.txt\n",
          stderr: "",
          exitCode: 0,
        },
      },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    // stdout should render with actual newlines, not literal \n
    expect(screen.getByText(/file1\.txt/)).toBeInTheDocument();
    expect(screen.getByText(/file2\.txt/)).toBeInTheDocument();
    expect(screen.getByText(/exit code:/)).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders smart context phase bubbles when smartContextRun is set (UI-only, excluded from rounds)", () => {
    const run = {
      phases: [
        { phase: "queries" as const },
        { phase: "retrieval" as const },
        { phase: "filter" as const },
        { phase: "summary" as const },
      ],
      doneDetail: undefined as string | undefined,
    };
    render(
      <ChatMessageList
        messages={[]}
        currentToken=""
        loading={true}
        smartContextRun={run}
      />,
    );
    expect(screen.getByText("Smart context")).toBeInTheDocument();
    expect(screen.getByText("Clarified command")).toBeInTheDocument();
    expect(screen.getByText("Extracting queries")).toBeInTheDocument();
    expect(screen.getByText("Searching")).toBeInTheDocument();
    expect(screen.getByText("Filtering")).toBeInTheDocument();
    expect(screen.getByText("Summarizing")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("renders smart context result when run is complete with doneDetail", () => {
    const run = {
      phases: [
        { phase: "queries" as const },
        { phase: "retrieval" as const },
        { phase: "filter" as const },
        { phase: "summary" as const },
        { phase: "done" as const, detail: "3 sources" },
      ],
      doneDetail: "3 sources",
    };
    render(
      <ChatMessageList
        messages={[]}
        currentToken=""
        loading={false}
        smartContextRun={run}
      />,
    );
    expect(screen.getByText("Smart context")).toBeInTheDocument();
    expect(screen.getByText(/Done \(3 sources\)/)).toBeInTheDocument();
  });

  it("does not render a redundant smart context result bubble when run is complete", () => {
    const run = {
      phases: [
        { phase: "queries" as const },
        { phase: "retrieval" as const },
        { phase: "filter" as const },
        { phase: "summary" as const },
        { phase: "done" as const, detail: "2 sources" },
      ],
      doneDetail: "2 sources",
    };
    render(
      <ChatMessageList
        messages={[]}
        currentToken=""
        loading={false}
        smartContextRun={run}
      />,
    );
    expect(screen.queryByText(/Result:/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Done \(2 sources\)/)).toBeInTheDocument();
  });

  it("does not render smart context bubbles when smartContextRun is null", () => {
    render(
      <ChatMessageList
        messages={[]}
        currentToken=""
        loading={true}
        smartContextRun={null}
      />,
    );
    expect(screen.queryByText("Smart context")).not.toBeInTheDocument();
  });
});
