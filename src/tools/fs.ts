/**
 * @fileoverview Sandboxed filesystem tool. All paths resolved under sandbox root; escape attempts throw.
 * @module tools/fs
 */

import fs from "node:fs";
import path from "node:path";
import { resolveWithinSandbox } from "@/lib/sandbox";

export type ListEntry = { name: string; isDirectory: boolean };

export type SandboxFs = {
  list: (dir: string) => ListEntry[];
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  deleteFile: (filePath: string) => void;
  mkdir: (dirPath: string) => void;
  exists: (filePath: string) => boolean;
};

function resolve(sandboxRoot: string, requestedPath: string): string {
  const resolved = resolveWithinSandbox(sandboxRoot, requestedPath);
  if (resolved === null) {
    throw new Error("Path not allowed: outside sandbox");
  }
  return resolved;
}

/**
 * Creates a sandboxed filesystem interface. Paths are relative to sandboxRoot; "/" or "." list the root.
 */
export function createSandboxFs(sandboxRoot: string): SandboxFs {
  const root = path.normalize(path.resolve(sandboxRoot));
  return {
    list(dir: string): ListEntry[] {
      const full = resolve(root, dir === "/" || dir === "" ? "." : dir);
      const names = fs.readdirSync(full);
      return names.map((name) => {
        const child = path.join(full, name);
        const stat = fs.statSync(child);
        return { name, isDirectory: stat.isDirectory() };
      });
    },
    readFile(filePath: string): string {
      const full = resolve(root, filePath);
      return fs.readFileSync(full, "utf-8");
    },
    writeFile(filePath: string, content: string): void {
      const full = resolve(root, filePath);
      const dir = path.dirname(full);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(full, content, "utf-8");
    },
    deleteFile(filePath: string): void {
      const full = resolve(root, filePath);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        fs.rmSync(full, { recursive: true });
      } else {
        fs.unlinkSync(full);
      }
    },
    mkdir(dirPath: string): void {
      const full = resolve(root, dirPath);
      if (!fs.existsSync(full)) {
        fs.mkdirSync(full, { recursive: true });
      }
    },
    exists(filePath: string): boolean {
      const full = resolve(root, filePath);
      return fs.existsSync(full);
    },
  };
}
