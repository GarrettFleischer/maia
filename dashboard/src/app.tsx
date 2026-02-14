/**
 * @fileoverview Root application component with sidebar layout and routing.
 * @module App
 */

import { useState, useEffect } from "preact/hooks";
import Router, { route } from "preact-router";
import { Sidebar } from "./components/Sidebar.js";
import { DmNotification } from "./components/DmNotification.js";
import { ApprovalRequestModal } from "./components/ApprovalRequestModal.js";
import { Home } from "./routes/Home.js";
import { Chat } from "./routes/Chat.js";
import { Agents } from "./routes/Agents.js";
import { AgentDetail } from "./routes/AgentDetail.js";
import { Threads } from "./routes/Threads.js";
import { ThreadView } from "./routes/ThreadView.js";
import { useWebSocket } from "./hooks/use-websocket.js";
import { useAgents } from "./hooks/use-agents.js";

/**
 * @brief Login screen for entering the auth token.
 */
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (token.trim()) {
      localStorage.setItem("maia_token", token.trim());
      onLogin();
    }
  };

  return (
    <div class="flex items-center justify-center h-screen bg-maia-bg">
      <div class="bg-maia-surface border border-maia-border rounded-2xl p-8 w-full max-w-sm">
        <div class="text-center mb-6">
          <span class="text-4xl">🌙</span>
          <h1 class="text-xl font-semibold text-maia-text mt-2">Maia Dashboard</h1>
          <p class="text-sm text-maia-text-dim mt-1">Enter your gateway token to connect</p>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            placeholder="Gateway auth token"
            class="w-full bg-maia-surface-light border border-maia-border rounded-xl px-4 py-2.5
                   text-sm text-maia-text placeholder-maia-text-dim mb-4
                   focus:outline-none focus:border-maia-accent focus:ring-1 focus:ring-maia-accent"
            autoFocus
          />
          <button
            type="submit"
            class="w-full bg-maia-accent hover:bg-maia-accent-hover text-white py-2.5 rounded-xl
                   text-sm font-medium transition-colors"
          >
            Connect
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * @brief Main dashboard layout with sidebar, routing, and notifications.
 */
function Dashboard() {
  const {
    connected,
    notifications,
    agentStatuses,
    approvalRequest,
    dismissNotification,
    dismissApprovalRequest,
    sendApprovalResponse,
  } = useWebSocket();
  const { agents, loading: agentsLoading, error: agentsError } = useAgents();
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  const handleRoute = (e: { url: string }) => {
    setCurrentPath(e.url);
  };

  return (
    <div class="flex h-screen overflow-hidden bg-maia-bg">
      <Sidebar agents={agents} connected={connected} currentPath={currentPath} />

      <main class="flex-1 overflow-y-auto">
        <Router onChange={handleRoute}>
          <Home
            path="/"
            agents={agents}
            notifications={notifications}
            agentStatuses={agentStatuses}
          />
          <Chat path="/chat" />
          <Agents path="/agents" agents={agents} loading={agentsLoading} error={agentsError} />
          <AgentDetail path="/agents/:id" />
          <Threads path="/threads" />
          <ThreadView path="/threads/:id" />
        </Router>
      </main>

      <DmNotification notifications={notifications} onDismiss={dismissNotification} />
      <ApprovalRequestModal
        request={approvalRequest}
        onRespond={sendApprovalResponse}
        onDismiss={dismissApprovalRequest}
      />
    </div>
  );
}

/**
 * @brief Root App component that handles auth gating.
 */
export function App() {
  const [authenticated, setAuthenticated] = useState(!!localStorage.getItem("maia_token"));

  if (!authenticated) {
    return <LoginScreen onLogin={() => setAuthenticated(true)} />;
  }

  return <Dashboard />;
}
