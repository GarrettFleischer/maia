/**
 * @fileoverview Session-scoped browser automation tools: navigate, snapshot (with refs), click, type, fill, select_option, go_back, close.
 * Uses Brave via Playwright; one browser page per session. Snapshot injects data-maia-ref for stable element refs.
 * @module lib/tools/browser-tools
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { getOrCreatePage, closeSession } from "./browser-session";
import type { Tool, ToolContext } from "./types";

const REF_ATTR = "data-maia-ref";

function selectorFromRef(ref: string): string {
  return `[${REF_ATTR}="${ref}"]`;
}

function getLocator(page: import("playwright").Page, ref: string | undefined, selector: string | undefined) {
  if (ref != null && ref !== "") return page.locator(selectorFromRef(ref));
  if (selector != null && selector !== "") return page.locator(selector);
  throw new Error("Element not found: provide ref (from browser_snapshot) or selector");
}

// ─── browser_navigate ────────────────────────────────────────────────────────

const navigateSchema = z.object({
  url: z.string().describe("URL to open"),
});

export const browserNavigateTool: Tool<z.infer<typeof navigateSchema>, { ok: boolean; url: string }> = {
  name: "browser_navigate",
  description: "Navigate the session browser to a URL. Creates the browser session if needed. Example: browser_navigate({ url: 'https://example.com' }).",
  schema: navigateSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(navigateSchema) };
  },
  async execute(args, ctx) {
    const getPage = ctx.getBrowserPage ?? getOrCreatePage;
    const { page } = await getPage(ctx.sessionId);
    await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { ok: true, url: args.url };
  },
};

// ─── browser_snapshot (with refs) ────────────────────────────────────────────

const snapshotSchema = z.object({
  interactiveOnly: z.boolean().optional().describe("If true, only include interactive elements (default true)"),
  maxDepth: z.number().optional().describe("Maximum depth of tree (default 10)"),
});

/** In-page snapshot: injects data-maia-ref and returns a text list. Must be serializable for page.evaluate. */
function SNAPSHOT_FN(opts: { interactiveOnly: boolean; maxDepth: number }) {
  const refAttr = "data-maia-ref";
  const sel = opts.interactiveOnly
    ? "a, button, input, select, textarea, [contenteditable=true], [role=button], [role=link], [role=textbox], [role=menuitem], [role=option], [onclick]"
    : "a, button, input, select, textarea, [contenteditable], [role], h1, h2, h3, h4, h5, h6";
  const nodes = document.querySelectorAll(sel);
  const items: Array<{ ref: string; tag: string; name: string; role: string; type?: string; value?: string; href?: string }> = [];
  nodes.forEach((el: Element, i: number) => {
    const ref = String(i + 1);
    (el as HTMLElement).setAttribute(refAttr, ref);
    const tag = el.tagName.toLowerCase();
    const name =
      (el as HTMLElement).getAttribute("aria-label") ||
      (el as HTMLElement).getAttribute("title") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLButtonElement).innerText?.slice(0, 80) ||
      (el as HTMLAnchorElement).textContent?.slice(0, 80) ||
      "";
    const role = (el as HTMLElement).getAttribute("role") || "";
    const type = (el as HTMLInputElement).type || undefined;
    const value = (el as HTMLInputElement).value ?? (el as HTMLSelectElement).value ?? undefined;
    const href = (el as HTMLAnchorElement).href || undefined;
    items.push({ ref, tag, name, role, type, value, href });
  });
  return items
    .map((i) => {
      const parts = [`[${i.ref}] ${i.tag}`];
      if (i.name) parts.push(`"${i.name.replace(/"/g, "'")}"`);
      if (i.role) parts.push(`role=${i.role}`);
      if (i.type) parts.push(`type=${i.type}`);
      if (i.value != null) parts.push(`value=${String(i.value).slice(0, 40)}`);
      if (i.href) parts.push(`href=${i.href}`);
      return parts.join(" ");
    })
    .join("\n");
}

export const browserSnapshotTool: Tool<z.infer<typeof snapshotSchema>, { snapshot: string }> = {
  name: "browser_snapshot",
  description: "Get a snapshot of the current page with stable element refs for use in browser_click, browser_type, browser_fill, browser_select_option. Example: browser_snapshot({}).",
  schema: snapshotSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(snapshotSchema) };
  },
  async execute(args, ctx) {
    const getPage = ctx.getBrowserPage ?? getOrCreatePage;
    const { page } = await getPage(ctx.sessionId);
    const interactiveOnly = args.interactiveOnly !== false;
    const maxDepth = args.maxDepth ?? 10;
    const snapshot = await page.evaluate(SNAPSHOT_FN, {
      interactiveOnly,
      maxDepth,
    });
    return { snapshot: snapshot ?? "" };
  },
};

// ─── browser_click ───────────────────────────────────────────────────────────

const clickSchema = z.object({
  ref: z.string().optional().describe("Element ref from browser_snapshot"),
  selector: z.string().optional().describe("CSS selector (alternative to ref)"),
  button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
});

