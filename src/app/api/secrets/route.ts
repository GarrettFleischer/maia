/**
 * @fileoverview Secrets API: list keys, set key, delete key. Values never returned.
 * @module app/api/secrets/route
 *
 * GET /api/secrets — 200 + { keys: string[] }.
 * POST /api/secrets — body: { key, value }. 201 or 400.
 * DELETE /api/secrets — body: { key } or ?key=... 204 or 400.
 */

import { openDb } from "@/db/client";
import { createSecretsRepository } from "@/db/secrets";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";

function getEncryptionKey(): string {
  const key = process.env.MAIA_SECRETS_ENCRYPTION_KEY ?? process.env.MAIA_API_KEY ?? "";
  if (!key || key.length < 32) {
    throw new Error("MAIA_SECRETS_ENCRYPTION_KEY or MAIA_API_KEY (min 32 chars) required for secrets");
  }
  return key.slice(0, 32);
}

export async function GET(request: Request): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  try {
    const db = await openDb(createContainer().dbPath);
    try {
      const repo = createSecretsRepository(db, getEncryptionKey());
      const keys = await repo.listKeys();
      return NextResponse.json({ keys });
    } finally {
      db.close();
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Secrets unavailable" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  let body: { key?: string; value?: string };
  try {
    body = (await request.json()) as { key?: string; value?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const value = typeof body.value === "string" ? body.value : "";
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
  try {
    const db = await openDb(createContainer().dbPath);
    try {
      const repo = createSecretsRepository(db, getEncryptionKey());
      await repo.set(key, value);
      return NextResponse.json({ ok: true }, { status: 201 });
    } finally {
      db.close();
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to set secret" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  let key: string;
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { key?: string };
      key = typeof body.key === "string" ? body.key.trim() : "";
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  } else {
    const u = new URL(request.url);
    key = u.searchParams.get("key") ?? "";
  }
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
  try {
    const db = await openDb(createContainer().dbPath);
    try {
      const repo = createSecretsRepository(db, getEncryptionKey());
      await repo.delete(key);
      return new NextResponse(null, { status: 204 });
    } finally {
      db.close();
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to delete secret" },
      { status: 500 }
    );
  }
}
