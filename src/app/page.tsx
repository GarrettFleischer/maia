/**
 * @fileoverview Root page: key-entry when unauthenticated; sidebar + chat/settings when authenticated.
 * @module app/page
 */

"use client";

import { useState } from "react";
import { AuthGuard } from "./components/AuthGuard";
import { ChatView } from "./components/ChatView";
import { Sidebar } from "./components/Sidebar";
import { SettingsView } from "./components/SettingsView";

export default function Home() {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [selectedConversationType, setSelectedConversationType] = useState<
    string | null
  >(null);
  const [showSettings, setShowSettings] = useState(false);

  return (
    <AuthGuard>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <Sidebar
          selectedAgentId={selectedAgentId}
          selectedConversationId={selectedConversationId}
          selectedConversationType={selectedConversationType}
          onSelectAgent={setSelectedAgentId}
          onSelectConversation={(convId, conversationType) => {
            setShowSettings(false);
            setSelectedConversationId(convId);
            setSelectedConversationType(conversationType);
          }}
        />
        <main
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-secondary)",
          }}
        >
          <div
            style={{
              padding: "0.5rem",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: "0.5rem",
            }}
          >
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              style={{
                fontWeight: showSettings ? 400 : 600,
                color: "var(--text-primary)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              style={{
                fontWeight: showSettings ? 600 : 400,
                color: "var(--text-primary)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              Settings
            </button>
          </div>
          {showSettings ? (
            <SettingsView />
          ) : (
            <ChatView
              conversationId={selectedConversationId}
              agentId={selectedAgentId}
              canSend={selectedConversationType === "user_chat"}
              pollingFallbackMs={
                selectedConversationType === "internal"
                  ? 5000
                  : selectedConversationType === "user_chat"
                    ? 4000
                    : undefined
              }
              isInternalThoughts={selectedConversationType === "internal"}
            />
          )}
        </main>
      </div>
    </AuthGuard>
  );
}
