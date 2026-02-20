import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db";

export function logSecurityEvent(
  agentId: string,
  sessionId: string,
  eventType: string,
  detail: Record<string, unknown>
): void {
  const db = getDb();
  db.prepare(
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
  agentId: string,
  sessionId: string,
  source: string,
  patternMatched: string,
  originalLength: number
): void {
  logSecurityEvent(agentId, sessionId, "injection_detected", {
    source,
    pattern_matched: patternMatched,
    original_length: originalLength,
  });
}
