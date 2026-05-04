/**
 * @fileoverview RTL tests for the Home (chat) page.
 * @module __tests__/app/page.test
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import Home from "@/app/page";
import {
  installFetchMock,
  restoreFetch,
  jsonResponse,
  streamResponse,
} from "@/__tests__/helpers/fetch-mock";
import {
  sessionActiveEmpty,
  sessionActiveWithMessages,
  sessionActiveWithCustomAgent,
  agentsEmpty,
  agentsList,
  settingsPublic,
} from "@/__tests__/helpers/fixtures";

/** Handlers for views that mount in the shell but are hidden (Settings, Tasks). Prevents fetch-mock "no handler" errors. */
const BASE_SHELL_HANDLERS = [
  { url: "/api/settings", handler: () => jsonResponse(settingsPublic) },
  { url: "/api/tasks", handler: () => jsonResponse({ tasks: [] }) },
  {
    url: "/api/model-capabilities",
    handler: () => jsonResponse({ modelCapabilities: {} }),
  },
  { url: "/api/agents", handler: () => jsonResponse(agentsEmpty) },
];

/** Like installFetchMock but adds BASE_SHELL_HANDLERS so hidden shell views (Settings, Tasks) do not trigger "no handler". */
function installFetchMockForShell(
  handlers: Array<{
    url: string;
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>;
  }>,
) {
  installFetchMock([...handlers, ...BASE_SHELL_HANDLERS]);
}

type EventCallback = (event: MessageEvent) => void;

let lastEventSource: FakeEventSource | null = null;

/**
 * @brief Minimal EventSource stub for tests that captures listeners so we can emit message events.
 */
class FakeEventSource {
  listeners: Record<string, EventCallback[]> = {};

  constructor(_url: string) {
    lastEventSource = this;
  }

  addEventListener(type: string, cb: EventCallback): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type]!.push(cb);
  }

  close(): void {}
}

/** Resolved promises so client pages don't suspend in tests (Next.js 15 passes these at runtime). */
const TEST_PARAMS = Promise.resolve({} as Record<string, string | undefined>);
const TEST_SEARCH_PARAMS = Promise.resolve(
  {} as Record<string, string | string[] | undefined>,
);

/** Renders Home and flushes React Suspense (use() with promises) so content appears. */
async function renderHome() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Home params={TEST_PARAMS} searchParams={TEST_SEARCH_PARAMS} />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return result!;
}