export const browserClickTool: Tool<z.infer<typeof clickSchema>, { ok: boolean }> = {
  name: "browser_click",
  description: "Click an element by ref (from browser_snapshot) or CSS selector. Example: browser_click({ ref: 'el-1' }).",
  schema: clickSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(clickSchema) };
  },
  async execute(args, ctx) {
    const getPage = ctx.getBrowserPage ?? getOrCreatePage;
    const { page } = await getPage(ctx.sessionId);
    const loc = getLocator(page, args.ref, args.selector);
    await loc.click({
      button: args.button ?? "left",
      modifiers: args.modifiers,
      timeout: 10_000,
    });
    return { ok: true };
  },
};

// ─── browser_type ───────────────────────────────────────────────────────────

const typeSchema = z.object({
  ref: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().describe("Text to type"),
  clear: z.boolean().optional().describe("Clear before typing (default false)"),
  submit: z.boolean().optional().describe("Press Enter after (default false)"),
});

export const browserTypeTool: Tool<z.infer<typeof typeSchema>, { ok: boolean }> = {
  name: "browser_type",
  description: "Type text into an editable element (by ref or selector). Use browser_fill to replace value in one go. Example: browser_type({ ref: 'el-1', text: 'hello' }).",
  schema: typeSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(typeSchema) };
  },
  async execute(args, ctx) {
    const getPage = ctx.getBrowserPage ?? getOrCreatePage;
    const { page } = await getPage(ctx.sessionId);
    const loc = getLocator(page, args.ref, args.selector);
    if (args.clear) {
      await loc.clear();
      await loc.fill(args.text, { timeout: 10_000 });
    } else {
      const current = await loc.inputValue().catch(() => "");
      await loc.fill(current + args.text, { timeout: 10_000 });
    }
    if (args.submit) await loc.press("Enter");
    return { ok: true };
  },
};

// ─── browser_fill ───────────────────────────────────────────────────────────

const fillSchema = z.object({
  ref: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().describe("Value to set (clears then fills)"),
});

export const browserFillTool: Tool<z.infer<typeof fillSchema>, { ok: boolean }> = {
  name: "browser_fill",
  description: "Clear and set the value of an input (by ref or selector). Example: browser_fill({ ref: 'el-1', value: 'new value' }).",
  schema: fillSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(fillSchema) };
  },
  async execute(args, ctx) {
    const getPage = ctx.getBrowserPage ?? getOrCreatePage;
    const { page } = await getPage(ctx.sessionId);
    const loc = getLocator(page, args.ref, args.selector);
    await loc.fill(args.value, { timeout: 10_000 });
    return { ok: true };
  },
};

// ─── browser_select_option ───────────────────────────────────────────────────

const selectOptionSchema = z.object({
  ref: z.string().optional(),
  selector: z.string().optional(),
  values: z.array(z.string()).describe("Option value(s) to select"),
});

export const browserSelectOptionTool: Tool<z.infer<typeof selectOptionSchema>, { ok: boolean }> = {
  name: "browser_select_option",
  description: "Select option(s) in a dropdown by ref or selector. Example: browser_select_option({ ref: 'el-1', value: 'opt1' }).",
  schema: selectOptionSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(selectOptionSchema) };
  },
  async execute(args, ctx) {
    const getPage = ctx.getBrowserPage ?? getOrCreatePage;
    const { page } = await getPage(ctx.sessionId);
    const loc = getLocator(page, args.ref, args.selector);
    await loc.selectOption(args.values, { timeout: 10_000 });
    return { ok: true };
  },
};

// ─── browser_go_back ─────────────────────────────────────────────────────────

const goBackSchema = z.object({});

export const browserGoBackTool: Tool<z.infer<typeof goBackSchema>, { ok: boolean }> = {
  name: "browser_go_back",
  description: "Navigate back in session browser history. Example: browser_go_back({}).",
  schema: goBackSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(goBackSchema) };
  },
  async execute(_args, ctx) {
    const getPage = ctx.getBrowserPage ?? getOrCreatePage;
    const { page } = await getPage(ctx.sessionId);
    await page.goBack({ timeout: 10_000 });
    return { ok: true };
  },
};

// ─── browser_close ───────────────────────────────────────────────────────────

const closeSchema = z.object({});

export const browserCloseTool: Tool<z.infer<typeof closeSchema>, { ok: boolean }> = {
  name: "browser_close",
  description: "Close the session browser and release resources. Example: browser_close({}).",
  schema: closeSchema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(closeSchema) };
  },
  async execute(_args, ctx) {
    if (ctx.getBrowserPage) {
      const entry = await ctx.getBrowserPage(ctx.sessionId).catch(() => null);
      if (entry) await entry.browser.close();
    } else {
      await closeSession(ctx.sessionId);
    }
    return { ok: true };
  },
};

/** All browser tools for registry. */
export const browserTools = [
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserFillTool,
  browserSelectOptionTool,
  browserGoBackTool,
  browserCloseTool,
];