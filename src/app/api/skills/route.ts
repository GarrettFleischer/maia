/**
 * @fileoverview GET /api/skills (list), POST /api/skills (create).
 * @module app/api/skills/route
 */
import { NextRequest, NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { listSkillsForApi, normalizeSkillFilename } from "@/lib/skills/api";
import { skillToMarkdown } from "@/lib/skills/parse";
import { getSkillsDir, getAgentSkillsDir } from "@/lib/data-dir";
import path from "path";

export async function GET(req: NextRequest) {
  const ctx = await ensureAppContext();
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "global") as "global" | "agent";
  const agentId = url.searchParams.get("agentId") ?? undefined;

  if (scope !== "global" && scope !== "agent") {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }
  if (scope === "agent" && !agentId) {
    return NextResponse.json({ error: "agentId required when scope=agent" }, { status: 400 });
  }

  const skills = listSkillsForApi(ctx, scope, agentId);
  return NextResponse.json({ skills });
}

export async function POST(req: NextRequest) {
  const ctx = await ensureAppContext();
  let body: {
    scope?: "global" | "agent";
    agentId?: string;
    filename?: string;
    name?: string;
    description?: string;
    content?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const scope = body.scope ?? "global";
  const agentId = body.agentId;
  if (scope !== "global" && scope !== "agent") {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }
  if (scope === "agent" && !agentId) {
    return NextResponse.json({ error: "agentId required when scope=agent" }, { status: 400 });
  }

  const slug = normalizeSkillFilename(body.filename ?? "");
  if (!slug) {
    return NextResponse.json({ error: "Invalid or missing filename" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!name || !description) {
    return NextResponse.json({ error: "name and description are required" }, { status: 400 });
  }

  const dir = scope === "global" ? getSkillsDir() : getAgentSkillsDir(agentId!);
  if (!ctx.fs.exists(dir)) {
    ctx.fs.mkdirp(dir);
  }
  const filePath = path.join(dir, `${slug}.md`);
  const markdown = skillToMarkdown(name, description, content);
  ctx.fs.writeFile(filePath, markdown);

  const id = scope === "global" ? slug : `${agentId}/${slug}`;
  return NextResponse.json(
    {
      skill: {
        id,
        name,
        description,
        sourcePath: filePath,
        scope,
        ...(scope === "agent" && { agentId }),
      },
    },
    { status: 201 },
  );
}