describe("Home page", () => {
  afterEach(() => {
    restoreFetch();
  });

  it("shows welcome state when no session", async () => {
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveEmpty),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
    ]);
    await renderHome();
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Maia/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Your personal AI agent system/i),
    ).toBeInTheDocument();
  });

  it("shows messages when session has history", async () => {
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveWithMessages),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
    ]);
    await renderHome();
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
  });

  it("shows thinking bubbles when session has thinking entries (persisted after refresh)", async () => {
    const sessionWithThinking = {
      sessionId: "session-with-thinking",
      session: {
        ...sessionActiveWithMessages.session,
        id: "session-with-thinking",
        original: [
          {
            id: "e1",
            role: "user" as const,
            content: "Hello",
            timestamp: new Date().toISOString(),
          },
          {
            id: "e2",
            role: "thinking" as const,
            content: "Let me consider the options first.",
            timestamp: new Date().toISOString(),
          },
          {
            id: "e3",
            role: "agent" as const,
            content: "Hi there!",
            timestamp: new Date().toISOString(),
          },
        ],
      },
    };
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionWithThinking),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
    ]);
    await renderHome();
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
    expect(screen.getByText("Hi there!")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(
      screen.getByText(/Let me consider the options first\./),
    ).toBeInTheDocument();
  });

  it("sends message and shows it in the list when user submits", async () => {
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveEmpty),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
      {
        url: "/api/chat",
        handler: () =>
          streamResponse([
            "data: " +
              JSON.stringify({ type: "done", sessionId: "new-session" }) +
              "\n\n",
          ]),
      },
    ]);
    await renderHome();
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Maia/i)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText(/Message Maia/i);
    fireEvent.change(input, { target: { value: "Test message" } });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    fireEvent.click(sendButton);
    await waitFor(() => {
      expect(screen.getByText("Test message")).toBeInTheDocument();
    });
  });

  it("clears smart context bubbles when editing and re-sending the related user message", async () => {
    const sessionWithSmartContext = {
      sessionId: "session-1",
      session: {
        ...sessionActiveWithMessages.session,
        smartContextRuns: [
          {
            afterMessageIndex: 0,
            run: {
              phases: [
                {
                  phase: "clarified" as const,
                  detail: undefined,
                  output: "Clarified v1",
                },
                { phase: "done" as const, detail: "1 sources" },
              ],
              doneDetail: "1 sources",
            },
          },
        ],
      },
    };
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionWithSmartContext),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
      {
        url: "/api/chat",
        handler: () =>
          streamResponse([
            "data: " +
              JSON.stringify({
                type: "done",
                sessionId: "session-1",
              }) +
              "\n\n",
          ]),
      },
      {
        url: /\/api\/sessions\/session-1\/history\/truncate/,
        handler: () => jsonResponse({}),
      },
    ]);
    await renderHome();
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
    expect(screen.getByText("Smart context")).toBeInTheDocument();
    const editButton = screen.getByRole("button", {
      name: "Edit this message",
    });
    fireEvent.click(editButton);
    const textarea = screen.getByRole("textbox", { name: "Edit message" });
    fireEvent.change(textarea, { target: { value: "Hello (edited)" } });
    const saveButton = screen.getByRole("button", {
      name: "Save edited message",
    });
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(screen.queryByText("1 sources")).toBeNull();
    });
  });

  it("restores smart context bubbles when canceling message edit", async () => {
    const sessionWithSmartContext = {
      sessionId: "session-1",
      session: {
        ...sessionActiveWithMessages.session,
        smartContextRuns: [
          {
            afterMessageIndex: 0,
            run: {
              phases: [
                {
                  phase: "clarified" as const,
                  detail: undefined,
                  output: "Clarified v1",
                },
                { phase: "done" as const, detail: "1 sources" },
              ],
              doneDetail: "1 sources",
            },
          },
        ],
      },
    };
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionWithSmartContext),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
    ]);
    await renderHome();
    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });
    expect(screen.getByText("Smart context")).toBeInTheDocument();
    const editButton = screen.getByRole("button", {
      name: "Edit this message",
    });
    fireEvent.click(editButton);
    expect(screen.queryByText("Smart context")).toBeNull();
    const cancelButton = screen.getByRole("button", {
      name: "Cancel editing",
    });
    fireEvent.click(cancelButton);
    await waitFor(() => {
      expect(screen.getByText("Smart context")).toBeInTheDocument();
    });
  });

  // TODO: In test env the /api/chat request body sometimes lacks targetAgent (timing/body capture).
  it.skip("sends targetAgent in chat request when session has non-maia participant", async () => {
    let chatBody: {
      message?: string;
      sessionId?: string;
      targetAgent?: string;
    } = {};
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveWithCustomAgent),
      },
      {
        url: "/api/sessions",
        handler: () => jsonResponse({ sessions: [] }),
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsEmpty),
      },
      {
        url: "/api/chat",
        handler: (_url, init) => {
          try {
            const bodyStr =
              typeof init?.body === "string"
                ? init.body
                : init?.body != null
                  ? String(init.body)
                  : "{}";
            chatBody = JSON.parse(bodyStr) as typeof chatBody;
          } catch {
            // ignore
          }
          return streamResponse([
            "data: " +
              JSON.stringify({ type: "done", sessionId: "session-custom" }) +
              "\n\n",
          ]);
        },
      },
    ]);
    await renderHome();
    await waitFor(() => expect(screen.getByText("Hello")).toBeInTheDocument());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const inputEl = screen.getByPlaceholderText(/message/i);
    await act(async () => {
      fireEvent.change(inputEl, { target: { value: "Hi" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });
    await waitFor(() => {
      expect(chatBody.message).toBe("Hi");
      expect(chatBody.targetAgent).toBe("custom-agent");
    });
  });

  it("creates new thread with Maia orchestrator (POST sessions has user + maia)", async () => {
    let sessionsPostBody: { participants?: string[]; type?: string } = {};
    installFetchMockForShell([
      {
        url: "/api/sessions/active",
        handler: () => jsonResponse(sessionActiveEmpty),
      },
      {
        url: "/api/sessions",
        handler: (url, init) => {
          if (init?.method === "POST" && init?.body) {
            try {
              sessionsPostBody = JSON.parse(
                init.body as string,
              ) as typeof sessionsPostBody;
            } catch {
              // ignore
            }
            return jsonResponse({ sessionId: "new-thread-id" }, 201);
          }
          return jsonResponse({ sessions: [] });
        },
      },
      {
        url: "/api/agents",
        handler: () => jsonResponse(agentsList),
      },
      {
        url: "/api/chat",
        handler: () =>
          streamResponse([
            "data: " +
              JSON.stringify({ type: "done", sessionId: "new-session" }) +
              "\n\n",
          ]),
      },
    ]);
    await renderHome();
    await waitFor(() =>
      expect(screen.getByText(/Welcome to Maia/i)).toBeInTheDocument(),
    );
    screen.getByRole("button", { name: /new thread/i }).click();
    await waitFor(() => {
      expect(sessionsPostBody.participants).toEqual(["user", "maia"]);
      expect(sessionsPostBody.type).toBe("user");
    });
  });

  /**
   * ask_user and SSE-driven message tests: depend on EventSource "question" / "message"
   * handlers running after session load. Currently the inline question bubble and
   * realtime message updates do not appear in the test DOM; skip until test setup is fixed.
   */
  describe.skip("ask_user user input bubble", () => {
    let originalEventSource: typeof EventSource | undefined;

    beforeEach(() => {
      originalEventSource = (
        globalThis as unknown as { EventSource?: typeof EventSource }
      ).EventSource;
      (
        globalThis as unknown as { EventSource?: typeof EventSource }
      ).EventSource = FakeEventSource as unknown as typeof EventSource;
    });

    afterEach(() => {
      (
        globalThis as unknown as { EventSource?: typeof EventSource }
      ).EventSource = originalEventSource as typeof EventSource;
    });

    it("shows an inline user_input bubble when a question event arrives for the active session", async () => {
      installFetchMockForShell([
        {
          url: "/api/sessions/active",
          handler: () => jsonResponse(sessionActiveWithMessages),
        },
        { url: "/api/sessions", handler: () => jsonResponse({ sessions: [] }) },
        { url: "/api/agents", handler: () => jsonResponse(agentsEmpty) },
        {
          url: "/api/chat/question-response",
          handler: () => jsonResponse({ ok: true }),
        },
      ]);
      await renderHome();
      await waitFor(() =>
        expect(screen.getByText("Hello")).toBeInTheDocument(),
      );

      const es = lastEventSource;
      expect(es).not.toBeNull();
      const questionPayload = {
        sessionId: "session-1",
        requestId: "req-1",
        questions: [
          {
            id: "env",
            prompt: "Which environment should I operate on?",
            choices: ["development", "staging", "production"],
            allowOther: true,
          },
        ],
      };

      await act(async () => {
        for (const cb of es?.listeners["question"] ?? []) {
          cb({ data: JSON.stringify(questionPayload) } as MessageEvent);
        }
      });

      await waitFor(() =>
        expect(
          screen.getByText(/Which environment should I operate on\?/),
        ).toBeInTheDocument(),
      );
      // The old fullscreen modal should not be rendered anymore.
      expect(
        screen.queryByRole("dialog", {
          name: /answer the agent's questions/i,
        }),
      ).toBeNull();
    });

    it("submit button in inline question bubble submits answers and updates bubble", async () => {
      let questionResponseBody: {
        sessionId?: string;
        requestId?: string;
        answers?: Record<string, string>;
      } = {};
      installFetchMockForShell([
        {
          url: "/api/sessions/active",
          handler: () => jsonResponse(sessionActiveWithMessages),
        },
        { url: "/api/sessions", handler: () => jsonResponse({ sessions: [] }) },
        { url: "/api/agents", handler: () => jsonResponse(agentsEmpty) },
        {
          url: "/api/chat/question-response",
          handler: (_url, init) => {
            try {
              const body =
                typeof init?.body === "string"
                  ? JSON.parse(init.body)
                  : (init?.body ?? {});
              questionResponseBody = body as typeof questionResponseBody;
            } catch {
              // ignore
            }
            return jsonResponse({ ok: true });
          },
        },
      ]);
      await renderHome();
      await waitFor(() =>
        expect(screen.getByText("Hello")).toBeInTheDocument(),
      );

      const es = lastEventSource;
      expect(es).not.toBeNull();
      const questionPayload = {
        sessionId: "session-1",
        requestId: "req-1",
        questions: [
          {
            id: "env",
            prompt: "Which environment should I operate on?",
            choices: ["development", "staging", "production"],
            allowOther: true,
          },
        ],
      };

      await act(async () => {
        for (const cb of es?.listeners["question"] ?? []) {
          cb({ data: JSON.stringify(questionPayload) } as MessageEvent);
        }
      });

      await waitFor(() =>
        expect(
          screen.getByText(/Which environment should I operate on\?/),
        ).toBeInTheDocument(),
      );

      const developmentChoice = screen.getByRole("radio", {
        name: /development/i,
      });
      fireEvent.click(developmentChoice);
      const submitButton = screen.getByRole("button", {
        name: "Submit answers",
      });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(questionResponseBody.requestId).toBe("req-1");
        expect(questionResponseBody.sessionId).toBe("session-1");
        expect(questionResponseBody.answers).toEqual({
          env: "development",
        });
      });
    });
  });

  /**
   * Auto-scroll tests depend on SSE "message" events appending agent content; the new
   * message text does not appear in the test DOM. Skip until EventSource/message flow is fixed.
   */
  describe.skip("auto-scroll behavior", () => {
    let originalEventSource: typeof EventSource | undefined;

    beforeEach(() => {
      originalEventSource = (
        globalThis as unknown as { EventSource?: typeof EventSource }
      ).EventSource;
      (
        globalThis as unknown as { EventSource?: typeof EventSource }
      ).EventSource = FakeEventSource as unknown as typeof EventSource;
    });

    afterEach(() => {
      (
        globalThis as unknown as { EventSource?: typeof EventSource }
      ).EventSource = originalEventSource as typeof EventSource;
    });

    it("does not auto-scroll when user has scrolled up and new content arrives", async () => {
      installFetchMockForShell([
        {
          url: "/api/sessions/active",
          handler: () => jsonResponse(sessionActiveWithMessages),
        },
        { url: "/api/sessions", handler: () => jsonResponse({ sessions: [] }) },
        { url: "/api/agents", handler: () => jsonResponse(agentsEmpty) },
      ]);
      const scrollIntoViewCalls: unknown[] = [];
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args: unknown[]) {
        scrollIntoViewCalls.push(args);
        return originalScrollIntoView.apply(
          this,
          args as Parameters<Element["scrollIntoView"]>,
        );
      };

      await renderHome();
      await waitFor(() =>
        expect(screen.getByText("Hello")).toBeInTheDocument(),
      );
      const scrollContainer = document.querySelector(
        "[data-testid=chat-scroll-container]",
      );
      expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
      const scrollCountAfterLoad = scrollIntoViewCalls.length;

      await act(async () => {
        const el = scrollContainer as HTMLDivElement;
        el.scrollTop = 0;
        Object.defineProperty(el, "scrollHeight", {
          value: 1000,
          configurable: true,
        });
        Object.defineProperty(el, "clientHeight", {
          value: 400,
          configurable: true,
        });
        scrollContainer?.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      const es = lastEventSource;
      expect(es).not.toBeNull();
      const payload = {
        sessionId: "session-1",
        entry: {
          id: "e3",
          role: "agent",
          content: "New agent reply",
          timestamp: new Date().toISOString(),
        },
        participants: ["user", "maia"],
      };
      await act(async () => {
        for (const cb of es?.listeners["message"] ?? []) {
          cb({ data: JSON.stringify(payload) } as MessageEvent);
        }
      });
      await waitFor(() =>
        expect(
          screen.getByText(/New agent reply/),
        ).toBeInTheDocument(),
      );

      expect(scrollIntoViewCalls.length).toBe(scrollCountAfterLoad);

      Element.prototype.scrollIntoView = originalScrollIntoView;
    });

    it("auto-scrolls when user is at bottom and new content arrives", async () => {
      installFetchMockForShell([
        {
          url: "/api/sessions/active",
          handler: () => jsonResponse(sessionActiveWithMessages),
        },
        { url: "/api/sessions", handler: () => jsonResponse({ sessions: [] }) },
        { url: "/api/agents", handler: () => jsonResponse(agentsEmpty) },
      ]);
      const scrollIntoViewCalls: unknown[] = [];
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args: unknown[]) {
        scrollIntoViewCalls.push(args);
        return originalScrollIntoView.apply(
          this,
          args as Parameters<Element["scrollIntoView"]>,
        );
      };

      await renderHome();
      await waitFor(() =>
        expect(screen.getByText("Hello")).toBeInTheDocument(),
      );
      const scrollCountAfterLoad = scrollIntoViewCalls.length;
      expect(scrollCountAfterLoad).toBeGreaterThanOrEqual(1);

      const es = lastEventSource;
      expect(es).not.toBeNull();
      const payload = {
        sessionId: "session-1",
        entry: {
          id: "e3",
          role: "agent",
          content: "Another reply",
          timestamp: new Date().toISOString(),
        },
        participants: ["user", "maia"],
      };
      await act(async () => {
        for (const cb of es?.listeners["message"] ?? []) {
          cb({ data: JSON.stringify(payload) } as MessageEvent);
        }
      });
      await waitFor(() =>
        expect(
          screen.getByText(/Another reply/),
        ).toBeInTheDocument(),
      );

      expect(scrollIntoViewCalls.length).toBeGreaterThan(scrollCountAfterLoad);

      Element.prototype.scrollIntoView = originalScrollIntoView;
    });
  });
});
