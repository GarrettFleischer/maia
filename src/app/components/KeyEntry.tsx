/**
 * @fileoverview Key-entry (login) screen: user enters API key; we verify and call onSuccess.
 * @module app/components/KeyEntry
 */

"use client";

import { useState } from "react";

const STORAGE_KEY = "maia_api_key";

export type KeyEntryProps = {
  onSuccess: (token: string) => void;
};

/**
 * Renders a form to enter the API key. On submit, verifies via GET /api/health
 * with Bearer token; on 200 stores token and calls onSuccess.
 */
export function KeyEntry({ onSuccess }: KeyEntryProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const token = key.trim();
    if (!token) {
      setError("Enter your API key");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/health", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError("Invalid key");
        return;
      }
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(STORAGE_KEY, token);
      }
      onSuccess(token);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: "2rem", maxWidth: "24rem", margin: "0 auto" }}>
      <h1 style={{ marginBottom: "1rem", color: "var(--text-primary)" }}>Maia</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem" }}>
        Enter your API key to continue.
      </p>
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="API key"
          autoComplete="off"
          style={{
            width: "100%",
            padding: "0.5rem",
            marginBottom: "0.5rem",
            boxSizing: "border-box",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
            borderRadius: "4px",
          }}
        />
        {error && (
          <p style={{ color: "var(--error)", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={loading} style={{ padding: "0.5rem 1rem", background: "var(--accent)", color: "var(--bg-primary)", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 600 }}>
          {loading ? "Checking…" : "Continue"}
        </button>
      </form>
    </main>
  );
}

export function getStoredToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(STORAGE_KEY);
}

export function clearStoredToken(): void {
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}
