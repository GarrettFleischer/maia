/**
 * @fileoverview Maia UI: Alpine + vanilla JS. Sidebar (Maia + agents), chat per agent, widgets.
 * @module web/app
 */

const AUTH_KEY = "maia_token";

function getToken() {
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl && fromUrl.trim()) {
    const t = fromUrl.trim();
    localStorage.setItem(AUTH_KEY, t);
    window.history.replaceState({}, document.title, window.location.pathname);
    return t;
  }
  return localStorage.getItem(AUTH_KEY) || "";
}

function maiaApp() {
  return {
    token: getToken(),
    tokenInput: "",
    tokenError: "",
    agents: [],
    selectedAgentId: null,
    threadId: null,
    messages: [],
    thoughts: [],
    widgets: [],
    inputText: "",
    ws: null,
    connected: false,
    reconnectTimer: null,

    init() {
      if (!this.token) return;
      this.loadAgents();
      this.connectWs();
    },

    setTokenFromInput() {
      const t = this.tokenInput.trim();
      if (!t) {
        this.tokenError = "Enter a token.";
        return;
      }
      localStorage.setItem(AUTH_KEY, t);
      this.token = t;
      this.tokenError = "";
      this.tokenInput = "";
      this.loadAgents();
      this.connectWs();
    },

    logout() {
      localStorage.removeItem(AUTH_KEY);
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.connected = false;
      this.token = "";
      this.agents = [];
      this.selectedAgentId = null;
      this.messages = [];
      this.widgets = [];
    },

    async api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          ...(options.headers || {}),
        },
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },

    async loadAgents() {
      try {
        const list = await this.api("/api/agents");
        this.agents = [
          { id: "maia", name: "Maia", emoji: "🌙", isRunning: true },
          ...list,
        ];
        if (!this.selectedAgentId && this.agents.length) {
          this.selectAgent(this.agents[0].id);
        }
      } catch (e) {
        console.error("Load agents failed", e);
        this.agents = [{ id: "maia", name: "Maia", emoji: "🌙", isRunning: true }];
        if (!this.selectedAgentId) this.selectAgent("maia");
      }
    },

    get selectedAgentName() {
      const a = this.agents.find((x) => x.id === this.selectedAgentId);
      return a ? a.name : "";
    },

    agentNameById(id) {
      const a = this.agents.find((x) => x.id === id);
      return a ? a.name : id;
    },

    async selectAgent(agentId) {
      const prevThreadId = this.threadId;
      this.selectedAgentId = agentId;
      this.messages = [];
      this.thoughts = [];
      this.widgets = [];

      if (this.ws && this.ws.readyState === WebSocket.OPEN && prevThreadId) {
        this.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId: prevThreadId }));
      }

      try {
        const thread = await this.api(`/api/agents/${agentId}/chat-thread`);
        this.threadId = thread.id;
        const data = await this.api(`/api/threads/${thread.id}`);
        this.messages = data.messages || [];

        const dash = await this.api(`/api/agents/${agentId}/dashboard`).catch(() => ({ approvedWidgets: [] }));
        this.widgets = dash.approvedWidgets || [];
        const thoughtsData = await this.api(`/api/agents/${agentId}/thoughts`).catch(() => []);
        this.thoughts = Array.isArray(thoughtsData) ? thoughtsData : [];
      } catch (e) {
        console.error("Load thread/widgets failed", e);
      }

      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.threadId) {
        this.ws.send(JSON.stringify({ type: "subscribe_thread", threadId: this.threadId }));
      }
    },

    connectWs() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`;
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.connected = true;
        if (this.threadId) {
          this.ws.send(JSON.stringify({ type: "subscribe_thread", threadId: this.threadId }));
        }
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.reconnectTimer = setTimeout(() => this.connectWs(), 2000);
      };
      this.ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "thread_update" && data.threadId === this.threadId) {
            this.messages = [...this.messages, {
              id: `t-${Date.now()}-${Math.random()}`,
              threadId: data.threadId,
              senderId: data.message.senderId,
              senderType: data.message.senderType,
              content: data.message.content,
              createdAt: data.message.createdAt,
            }];
            this.$nextTick(() => this.scrollMessages());
          } else if (data.type === "agent_dm" && data.agentId === this.selectedAgentId) {
            this.messages = [...this.messages, {
              id: `dm-${Date.now()}-${Math.random()}`,
              threadId: this.threadId,
              senderId: data.agentId,
              senderType: data.agentId === "maia" ? "maia" : "agent",
              content: data.content,
              createdAt: new Date().toISOString(),
            }];
            this.$nextTick(() => this.scrollMessages());
          } else if (data.type === "widget_approved" && data.agentId === this.selectedAgentId) {
            this.api(`/api/agents/${this.selectedAgentId}/dashboard`)
              .then((d) => { this.widgets = d.approvedWidgets || []; })
              .catch(() => {});
          } else if (data.type === "agent_thought" && data.agentId === this.selectedAgentId) {
            this.thoughts = [...this.thoughts, {
              id: data.id,
              agentId: data.agentId,
              content: data.content,
              createdAt: data.createdAt,
            }];
            this.$nextTick(() => this.scrollThoughts());
          }
        } catch (err) {
          console.error("WS message parse error", err);
        }
      };
    },

    scrollMessages() {
      const el = this.$refs.messagesContainer;
      if (el) el.scrollTop = el.scrollHeight;
    },

    scrollThoughts() {
      const el = this.$refs.thoughtsContainer;
      if (el) el.scrollTop = el.scrollHeight;
    },

    sendMessage() {
      const text = (this.inputText || "").trim();
      if (!text || !this.threadId) return;
      this.inputText = "";
      this.messages = [...this.messages, {
        id: `u-${Date.now()}`,
        threadId: this.threadId,
        senderId: "user",
        senderType: "user",
        content: text,
        createdAt: new Date().toISOString(),
      }];
      this.$nextTick(() => this.scrollMessages());

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "thread_message", threadId: this.threadId, content: text }));
      } else {
        this.api(`/api/threads/${this.threadId}/messages`, {
          method: "POST",
          body: JSON.stringify({ content: text }),
        }).catch((e) => console.error("Send failed", e));
      }
    },

    widgetSrcdoc(w) {
      const html = w.fullHtml;
      if (html) return html;
      const escCss = (w.css || "").replace(/<\/style>/gi, "\\u003c/style>");
      const escJs = (w.js || "").replace(/<\/script>/gi, "\\u003c/script>");
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${escCss}</style></head><body>${w.html || ""}<script>${escJs}<\\/script></body></html>`;
    },

    escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    },

    formatTime(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    },
  };
}
