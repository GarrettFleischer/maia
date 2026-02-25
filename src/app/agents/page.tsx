"use client";

import { useEffect, useState } from "react";
import type { AgentDefinition } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => setAgents(d.agents ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader subtitle="Agents" />

      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold mb-6">Agents</h1>

        {loading && <p className="text-zinc-500 text-sm">Loading...</p>}

        {!loading && agents.length === 0 && (
          <p className="text-zinc-500 text-sm">No agents yet. Maia will create agents as needed.</p>
        )}

        <div className="space-y-3">
          {agents.map((agent) => (
            <div key={agent.id} className="bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-violet-700 flex items-center justify-center text-xs font-bold">
                    {agent.name[0]}
                  </div>
                  <span className="font-medium text-sm">{agent.name}</span>
                  {agent.id === "maia" && (
                    <span className="text-xs bg-violet-900 text-violet-300 px-2 py-0.5 rounded-full">orchestrator</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500 mt-1 ml-8">{agent.model}</div>
              </div>
              <div className={`text-xs px-2 py-1 rounded-full ${
                agent.status === "active" ? "bg-green-900/50 text-green-400" :
                agent.status === "paused" ? "bg-yellow-900/50 text-yellow-400" :
                "bg-zinc-800 text-zinc-500"
              }`}>
                {agent.status}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
