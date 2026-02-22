/**
 * @fileoverview Tests for browser automation tools (navigate, snapshot, click, fill, select_option, go_back, close).
 * Uses a fake browser page (getBrowserPage) so no real Playwright launch in tests.
 * @module __tests__/lib/tools/browser-tools.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../../helpers/fakes";
import type { ToolContext } from "@/lib/tools/types";
import type { GetBrowserPage } from "@/lib/context";
import {
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserFillTool,
  browserSelectOptionTool,
  browserGoBackTool,
  browserCloseTool,
} from "@/lib/tools/browser-tools";

const SESSION = "browser-tools-test-session";

function makeToolCtx(getBrowserPage?: GetBrowserPage): ToolContext {
  const ctx = makeTestContext({ getBrowserPage });
  return {
    ...ctx,
    agentId: "agent-1",
    sessionId: SESSION,
    volumeRoot: "/workspace",
  };
}

/** In-memory store and fake page for tests. */
function makeFakeBrowserStore() {
  const store = new Map<
    string,
    {
      browser: { close(): Promise<void> };
      page: {
        _url: string;
        _prevUrl: string;
        _inputValues: Map<string, string>;
        goto(url: string): Promise<void>;
        evaluate<R>(fn: (opts: { interactiveOnly: boolean; maxDepth: number }) => R, opts: unknown): Promise<R>;
        goBack(): Promise<void>;
        url(): string;
        locator(selector: string): {
          click(): Promise<void>;
          clear(): Promise<void>;
          fill(value: string): Promise<void>;
          inputValue(): Promise<string>;
          press(key: string): Promise<void>;
          selectOption(values: string[]): Promise<void>;
        };
      };
    }
  >();

  function createPage() {
    const _inputValues = new Map<string, string>();
    let _url = "about:blank";
    let _prevUrl = "about:blank";
    const page = {
      _url,
      _prevUrl,
      _inputValues,
      async goto(url: string) {
        _prevUrl = _url;
        _url = url;
      },
      async evaluate<R>(fn: (opts: { interactiveOnly: boolean; maxDepth: number }) => R, opts: unknown) {
        const o = opts as { interactiveOnly: boolean; maxDepth: number };
        if (o && typeof o.interactiveOnly === "boolean") {
          return "[1] a \"Link\" href=#\n[2] button \"Submit\"\n[3] input type=text placeholder=Search" as R;
        }
        return undefined as R;
      },
      async goBack() {
        _url = _prevUrl;
      },
      url: () => _url,
      locator(selector: string) {
        const key = selector.replace(/\[data-maia-ref="(\d+)"\]/, "$1");
        return {
          async click() {},
          async clear() {
            _inputValues.set(key, "");
          },
          async fill(value: string) {
            _inputValues.set(key, value);
          },
          async inputValue() {
            return _inputValues.get(key) ?? "";
          },
          async press() {},
          async selectOption(values: string[]) {
            _inputValues.set(key, values[0] ?? "");
          },
        };
      },
    };
    return page;
  }

  const getBrowserPage: GetBrowserPage = async (sessionId) => {
    let entry = store.get(sessionId);
    if (!entry) {
      const page = createPage();
      entry = {
        browser: {
          async close() {
            store.delete(sessionId);
          },
        },
        page,
      };
      store.set(sessionId, entry);
    }
    return entry;
  };

  return { store, getBrowserPage };
}

describe("browser tools", () => {
  it("browser_navigate returns ok and url", async () => {
    const { getBrowserPage } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    const result = await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://example.com");
  });

  it("browser_snapshot returns refs for interactive elements", async () => {
    const { getBrowserPage } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    const out = await browserSnapshotTool.execute({}, ctx);
    expect(out.snapshot).toContain("[1]");
    expect(out.snapshot).toContain("a ");
    expect(out.snapshot).toContain("button ");
  });

  it("browser_click by ref does not throw", async () => {
    const { getBrowserPage } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    await browserSnapshotTool.execute({}, ctx);
    await expect(browserClickTool.execute({ ref: "1" }, ctx)).resolves.toEqual({ ok: true });
  });

  it("browser_fill by ref sets value (read via fake store)", async () => {
    const { getBrowserPage, store } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    await browserSnapshotTool.execute({}, ctx);
    await browserFillTool.execute({ ref: "1", value: "hello" }, ctx);
    const entry = store.get(SESSION);
    expect(entry).toBeDefined();
    const value = await entry!.page.locator("[data-maia-ref=\"1\"]").inputValue();
    expect(value).toBe("hello");
  });

  it("browser_type with clear replaces value", async () => {
    const { getBrowserPage, store } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    await browserSnapshotTool.execute({}, ctx);
    await browserTypeTool.execute({ ref: "3", text: "new", clear: true }, ctx);
    const entry = store.get(SESSION);
    const value = await entry!.page.locator("[data-maia-ref=\"3\"]").inputValue();
    expect(value).toBe("new");
  });

  it("browser_select_option by ref", async () => {
    const { getBrowserPage, store } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    await browserSnapshotTool.execute({}, ctx);
    await browserSelectOptionTool.execute({ ref: "1", values: ["b"] }, ctx);
    const entry = store.get(SESSION);
    const value = await entry!.page.locator("[data-maia-ref=\"1\"]").inputValue();
    expect(value).toBe("b");
  });

  it("browser_go_back updates url", async () => {
    const { getBrowserPage, store } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://page1.com" }, ctx);
    await browserNavigateTool.execute({ url: "https://page2.com" }, ctx);
    await browserGoBackTool.execute({}, ctx);
    const entry = store.get(SESSION);
    expect(entry!.page.url()).toBe("https://page1.com");
  });

  it("browser_close calls browser.close and clears session", async () => {
    const { getBrowserPage, store } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    expect(store.has(SESSION)).toBe(true);
    await browserCloseTool.execute({}, ctx);
    expect(store.has(SESSION)).toBe(false);
  });

  it("browser_click with selector works", async () => {
    const { getBrowserPage } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    await expect(browserClickTool.execute({ selector: "#btn" }, ctx)).resolves.toEqual({ ok: true });
  });

  it("browser_click without ref or selector throws", async () => {
    const { getBrowserPage } = makeFakeBrowserStore();
    const ctx = makeToolCtx(getBrowserPage);
    await browserNavigateTool.execute({ url: "https://example.com" }, ctx);
    await expect(browserClickTool.execute({}, ctx)).rejects.toThrow("Element not found");
  });
});
