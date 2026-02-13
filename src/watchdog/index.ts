/**
 * @fileoverview Watchdog subsystem public exports.
 * @module watchdog
 */

export { createThreatDetector } from "./threat-detector.js";
export type { ThreatDetector, ThreatDetectorDeps } from "./threat-detector.js";
export { createAlerter } from "./alerter.js";
export type { Alerter, AlerterDeps } from "./alerter.js";
export { createAuditMonitor } from "./monitor.js";
export type { AuditMonitor, AuditMonitorDeps } from "./monitor.js";
export { createEmergencyShutdown } from "./shutdown.js";
export type { EmergencyShutdown, EmergencyShutdownDeps } from "./shutdown.js";
export { createWatchdogDaemon } from "./daemon.js";
export type { WatchdogDaemon, WatchdogDaemonDeps } from "./daemon.js";

// Health checks
export { createConfigHealthCheck } from "./health-checks/config.js";
export type { HealthCheckResult } from "./health-checks/config.js";
export { createProviderHealthCheck } from "./health-checks/providers.js";
export { createChannelHealthCheck } from "./health-checks/channels.js";
export { createWorkspaceHealthCheck } from "./health-checks/workspace.js";
export { createDatabaseHealthCheck } from "./health-checks/database.js";
export { createPermissionsHealthCheck } from "./health-checks/permissions.js";
export { createCredentialHealthCheck } from "./health-checks/credentials.js";
