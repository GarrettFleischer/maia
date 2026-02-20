/**
 * @fileoverview Settings: heartbeat interval, secrets (list keys, add/delete), link to violations.
 * @module app/components/SettingsView
 */

"use client";

import { useAuth } from "./AuthGuard";
import { useEffect, useState } from "react";

type Settings = {
  heartbeatIntervalMs?: number;
  ollamaBaseUrl?: string;
  defaultModel?: string;
  securityGateModel?: string;
};

export function SettingsView() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [heartbeatLoading, setHeartbeatLoading] = useState(false);

  useEffect(() => {
    fetch("/api/settings", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [token]);

  useEffect(() => {
    fetch("/api/secrets", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : { keys: [] }))
      .then((d: { keys: string[] }) => setSecretKeys(d.keys ?? []))
      .catch(() => setSecretKeys([]));
  }, [token]);

  async function addSecret(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    const res = await fetch("/api/secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: newKeyName.trim(), value: newKeyValue }),
    });
    if (res.ok) {
      setNewKeyName("");
      setNewKeyValue("");
      setSecretKeys((prev) => (prev.includes(newKeyName.trim()) ? prev : [...prev, newKeyName.trim()]));
      const data = (await fetch("/api/secrets", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())) as { keys: string[] };
      setSecretKeys(data.keys ?? []);
    }
  }

  async function deleteSecret(key: string) {
    await fetch(`/api/secrets?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setSecretKeys((prev) => prev.filter((k) => k !== key));
  }

  return (
    <div style={{ padding: "1.5rem", maxWidth: "32rem", color: "var(--text-primary)" }}>
      <h2 style={{ marginBottom: "1rem" }}>Settings</h2>
      {settings && (
        <section style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Runtime</h3>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-muted)" }}>
            Heartbeat interval: {settings.heartbeatIntervalMs ?? 60000} ms
          </p>
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.875rem", color: "var(--text-muted)" }}>
            Ollama: {settings.ollamaBaseUrl ?? "—"}
          </p>
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.875rem", color: "var(--text-muted)" }}>
            Default model: {settings.defaultModel || "—"}
          </p>
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.875rem", color: "var(--text-muted)" }}>
            Security gate model: {settings.securityGateModel || "—"}
          </p>
          <button
            type="button"
            disabled={heartbeatLoading}
            onClick={async () => {
              setHeartbeatLoading(true);
              try {
                await fetch("/api/heartbeat/tick", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}` },
                });
              } finally {
                setHeartbeatLoading(false);
              }
            }}
            style={{ marginTop: "0.5rem", padding: "0.5rem 1rem", background: "var(--accent)", color: "var(--bg-primary)", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 600 }}
          >
            {heartbeatLoading ? "Running…" : "Trigger heartbeat now"}
          </button>
        </section>
      )}
      <section>
        <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Secrets</h3>
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
          Key names are visible; values are never shown.
        </p>
        <ul style={{ listStyle: "none", padding: 0, marginBottom: "1rem" }}>
          {secretKeys.map((k) => (
            <li key={k} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <code style={{ color: "var(--accent)" }}>{k}</code>
              <button type="button" onClick={() => deleteSecret(k)} style={{ fontSize: "0.75rem", color: "var(--error)", background: "transparent", border: "none", cursor: "pointer" }}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={addSecret} style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: "20rem" }}>
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name"
            style={{ padding: "0.5rem", background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: "4px" }}
          />
          <input
            type="password"
            value={newKeyValue}
            onChange={(e) => setNewKeyValue(e.target.value)}
            placeholder="Value"
            style={{ padding: "0.5rem", background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: "4px" }}
          />
          <button type="submit" style={{ padding: "0.5rem 1rem", background: "var(--accent)", color: "var(--bg-primary)", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 600 }}>Add secret</button>
        </form>
      </section>
    </div>
  );
}
