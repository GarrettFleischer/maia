/**
 * @fileoverview fetch_web_page tool: open a URL in a real browser, extract title and main text, filter for injection, return WebPageContent.
 * Uses Playwright (one-off browser) to improve resilience to bot protections.
 * @module lib/tools/fetch-web-page
 */

import { z } from "zod";
import { chromium } from "playwright";
import { zodToJsonSchema } from "../zod-to-json";
import { filterText } from "../security/injection-filter";
import { getBraveExecutablePath } from "./browser-path";
import type { Tool, ToolContext } from "./types";
import type { WebPageContent } from "../types";
import type { LaunchOneOffBrowser } from "../context";

const NAVIGATION_TIMEOUT_MS = 30_000;

const schema = z.object({
  url: z.string().describe("URL of the page to fetch"),
  maxContentLength: z.number().optional().describe("Maximum content length in characters (default: no limit)"),
});

async function launchRealOneOffBrowser(): Promise<{
  page: { goto(url: string): Promise<void>; evaluate<R>(fn: () => R): Promise<R> };
  close(): Promise<void>;
}> {
  const bravePath = getBraveExecutablePath();
  const browser = await chromium.launch({
    executablePath: bravePath ?? undefined,
    headless: true,
    args: bravePath ? ["--no-sandbox"] : undefined,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
  return {
    page: {
      goto: async (url: string) => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      },
      evaluate: <R>(fn: () => R) => page.evaluate(fn),
    },
    close: () => browser.close(),
  };
}

/**
 * Fetches a web page in a one-off browser and returns title + main text content, injection-filtered.
 * @param args - url (required), optional maxContentLength
 * @param ctx - ToolContext; uses ctx.launchOneOffBrowser when set (e.g. tests)
 * @returns WebPageContent or throws on navigation/timeout error
 */
async function execute(
  args: z.infer<typeof schema>,
  ctx: ToolContext
): Promise<WebPageContent> {
  const launcher: LaunchOneOffBrowser =
    ctx.launchOneOffBrowser ?? launchRealOneOffBrowser;
  const { page, close } = await launcher();
  try {
    await page.goto(args.url);
    const raw = await page.evaluate(() => ({
      title: document.title ?? "",
      bodyText: document.body?.innerText ?? "",
    }));
    const source = `fetch_web_page:${args.url}`;
    const filtered = filterText(raw.bodyText, source);
    let content = filtered.text;
    if (args.maxContentLength != null && content.length > args.maxContentLength) {
      content = content.slice(0, args.maxContentLength);
    }
    return {
      url: args.url,
      title: raw.title,
      content,
      fetchedAt: new Date().toISOString(),
      injectionWarning: filtered.redacted
        ? "Content was filtered for potential injection"
        : undefined,
    };
  } finally {
    await close();
  }
}

export const fetchWebPageTool: Tool<z.infer<typeof schema>, WebPageContent> = {
  name: "fetch_web_page",
  description:
    "Open a URL in a real browser and return the page title and main text content. Use when you need the full content of a page (e.g. after web_search). Content is filtered for security. Example: fetch_web_page({ url: 'https://example.com/docs' }).",
  schema,
  toDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: zodToJsonSchema(schema),
    };
  },
  execute,
};
