/**
 * @fileoverview Trigger one heartbeat tick (all enabled agents). For cron or manual testing.
 * @module app/api/heartbeat/tick/route
 *
 * POST /api/heartbeat/tick — runs runHeartbeatOnce. 200 + { ok: true }.
 */

import { openDb } from "@/db/client";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { debug } from "@/lib/logger";
import { createHeartbeatDeps } from "@/heartbeat/deps";
import { runHeartbeatOnce } from "@/heartbeat/runner";
import { NextResponse } from "next/server";
import fs from "node:fs";

export async function POST(request: Request): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  debug("heartbeat", { event: "tick_triggered", source: "api" });
  const container = createContainer();
  const db = await openDb(container.dbPath);
  try {
    const deps = createHeartbeatDeps({
      db,
      sandboxRoot: container.sandboxRoot,
      fs: {
        mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      },
    });
    await runHeartbeatOnce(deps);
    return NextResponse.json({ ok: true });
  } finally {
    db.close();
  }
}
