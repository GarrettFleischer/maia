/**
 * @fileoverview Seeds default agent directories with PERSONA.md plus workspace/memory/user skeletons.
 * @module lib/tools/agent-management
 */
import path from "path";
import { getDefaultAgentDir, getDefaultMaiaDir } from "../data-dir";
import type { Tool } from "./types";
import type { AppContext } from "../context";

const FALLBACK_PERSONA =
  "# Persona\n\nYou are {{name}}, an AI assistant inside Maia. Your behavior and priorities live in this file (`PERSONA.md`). Improve it over time via **file_write** (`PERSONA.md`) when intent is clear.\n";

/**
 * Reads a template file from defaults/agent (with defaults/maia override when agentId is maia).
 * @param ctx - App context (uses ctx.fs)
 * @param filename - e.g. "PERSONA.md"
 * @param fallback - Used when file is missing or unreadable in both locations
 * @param agentId - When "maia", prefer defaults/maia
 * @returns File content or fallback
 */
function readDefaultIdentityFile(
  ctx: AppContext,
  filename: string,
  fallback: string,
  agentId?: string,
): string {
  if (agentId === "maia") {
    try {
      const maiaPath = path.join(getDefaultMaiaDir(), filename);
      const raw = ctx.fs.readFile(maiaPath);
      const s = typeof raw === "string" ? raw.trim() : "";
      if (s !== "") return s;
    } catch {
      // fall through to defaults/agent
    }
  }
  const filePath = path.join(getDefaultAgentDir(), filename);
  try {
    const raw = ctx.fs.readFile(filePath);
    const s = typeof raw === "string" ? raw.trim() : "";
    return s !== "" ? s : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Returns defaults/maia when agentId is maia; otherwise defaults/agent.
 * @param agentId - Optional agent id
 */
function getDefaultDirForAgent(agentId?: string): string {
  return agentId === "maia" ? getDefaultMaiaDir() : getDefaultAgentDir();
}

/**
 * Copies markdown seeds from defaultDir/user or memory into the agent directory.
 * @param ctx - App context (uses ctx.fs)
 * @param defaultDir - defaults root for this agent type
 * @param agentDir - data/agents/<id>
 * @param subdir - user or memory folder name
 */
function copyDefaultFactFiles(
  ctx: AppContext,
  defaultDir: string,
  agentDir: string,
  subdir: "user" | "memory",
): void {
  const srcDir = path.join(defaultDir, subdir);
  if (!ctx.fs.exists(srcDir)) return;
  const destDir = path.join(agentDir, subdir);
  ctx.fs.mkdirp(destDir);
  try {
    const names = ctx.fs.listDir(srcDir);
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const srcPath = path.join(srcDir, name);
      const content = ctx.fs.readFile(srcPath);
      if (typeof content !== "string") continue;
      ctx.fs.writeFile(path.join(destDir, name), content);
    }
  } catch {
    // ignore list/read errors; agent still gets empty subdir
  }
}

/**
 * Copies default PERSONA.md and workspace/memory/user skeleton files into an agent directory.
 * @param ctx - App context (uses ctx.fs)
 * @param agentDir - Absolute path (e.g. data/agents/<id>)
 * @param agentName - Substituted for {{name}} in generic templates
 * @param agentId - When "maia", templates load from defaults/maia first
 */
export function copyDefaultAgentFiles(
  ctx: AppContext,
  agentDir: string,
  agentName: string,
  agentId?: string,
): void {
  ctx.fs.mkdirp(agentDir);
  ctx.fs.mkdirp(path.join(agentDir, "workspace"));
  ctx.fs.mkdirp(path.join(agentDir, "memory"));
  ctx.fs.mkdirp(path.join(agentDir, "user"));
  const defaultDir = getDefaultDirForAgent(agentId);
  const personaContent = readDefaultIdentityFile(
    ctx,
    "PERSONA.md",
    FALLBACK_PERSONA,
    agentId,
  ).replace(/\{\{name\}\}/g, agentName);
  ctx.fs.writeFile(path.join(agentDir, "PERSONA.md"), personaContent);
  copyDefaultFactFiles(ctx, defaultDir, agentDir, "user");
  copyDefaultFactFiles(ctx, defaultDir, agentDir, "memory");
}

/** Legacy export (multi-agent CRUD removed); persona tools live in `personas-tools`. */
export const agentManagementTools: Tool[] = [];
