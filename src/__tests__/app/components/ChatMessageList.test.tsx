/**
 * @fileoverview RTL tests for ChatMessageList (message bubbles, markdown rendering).
 * @module __tests__/app/components/ChatMessageList.test
 */

import { describe, it, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("limits thinking bubble content height and enables scrolling", () => {
    const messages: ChatMessageListItem[] = [
      {
        role: "thinking",
        content:
          "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10",
      },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    const contentElement = screen.getByText(/Line 1/) as HTMLElement;
    expect(contentElement).toHaveClass("max-h-64");
    expect(contentElement).toHaveClass("overflow-auto");
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

  it("renders smart context phase bubbles when messages include smart_context item", () => {
    const run = {
      phases: [
        { phase: "queries" as const },
        { phase: "retrieval" as const },
        { phase: "filter" as const },
        { phase: "summary" as const },
      ],
      doneDetail: undefined as string | undefined,
    };
    const messages: ChatMessageListItem[] = [
      { role: "smart_context", run, loading: true },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={true} />,
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
    const messages: ChatMessageListItem[] = [
      { role: "smart_context", run, loading: false },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
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
    const messages: ChatMessageListItem[] = [
      { role: "smart_context", run, loading: false },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    expect(screen.queryByText(/Result:/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Done \(2 sources\)/)).toBeInTheDocument();
  });

  it("does not render smart context bubbles when messages have no smart_context item", () => {
    render(<ChatMessageList messages={[]} currentToken="" loading={true} />);
    expect(screen.queryByText("Smart context")).not.toBeInTheDocument();
  });

  it("limits smart context detail height and enables scrolling", () => {
    const run = {
      phases: [
        {
          phase: "queries" as const,
          output:
            "Query output\nMore detail\nEven more detail to require scrolling.",
        },
      ],
      doneDetail: undefined as string | undefined,
    };
    const messages: ChatMessageListItem[] = [
      { role: "smart_context", run, loading: true },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={true} />,
    );

    const queriesBubble = screen.getByRole("button", {
      name: /Extracting queries/i,
    });
    fireEvent.click(queriesBubble);

    const detailElement = screen.getByText(/Query output/) as HTMLElement;
    expect(detailElement).toHaveClass("max-h-64");
    expect(detailElement).toHaveClass("overflow-auto");
  });

  it("shows full prompt sent to agent in done phase detail when run has fullPrompt", () => {
    const run = {
      phases: [
        { phase: "queries" as const },
        {
          phase: "done" as const,
          detail: "1 source",
          output:
            "Included in context (1 sources):\n- doc1\n\nActive skills (0):\n(none)",
        },
      ],
      doneDetail: "1 source",
      fullPrompt:
        "--- SYSTEM ---\n\nContext and instructions.\n\n--- USER ---\n\nWhat is the plan?",
    };
    const messages: ChatMessageListItem[] = [
      { role: "smart_context", run, loading: false },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );

    const doneBubble = screen.getByRole("button", {
      name: /Done \(1 source\), click to view details/i,
    });
    fireEvent.click(doneBubble);

    expect(screen.getByText("Full prompt sent to agent")).toBeInTheDocument();
    expect(screen.getByText(/--- SYSTEM ---/)).toBeInTheDocument();
    expect(screen.getByText(/What is the plan\?/)).toBeInTheDocument();
  });

  it("renders a pending user_input bubble with question text and submit button", () => {
    const messages: ChatMessageListItem[] = [
      {
        role: "user_input",
        requestId: "req-1",
        sessionId: "session-1",
        questions: [
          {
            id: "env",
            prompt: "Which environment should I operate on?",
            choices: ["development", "staging", "production"],
            allowOther: true,
          },
        ],
        status: "pending",
      },
    ];
    render(
      <ChatMessageList
        messages={messages}
        currentToken=""
        loading={false}
        onUserInputAnswered={() => {}}
      />,
    );
    expect(
      screen.getByText("Which environment should I operate on?"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /submit answers/i }),
    ).toBeInTheDocument();
  });

  it("renders an answered user_input bubble as read-only Q&A", () => {
    const messages: ChatMessageListItem[] = [
      {
        role: "user_input",
        questions: [
          {
            id: "env",
            prompt: "Which environment should I operate on?",
            choices: ["development", "staging", "production"],
            allowOther: true,
          },
        ],
        status: "answered",
        answers: { env: "development" },
      },
    ];
    render(
      <ChatMessageList messages={messages} currentToken="" loading={false} />,
    );
    expect(
      screen.getByText("Which environment should I operate on?"),
    ).toBeInTheDocument();
    expect(screen.getByText("development")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /submit answers/i }),
    ).not.toBeInTheDocument();
  });
});
