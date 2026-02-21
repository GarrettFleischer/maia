"use client";

import { useEffect, useState } from "react";
import type { SettingsPublic } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsPublic | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [compressionModel, setCompressionModel] = useState("");
  const [heartbeatInterval, setHeartbeatInterval] = useState(30);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: SettingsPublic) => {
        setSettings(d);
        setOllamaUrl(d.ollamaBaseUrl);
        setCompressionModel(d.compressionModel);
        setHeartbeatInterval(d.heartbeatIntervalMinutes);
      });
  }, []);

  const save = async () => {
    setSaving(true);
    const body: Record<string, unknown> = {
      ollamaBaseUrl: ollamaUrl,
      compressionModel,
      heartbeatIntervalMinutes: heartbeatInterval,
    };
    if (openRouterKey) body.openRouterApiKey = openRouterKey;

    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    if (openRouterKey) setOpenRouterKey("");
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader subtitle="Settings" />

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <h1 className="text-xl font-semibold">Settings</h1>

        {!settings && <p className="text-zinc-500 text-sm">Loading...</p>}

        {settings && (
          <>
            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <h2 className="font-medium text-sm text-zinc-300">AI Providers</h2>

              <div>
                <label htmlFor="settings-ollama-url" className="block text-xs text-zinc-500 mb-1">Ollama Base URL</label>
                <input
                  id="settings-ollama-url"
                  type="text"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                  aria-label="Ollama Base URL"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  OpenRouter API Key {settings.hasOpenRouterKey && <span className="text-green-400">(configured)</span>}
                </label>
                <input
                  type="password"
                  value={openRouterKey}
                  onChange={(e) => setOpenRouterKey(e.target.value)}
                  placeholder={settings.hasOpenRouterKey ? "Enter new key to update" : "sk-or-..."}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                />
              </div>
            </section>

            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
              <h2 className="font-medium text-sm text-zinc-300">Agent System</h2>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">Compression Model</label>
                <input
                  type="text"
                  value={compressionModel}
                  onChange={(e) => setCompressionModel(e.target.value)}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-500 mb-1">Heartbeat Interval (minutes)</label>
                <input
                  type="number"
                  value={heartbeatInterval}
                  onChange={(e) => setHeartbeatInterval(Number(e.target.value))}
                  min={1}
                  className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
                />
              </div>
            </section>

            <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h2 className="font-medium text-sm text-zinc-300 mb-3">Whitelisted Models</h2>
              <div className="space-y-1">
                {settings.whitelistedModels.map((m) => (
                  <div key={m} className="text-xs font-mono text-zinc-400 bg-zinc-800 rounded px-2 py-1">{m}</div>
                ))}
              </div>
            </section>

            <button
              onClick={save}
              disabled={saving}
              className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-sm font-medium transition-colors"
            >
              {saved ? "Saved ✓" : saving ? "Saving..." : "Save Settings"}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
