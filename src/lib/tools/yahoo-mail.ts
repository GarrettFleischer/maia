/**
 * @fileoverview Yahoo Mail IMAP tools for listing, reading, searching, and organizing email.
 * @module lib/tools/yahoo-mail
 *
 * Requires two credentials in the vault:
 *   YAHOO_EMAIL        — your Yahoo email address
 *   YAHOO_APP_PASSWORD — app-specific password from Yahoo Account Security settings
 */

import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { credentialGet } from "../security/credential-vault";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Tool, ToolContext } from "./types";

const IMAP_HOST = "imap.mail.yahoo.com";
const IMAP_PORT = 993;
const TRASH_FOLDER = "Trash";

// ---------------------------------------------------------------------------
// Connection helper
// ---------------------------------------------------------------------------

function buildClient(email: string, password: string): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });
}

async function withImap<T>(ctx: ToolContext, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const email = credentialGet(ctx, "YAHOO_EMAIL");
  const password = credentialGet(ctx, "YAHOO_APP_PASSWORD");
  const client = buildClient(email, password);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

// ---------------------------------------------------------------------------
// makeTool factory (same pattern as task-tracker.ts)
// ---------------------------------------------------------------------------

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

// ---------------------------------------------------------------------------
// Tool: email_list_folders
// ---------------------------------------------------------------------------

export const emailListFoldersTool = makeTool(
  "email_list_folders",
  "List all Yahoo Mail folders/mailboxes (Inbox, Sent, Trash, Spam, and any custom folders).",
  z.object({}),
  async (_args, ctx) => {
    return withImap(ctx, async (client) => {
      const list = await client.list();
      return list.map((mb) => ({
        path: mb.path,
        name: mb.name,
        delimiter: mb.delimiter,
        specialUse: mb.specialUse ?? null,
        flags: [...mb.flags],
      }));
    });
  }
);

// ---------------------------------------------------------------------------
// Tool: email_list
// ---------------------------------------------------------------------------

export const emailListTool = makeTool(
  "email_list",
  "List emails in a Yahoo Mail folder with pagination. Returns sender, subject, date, UID, and read/starred status. Most recent emails first.",
  z.object({
    folder: z.string().optional().describe("Folder path (default: INBOX)"),
    limit: z.number().optional().describe("Max emails to return (default: 20, max: 100)"),
    offset: z.number().optional().describe("Number of emails to skip for pagination (default: 0)"),
    unreadOnly: z.boolean().optional().describe("If true, return only unread emails"),
  }),
  async ({ folder = "INBOX", limit = 20, offset = 0, unreadOnly = false }, ctx) => {
    const max = Math.min(limit, 100);
    return withImap(ctx, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const criteria = unreadOnly ? { seen: false } : { all: true };
        const rawUids = await client.search(criteria, { uid: true });
        const uids: number[] = rawUids || [];
        // Most recent UIDs are largest; reverse to get newest first
        const sorted = [...uids].sort((a, b) => b - a);
        const page = sorted.slice(offset, offset + max);

        if (page.length === 0) return { folder, total: uids.length, offset, returned: 0, emails: [] };

        const results: unknown[] = [];
        const range = page.join(",");
        for await (const msg of client.fetch(range, { uid: true, envelope: true, flags: true }, { uid: true })) {
          const env = msg.envelope;
          const from = env?.from?.[0];
          results.push({
            uid: msg.uid,
            from: from?.address ?? from?.name ?? "",
            fromName: from?.name ?? "",
            subject: env?.subject ?? "(no subject)",
            date: env?.date?.toISOString() ?? null,
            read: msg.flags?.has("\\Seen") ?? false,
            starred: msg.flags?.has("\\Flagged") ?? false,
          });
        }

        // Re-sort by UID descending (fetch order may vary)
        const sorted2 = (results as { uid: number }[]).sort((a, b) => b.uid - a.uid);
        return { folder, total: uids.length, offset, returned: sorted2.length, emails: sorted2 };
      } finally {
        lock.release();
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Tool: email_read
// ---------------------------------------------------------------------------

export const emailReadTool = makeTool(
  "email_read",
  "Fetch the full content of an email by its UID, including body text. Marks the email as read.",
  z.object({
    uid: z.number().describe("Email UID (from email_list or email_search)"),
    folder: z.string().optional().describe("Folder path (default: INBOX)"),
  }),
  async ({ uid, folder = "INBOX" }, ctx) => {
    return withImap(ctx, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const dl = await client.download(String(uid), undefined, { uid: true });
        if (!dl) throw new Error(`Email UID ${uid} not found in ${folder}`);

        // Collect the readable stream into a Buffer
        const chunks: Buffer[] = [];
        for await (const chunk of dl.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        const raw = Buffer.concat(chunks);

        const parsed = await simpleParser(raw);
        const from = parsed.from?.value?.[0];
        const toList = (parsed.to && !Array.isArray(parsed.to) ? parsed.to.value : (parsed.to ?? []));

        return {
          uid,
          folder,
          from: from?.address ?? "",
          fromName: from?.name ?? "",
          to: toList.map((a: { address?: string; name?: string }) => a.address ?? "").join(", "),
          subject: parsed.subject ?? "(no subject)",
          date: parsed.date?.toISOString() ?? null,
          bodyText: parsed.text ?? "",
          bodyHtml: parsed.html ? "(HTML body available — use bodyText for plain text)" : null,
          attachments: parsed.attachments.map((a) => ({
            filename: a.filename ?? "attachment",
            contentType: a.contentType,
            size: a.size,
          })),
        };
      } finally {
        lock.release();
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Tool: email_search
// ---------------------------------------------------------------------------

export const emailSearchTool = makeTool(
  "email_search",
  "Search emails in a folder. Supports searching by subject, from address, or body text. Returns matching emails (most recent first).",
  z.object({
    query: z.string().describe("Search string — matched against subject, from, and body"),
    folder: z.string().optional().describe("Folder to search (default: INBOX)"),
    limit: z.number().optional().describe("Max results to return (default: 20)"),
    unreadOnly: z.boolean().optional().describe("Restrict to unread emails only"),
  }),
  async ({ query, folder = "INBOX", limit = 20, unreadOnly = false }, ctx) => {
    const max = Math.min(limit, 100);
    return withImap(ctx, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const criteria: Record<string, unknown> = {
          or: [{ subject: query }, { from: query }, { body: query }],
        };
        if (unreadOnly) criteria.seen = false;

        const rawUids = await client.search(criteria, { uid: true });
        const uids: number[] = rawUids || [];
        const sorted = [...uids].sort((a, b) => b - a).slice(0, max);

        if (sorted.length === 0) return { folder, query, results: [] };

        const results: unknown[] = [];
        const range = sorted.join(",");
        for await (const msg of client.fetch(range, { uid: true, envelope: true, flags: true }, { uid: true })) {
          const env = msg.envelope;
          const from = env?.from?.[0];
          results.push({
            uid: msg.uid,
            from: from?.address ?? from?.name ?? "",
            fromName: from?.name ?? "",
            subject: env?.subject ?? "(no subject)",
            date: env?.date?.toISOString() ?? null,
            read: msg.flags?.has("\\Seen") ?? false,
            starred: msg.flags?.has("\\Flagged") ?? false,
          });
        }

        const sorted2 = (results as { uid: number }[]).sort((a, b) => b.uid - a.uid);
        return { folder, query, results: sorted2 };
      } finally {
        lock.release();
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Tool: email_move
// ---------------------------------------------------------------------------

export const emailMoveTool = makeTool(
  "email_move",
  "Move an email from one folder to another. Use email_list_folders to see available folder paths.",
  z.object({
    uid: z.number().describe("Email UID to move"),
    toFolder: z.string().describe("Destination folder path (e.g. 'Archive', 'Bulk Mail')"),
    fromFolder: z.string().optional().describe("Source folder (default: INBOX)"),
  }),
  async ({ uid, toFolder, fromFolder = "INBOX" }, ctx) => {
    return withImap(ctx, async (client) => {
      const lock = await client.getMailboxLock(fromFolder);
      try {
        await client.messageMove(String(uid), toFolder, { uid: true });
        return { success: true, uid, fromFolder, toFolder };
      } finally {
        lock.release();
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Tool: email_mark
// ---------------------------------------------------------------------------

export const emailMarkTool = makeTool(
  "email_mark",
  "Mark an email as read, unread, starred, or unstarred.",
  z.object({
    uid: z.number().describe("Email UID to mark"),
    mark: z.enum(["read", "unread", "starred", "unstarred"]).describe("Action to apply"),
    folder: z.string().optional().describe("Folder containing the email (default: INBOX)"),
  }),
  async ({ uid, mark, folder = "INBOX" }, ctx) => {
    return withImap(ctx, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uidStr = String(uid);
        if (mark === "read") {
          await client.messageFlagsAdd(uidStr, ["\\Seen"], { uid: true });
        } else if (mark === "unread") {
          await client.messageFlagsRemove(uidStr, ["\\Seen"], { uid: true });
        } else if (mark === "starred") {
          await client.messageFlagsAdd(uidStr, ["\\Flagged"], { uid: true });
        } else {
          await client.messageFlagsRemove(uidStr, ["\\Flagged"], { uid: true });
        }
        return { success: true, uid, mark, folder };
      } finally {
        lock.release();
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Tool: email_delete (moves to Trash — reversible)
// ---------------------------------------------------------------------------

export const emailDeleteTool = makeTool(
  "email_delete",
  "Move an email to the Trash folder (reversible). The email is not permanently deleted.",
  z.object({
    uid: z.number().describe("Email UID to delete (move to Trash)"),
    folder: z.string().optional().describe("Source folder (default: INBOX)"),
  }),
  async ({ uid, folder = "INBOX" }, ctx) => {
    return withImap(ctx, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageMove(String(uid), TRASH_FOLDER, { uid: true });
        return { success: true, uid, movedTo: TRASH_FOLDER };
      } finally {
        lock.release();
      }
    });
  }
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const yahooMailTools: Tool[] = [
  emailListFoldersTool,
  emailListTool,
  emailReadTool,
  emailSearchTool,
  emailMoveTool,
  emailMarkTool,
  emailDeleteTool,
];
