import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/instrumentation";
import { credentialCreate, credentialList } from "@/lib/security/credential-vault";

export async function GET() {
  const ctx = getAppContext();
  return NextResponse.json({ keys: credentialList(ctx) });
}

const createSchema = z.object({ key: z.string(), value: z.string() });

export async function POST(req: NextRequest) {
  const ctx = getAppContext();
  const { key, value } = createSchema.parse(await req.json());
  credentialCreate(ctx, key, value);
  return NextResponse.json({ ok: true }, { status: 201 });
}
