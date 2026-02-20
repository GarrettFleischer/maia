import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { credentialUpdate, credentialDelete } from "@/lib/security/credential-vault";

const updateSchema = z.object({ value: z.string() });

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  const { value } = updateSchema.parse(await req.json());
  credentialUpdate(key, value);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key } = await params;
  credentialDelete(key);
  return NextResponse.json({ ok: true });
}
