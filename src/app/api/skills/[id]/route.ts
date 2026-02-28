/**
 * @fileoverview GET /api/skills/[id] (one skill), PUT (update), DELETE (remove).
 * @module app/api/skills/[id]/route
 */
import { NextRequest, NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { resolveSkillIdToPath } from "@/lib/skills/api";
import { loadSkillContent } from "@/lib/skills";
import { parseSkillFrontmatter, skillToMarkdown } from "@/lib/skills/parse";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  const filePath = resolveSkillIdToPath(id);
  if (!filePath || !ctx.fs.exists(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const skill = loadSkillContent(ctx.fs, filePath);
  if (!skill) {
    return NextResponse.json({ error: "Invalid skill file" }, { status: 404 });
  }
  return NextResponse.json({
    name: skill.name,
    description: skill.description,
    content: skill.content,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  const filePath = resolveSkillIdToPath(id);
  if (!filePath || !ctx.fs.exists(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const raw = ctx.fs.readFile(filePath);
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid skill file" }, { status: 400 });
  }

  let body: { name?: string; description?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : parsed.name;
  const description =
    typeof body.description === "string" ? body.description.trim() : parsed.description;
  const content = typeof body.content === "string" ? body.content : parsed.body;
  if (!name || !description) {
    return NextResponse.json({ error: "name and description cannot be empty" }, { status: 400 });
  }

  const markdown = skillToMarkdown(name, description, content);
  ctx.fs.writeFile(filePath, markdown);

  return NextResponse.json({
    skill: {
      id,
      name,
      description,
      sourcePath: filePath,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  const filePath = resolveSkillIdToPath(id);
  if (!filePath || !ctx.fs.exists(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  ctx.fs.deleteFile(filePath);
  return new NextResponse(null, { status: 204 });
}
