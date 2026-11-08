/**
 * Live daemon integration (post–Slice F handoff).
 * Replace fixture dispatch in `MaiaProvider` with authenticated fetch to:
 * - GET/PUT /api/security/profile
 * - GET /api/security/capabilities
 * - GET/POST/PUT/DELETE /api/security/allowlist
 * - PUT /api/secrets/backend
 * - POST /api/threads/:thread/approvals/:id
 *
 * Enabling `Unrestricted` and credential-backend switches must stay on local desktop (403 on remote).
 * Passphrase unlock remains a Tauri command only (no HTTP route).
 */

export const API_ROUTES = {
  securityProfile: '/api/security/profile',
  securityCapabilities: '/api/security/capabilities',
  securityAllowlist: '/api/security/allowlist',
  secretsBackend: '/api/secrets/backend',
} as const
