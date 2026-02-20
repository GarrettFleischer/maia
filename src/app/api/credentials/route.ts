import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { credentialCreate, credentialList } from "@/lib/security/credential-vault";

export async function GET() {
  return NextResponse.json({ keys: credentialList() });
}

const createSchema = z.object({ key: z.string(), value: z.string() });

export async function POST(req: NextRequest) {
  const { key, value } = createSchema.parse(await req.json());
  credentialCreate(key, value);
  return NextResponse.json({ ok: true }, { status: 201 });
}
