/**
 * @fileoverview API route for model capabilities.
 * @module app/api/model-capabilities/route
 *
 * Returns provider and reasoning support information for all whitelisted models.
 * Used by the Settings page to reconcile reasoning-effort controls immediately.
 */

import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getSettings } from "@/lib/settings";
import { getModelCapabilitiesForSettings } from "@/lib/ai/model-capabilities";
import type { ModelCapabilities } from "@/lib/types";

/**
 * GET /api/model-capabilities
 * @brief Returns capabilities for all whitelisted models.
 * @returns JSON payload with a map of model id to capabilities.
 */
export async function GET() {
  const ctx = await ensureAppContext();
  const settings = getSettings(ctx);

  const modelCapabilities: Record<string, ModelCapabilities> =
    await getModelCapabilitiesForSettings(settings, ctx.http);

  return NextResponse.json({ modelCapabilities });
}

