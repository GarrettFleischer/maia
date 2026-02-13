/**
 * @fileoverview Privacy manager for session-level privacy mode. Tracks which
 * sessions have privacy enabled and detects privacy-related commands.
 * @module agent/privacy
 */

import type { AuditLog } from "../core/types.js";

/** @brief Dependencies for createPrivacyManager */
export interface PrivacyManagerDeps {
  auditLog: AuditLog;
}

/** @brief Privacy manager interface */
export interface PrivacyManager {
  isPrivate(sessionId: string): boolean;
  enable(sessionId: string): void;
  disable(sessionId: string): void;
  isPrivateCommand(text: string): boolean;
}

/**
 * @brief Creates a privacy manager for session-level privacy control.
 * @param deps - Dependencies: auditLog
 * @returns PrivacyManager instance with isPrivate, enable, disable,
 *   and isPrivateCommand methods
 */
export function createPrivacyManager(deps: PrivacyManagerDeps): PrivacyManager {
  const { auditLog } = deps;
  const privateSessions = new Set<string>();

  return {
    isPrivate(sessionId: string): boolean {
      return privateSessions.has(sessionId);
    },

    enable(sessionId: string): void {
      privateSessions.add(sessionId);
      auditLog.log("PRIVACY_MODE", { sessionId, enabled: true });
    },

    disable(sessionId: string): void {
      privateSessions.delete(sessionId);
    },

    isPrivateCommand(text: string): boolean {
      return text.trim().toLowerCase().startsWith("/private");
    },
  };
}
