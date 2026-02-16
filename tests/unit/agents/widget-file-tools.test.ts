/**
 * @fileoverview Unit tests for widget file-based tools (widget_create_or_edit, widget_delete).
 * @module tests/unit/agents/widget-file-tools
 *
 * @brief Covers: create file in pending and review request; delete from pending/approved.
 */

import { describe, it, expect } from "bun:test";
import {
  createWidgetCreateOrEditTool,
  createWidgetDeleteTool,
} from "../../../src/agents/tools/widget-file-tools.js";
import type { FileSystem } from "../../../src/core/types.js";
import type { ToolContext } from "../../../src/agent/tools/base.js";
import type { WidgetReviewRequestsRepository } from "../../../src/agents/widget-review-requests.js";
import type { WidgetReviewRequest } from "../../../src/agents/widget-review-requests.js";
import { capturingLogger, mockCryptoProvider } from "../../helpers/index.js";

function defaultContext(): ToolContext {
  return {
    sessionId: "s1",
    channelId: "cli",
    senderId: "user-1",
    privacyMode: false,
  };
}

function mockFs(files: Map<string, string> = new Map()): FileSystem {
  return {
    async readFile(path: string) {
      const c = files.get(path);
      if (c === undefined) throw new Error("ENOENT");
      return c;
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async appendFile() {},
    async exists(path: string) {
      return files.has(path);
    },
    async readDir(dir: string) {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first) names.add(first);
        }
      }
      return Array.from(names);
    },
    async mkdir() {},
    async chmod() {},
    async stat() {
      return { size: 0, isFile: true, isDirectory: false, mtime: new Date() };
    },
    async checksum() {
      return "";
    },
    async remove(path: string) {
      files.delete(path);
    },
  };
}

function mockWidgetReviewRepo(created: WidgetReviewRequest[] = []): WidgetReviewRequestsRepository {
  return {
    async create(input) {
      const r: WidgetReviewRequest = {
        id: input.id,
        requestingAgentId: input.requestingAgentId,
        widgetId: input.widgetId,
        name: input.name ?? null,
        html: input.html,
        css: input.css,
        js: input.js,
        status: "pending",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      created.push(r);
      return r;
    },
    async getById() {
      return undefined;
    },
    async updateStatus() {
      return undefined;
    },
    async listByStatus() {
      return [];
    },
  };
}

describe("widget_create_or_edit", () => {
  it("writes file to pending and creates review request", async () => {
    const files = new Map<string, string>();
    const created: WidgetReviewRequest[] = [];
    let notified: WidgetReviewRequest | null = null;
    const tool = createWidgetCreateOrEditTool({
      logger: capturingLogger(),
      crypto: mockCryptoProvider(),
      fs: mockFs(files),
      getWidgetsPendingDir: () => "/data/widgets/pending",
      getWidgetsApprovedDir: () => "/data/widgets/approved",
      widgetReviewRequestsRepo: mockWidgetReviewRepo(created),
      resolveAgentId: () => "agent-a",
      onWidgetReviewRequest: (req) => {
        notified = req;
      },
    });
    const result = await tool.execute(
      {
        widgetId: "my-panel",
        name: "My Panel",
        html: "<div>Hi</div>",
        css: "div{}",
        js: "1+1;",
      },
      defaultContext()
    );
    expect(result.success).toBe(true);
    expect(files.get("/data/widgets/pending/agent-a_my-panel.html")).toContain("<!DOCTYPE html>");
    expect(files.get("/data/widgets/pending/agent-a_my-panel.html")).toContain("<div>Hi</div>");
    expect(created).toHaveLength(1);
    expect(created[0].requestingAgentId).toBe("agent-a");
    expect(created[0].widgetId).toBe("my-panel");
    expect(notified).not.toBeNull();
    expect(notified!.widgetId).toBe("my-panel");
  });

  it("returns failure when resolveAgentId returns undefined", async () => {
    const tool = createWidgetCreateOrEditTool({
      logger: capturingLogger(),
      crypto: mockCryptoProvider(),
      fs: mockFs(),
      getWidgetsPendingDir: () => "/p",
      getWidgetsApprovedDir: () => "/a",
      widgetReviewRequestsRepo: mockWidgetReviewRepo(),
      resolveAgentId: () => undefined,
      onWidgetReviewRequest: () => {},
    });
    const result = await tool.execute(
      { widgetId: "w", html: "", css: "", js: "" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("Could not determine");
  });

  it("returns failure when widgetId is missing", async () => {
    const tool = createWidgetCreateOrEditTool({
      logger: capturingLogger(),
      crypto: mockCryptoProvider(),
      fs: mockFs(),
      getWidgetsPendingDir: () => "/p",
      getWidgetsApprovedDir: () => "/a",
      widgetReviewRequestsRepo: mockWidgetReviewRepo(),
      resolveAgentId: () => "agent-a",
      onWidgetReviewRequest: () => {},
    });
    const result = await tool.execute(
      { html: "", css: "", js: "" },
      defaultContext()
    );
    expect(result.success).toBe(false);
    expect(result.content).toContain("widgetId");
  });
});

describe("widget_delete", () => {
  it("removes file from pending when present", async () => {
    const files = new Map<string, string>([
      ["/data/widgets/pending/agent-b_widget1.html", "<html></html>"],
    ]);
    const tool = createWidgetDeleteTool({
      logger: capturingLogger(),
      fs: mockFs(files),
      getWidgetsPendingDir: () => "/data/widgets/pending",
      getWidgetsApprovedDir: () => "/data/widgets/approved",
      resolveAgentId: () => "agent-b",
    });
    const result = await tool.execute({ widgetId: "widget1" }, defaultContext());
    expect(result.success).toBe(true);
    expect(files.has("/data/widgets/pending/agent-b_widget1.html")).toBe(false);
  });

  it("removes file from approved when present", async () => {
    const files = new Map<string, string>([
      ["/data/widgets/approved/agent-c_foo.html", "<html></html>"],
    ]);
    const tool = createWidgetDeleteTool({
      logger: capturingLogger(),
      fs: mockFs(files),
      getWidgetsPendingDir: () => "/data/widgets/pending",
      getWidgetsApprovedDir: () => "/data/widgets/approved",
      resolveAgentId: () => "agent-c",
    });
    const result = await tool.execute({ widgetId: "foo" }, defaultContext());
    expect(result.success).toBe(true);
    expect(files.has("/data/widgets/approved/agent-c_foo.html")).toBe(false);
  });

  it("returns failure when no widget found", async () => {
    const files = new Map<string, string>();
    const tool = createWidgetDeleteTool({
      logger: capturingLogger(),
      fs: mockFs(files),
      getWidgetsPendingDir: () => "/p",
      getWidgetsApprovedDir: () => "/a",
      resolveAgentId: () => "agent-d",
    });
    const result = await tool.execute({ widgetId: "nonexistent" }, defaultContext());
    expect(result.success).toBe(false);
    expect(result.content).toContain("No widget found");
  });

  it("returns failure when resolveAgentId returns undefined", async () => {
    const tool = createWidgetDeleteTool({
      logger: capturingLogger(),
      fs: mockFs(),
      getWidgetsPendingDir: () => "/p",
      getWidgetsApprovedDir: () => "/a",
      resolveAgentId: () => undefined,
    });
    const result = await tool.execute({ widgetId: "w" }, defaultContext());
    expect(result.success).toBe(false);
    expect(result.content).toContain("Could not determine");
  });
});
