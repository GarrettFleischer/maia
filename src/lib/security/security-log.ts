import { v4 as uuidv4 } from "uuid";
import type { AppContext } from "../context";

export function logSecurityEvent(
  ctx: AppContext,
  agentId: string,
  sessionId: string,
  eventType: string,
  detail: Record<string, unknown>
): void {
  ctx.db.prepare(
    `INSERT INTO security_events (id, agent_id, session_id, event_type, detail, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    agentId,
    sessionId,
    eventType,
    JSON.stringify(detail),
    new Date().toISOString()
  );
}

export function logInjectionDetected(
  ctx: AppContext,
  agentId: string,
  sessionId: string,
  source: string,
  patternMatched: string,
  originalLength: number
): void {
  logSecurityEvent(ctx, agentId, sessionId, "injection_detected", {
    source,
    pattern_matched: patternMatched,
    original_length: originalLength,
  });
}
