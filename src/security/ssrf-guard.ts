/**
 * @fileoverview SSRF (Server-Side Request Forgery) guard. Validates URLs to block
 * private IP ranges and non-http(s) protocols. Handles malformed URLs safely.
 * @module security/ssrf-guard
 */

/**
 * @brief Options for creating an SSRF guard.
 */
export interface SsrfGuardOptions {
  /** When true, block private/local IP ranges and localhost. */
  blockPrivateIPs: boolean;
}

/**
 * @brief SSRF guard instance returned by createSsrfGuard.
 */
export interface SsrfGuard {
  isAllowed(url: string): boolean;
}

// Private IP ranges (CIDR notation for checking)
// 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
// ::1, fd00::/8, localhost

function ipToNumber(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const p = parseInt(parts[i]!, 10);
    if (isNaN(p) || p < 0 || p > 255) return -1;
    n = (n << 8) | p;
  }
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipToNumber(ip);
  if (n === -1) return false;
  // 127.0.0.0/8
  if ((n >>> 8) === 0x7f0000) return true;
  // 10.0.0.0/8
  if ((n >>> 24) === 10) return true;
  // 172.16.0.0/12
  if ((n >>> 20) === 0xac1) return true;
  // 192.168.0.0/16
  if ((n >>> 16) === 0xc0a8) return true;
  // 169.254.0.0/16 (link-local)
  if ((n >>> 16) === 0xa9fe) return true;
  // 0.0.0.0
  if (n === 0) return true;
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  // ::1
  if (lower === "::1" || lower === "[::1]") return true;
  // fd00::/8 (unique local)
  if (lower.startsWith("fd") || lower.startsWith("[fd")) return true;
  return false;
}

function isLocalhost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

/**
 * @brief Creates an SSRF guard that validates URLs before outbound requests.
 * @param options - blockPrivateIPs flag
 * @returns SSRF guard with isAllowed(url) method
 */
export function createSsrfGuard(options: SsrfGuardOptions): SsrfGuard {
  const { blockPrivateIPs } = options;

  /**
   * @brief Checks if a URL is allowed for outbound requests.
   * @param url - URL string to validate
   * @returns true if allowed, false if blocked or malformed
   */
  function isAllowed(url: string): boolean {
    if (typeof url !== "string" || !url.trim()) return false;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    // Only allow http: and https:
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return false;

    if (!blockPrivateIPs) return true;

    const hostname = parsed.hostname;
    if (!hostname) return false;

    if (isLocalhost(hostname)) return false;

    // IPv6 in brackets
    if (hostname.startsWith("[")) {
      const inner = hostname.slice(1, -1);
      if (isPrivateIPv6(inner)) return false;
      return true;
    }

    // IPv4 or hostname
    if (isPrivateIPv4(hostname)) return false;
    if (hostname.includes(":")) {
      // Could be IPv6 without brackets - treat as invalid for safety
      if (isPrivateIPv6(hostname)) return false;
    }

    return true;
  }

  return { isAllowed };
}
