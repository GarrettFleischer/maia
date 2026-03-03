/**
 * @fileoverview Tests for the security preamble constant (key phrases present).
 * @module __tests__/lib/security/preamble
 */
import { describe, it, expect } from "bun:test";
import { SECURITY_PREAMBLE } from "@/lib/security/preamble";

describe("SECURITY_PREAMBLE", () => {
  const KEY_PHRASES = [
    "SECURITY NOTICE",
    "UNTRUSTED",
    "CREDENTIAL PROTECTION",
    "INSTRUCTION ISOLATION",
    "NO DATA EXFILTRATION",
    "IDENTITY INTEGRITY",
    "INJECTION REPORTING",
    "records injection events",
  ];

  it("contains all key security phrases", () => {
    for (const phrase of KEY_PHRASES) {
      expect(SECURITY_PREAMBLE).toContain(phrase);
    }
  });

  it("starts with the security notice header", () => {
    expect(SECURITY_PREAMBLE.trimStart()).toMatch(/^═════/);
  });
});
