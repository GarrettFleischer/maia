/**
 * @fileoverview WebChat client logic for the Maia web interface.
 * @module web/chat
 *
 * @brief Handles WebSocket connection, message sending/receiving,
 * auto-reconnection, and UI updates. Requires a Bearer token for all
 * requests; token is validated via /api/health before connecting WebSocket.
 *
 * @note This module runs in the browser and connects to the Maia gateway
 * via WebSocket. It manages the chat UI lifecycle including message display,
 * typing indicators, connection status, and token entry/validation.
 * Assistant messages are rendered as sanitized Markdown.
 */

// ─── Configuration ──────────────────────────────────────────────

/** @brief SessionStorage key for the auth token */
const AUTH_TOKEN_KEY = "maia_auth_token";

/** @brief WebSocket protocol (wss when page is https) */
const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";

/** @brief Base WebSocket URL (relative to current host); token appended as query */
const WS_BASE_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;

/** @brief Base API URL for token validation */
const API_BASE_URL = `${window.location.protocol}//${window.location.host}`;

/** @brief Maximum reconnection attempts */
const MAX_RECONNECT_ATTEMPTS = 10;

/** @brief Base delay between reconnection attempts (ms) */
const RECONNECT_BASE_DELAY = 1000;

/** @brief Maximum reconnection delay (ms) */
const RECONNECT_MAX_DELAY = 30000;

// ─── DOM Elements ───────────────────────────────────────────────

const messagesContainer = document.getElementById("chat-messages") as HTMLElement;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendButton = document.getElementById("send-button") as HTMLButtonElement;
const connectionStatus = document.getElementById("connection-status") as HTMLElement;
const tokenGate = document.getElementById("token-gate") as HTMLElement;
const tokenForm = document.getElementById("token-form") as HTMLFormElement;
const tokenInput = document.getElementById("token-input") as HTMLInputElement;
const tokenConnectBtn = document.getElementById("token-connect-btn") as HTMLButtonElement;
const tokenGateError = document.getElementById("token-gate-error") as HTMLElement;
const reenterTokenBtn = document.getElementById("reenter-token-btn") as HTMLButtonElement;

// ─── State ──────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: number | null = null;
let messageIdCounter = 0;
let welcomeVisible = true;

// ─── Token storage & gate ───────────────────────────────────────

/**
 * @brief Returns the stored auth token, or from URL ?token= (then removes from URL).
 */
function getAuthToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("token");
  if (fromUrl && fromUrl.trim()) {
    const token = fromUrl.trim();
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    window.history.replaceState({}, document.title, window.location.pathname);
    return token;
  }
  return sessionStorage.getItem(AUTH_TOKEN_KEY);
}

/** @brief Saves the auth token to session storage. */
function setAuthToken(token: string): void {
  sessionStorage.setItem(AUTH_TOKEN_KEY, token.trim());
}

/** @brief Clears the stored auth token. */
function clearAuthToken(): void {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
}

/** @brief Shows the token gate and hides the main chat. */
function showTokenGate(): void {
  tokenGate.classList.remove("hidden");
  reenterTokenBtn.style.display = "none";
  setTokenGateError("");
}

/** @brief Hides the token gate and shows the main chat. */
function hideTokenGate(): void {
  tokenGate.classList.add("hidden");
  reenterTokenBtn.style.display = "block";
}

/** @brief Sets or clears the token gate error message. */
function setTokenGateError(message: string): void {
  tokenGateError.textContent = message;
  tokenGateError.hidden = !message;
}

/**
 * @brief Validates the token by calling /api/health with Bearer auth.
 * @param token - Auth token to validate
 * @returns true if response is ok (200)
 */
async function validateToken(token: string): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/api/health`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token.trim()}` },
  });
  return res.ok;
}

// ─── WebSocket Management ───────────────────────────────────────

/**
 * @brief Establishes a WebSocket connection to the Maia gateway.
 * Requires a stored auth token; appends it as ?token= for upgrade auth.
 * @note Automatically attempts reconnection on disconnect using
 * exponential backoff.
 */
function connect(): void {
  const token = getAuthToken();
  if (!token || !token.trim()) {
    showTokenGate();
    return;
  }

  updateStatus("connecting");
  const wsUrl = `${WS_BASE_URL}?token=${encodeURIComponent(token)}`;

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    updateStatus("disconnected");
    scheduleReconnect();
    return;
  }

  ws.onopen = (): void => {
    reconnectAttempts = 0;
    updateStatus("connected");
    setInputEnabled(true);
  };

  ws.onmessage = (event: MessageEvent): void => {
    handleServerMessage(String(event.data));
  };

  ws.onclose = (): void => {
    updateStatus("disconnected");
    setInputEnabled(false);
    scheduleReconnect();
  };

  ws.onerror = (): void => {
    updateStatus("disconnected");
  };
}

/**
 * @brief Disconnects the WebSocket and clears reconnect state.
 */
function disconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
  if (ws) {
    ws.close();
    ws = null;
  }
  updateStatus("disconnected");
  setInputEnabled(false);
}

/**
 * @brief Schedules a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    addErrorMessage("Unable to connect to server. Please refresh the page.");
    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_DELAY
  );
  reconnectAttempts++;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * @brief Sends a JSON message through the WebSocket.
 * @param data - Object to send (will be JSON-serialized)
 */
function sendMessage(data: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addErrorMessage("Not connected. Trying to reconnect...");
    return;
  }
  ws.send(JSON.stringify(data));
}

// ─── Message Handling ───────────────────────────────────────────

/**
 * @brief Handles an incoming server message.
 * @param raw - Raw JSON string from the server
 */
function handleServerMessage(raw: string): void {
  try {
    const msg = JSON.parse(raw) as {
      type: string;
      content?: string;
      error?: string;
      id?: string;
      remembered?: { memoryMd?: string; userMd?: string; soulMd?: string };
    };

    switch (msg.type) {
      case "chat_response":
        hideTypingIndicator();
        if (msg.content !== undefined) {
          addMessage("assistant", msg.content, msg.remembered);
        }
        break;

      case "error":
        hideTypingIndicator();
        addErrorMessage(msg.error ?? "Unknown error");
        break;

      case "pong":
        // Heartbeat response, no action needed
        break;

      default:
        // Unknown message type, log for debugging
        console.debug("Unknown message type:", msg.type);
    }
  } catch {
    console.error("Failed to parse server message:", raw);
  }
}

// ─── Markdown rendering ────────────────────────────────────────

/** @brief Lazy-loaded markdown parser + sanitizer (marked + DOMPurify). */
let markdownRenderer: {
  parse: (raw: string) => string;
  sanitize: (html: string) => string;
} | null = null;

/**
 * @brief Returns a markdown renderer (parse + sanitize), loading deps on first use.
 * @returns Promise resolving to { parse, sanitize } for assistant message HTML
 */
async function getMarkdownRenderer(): Promise<{
  parse: (raw: string) => string;
  sanitize: (html: string) => string;
}> {
  if (markdownRenderer) return markdownRenderer;
  const [markedMod, dompurifyMod] = await Promise.all([
    import("https://esm.sh/marked@12.0.2"),
    import("https://esm.sh/dompurify@3.2.2"),
  ]);
  const marked = (markedMod as { marked?: (s: string) => string; default?: (s: string) => string }).marked
    ?? (markedMod as { default: (s: string) => string }).default;
  const parse = (raw: string): string => (marked as (s: string) => string)(raw);
  const DOMPurify = (dompurifyMod as { default: { sanitize: (d: string) => string } }).default;
  const sanitize = (html: string): string => DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  markdownRenderer = { parse, sanitize };
  return markdownRenderer;
}

/**
 * @brief Renders markdown string to sanitized HTML for assistant messages.
 * @param content - Raw markdown text
 * @returns Promise resolving to safe HTML string
 */
async function renderMarkdown(content: string): Promise<string> {
  const { parse, sanitize } = await getMarkdownRenderer();
  const rawHtml = parse(content) as string;
  return sanitize(rawHtml);
}

// ─── UI Functions ───────────────────────────────────────────────

/**
 * @brief Builds hover tooltip text from remembered content (what Maia wrote to each file).
 * @param remembered - Optional object with memoryMd, userMd, soulMd
 * @param maxLen - Max total length for tooltip (default 600)
 * @returns Tooltip string or "Maia will remember that" if no content
 */
function formatRememberedTooltip(
  remembered: { memoryMd?: string; userMd?: string; soulMd?: string } | undefined,
  maxLen = 600
): string {
  if (!remembered || (Object.keys(remembered).length === 0)) {
    return "Maia will remember that";
  }
  const parts: string[] = [];
  if (remembered.memoryMd) {
    parts.push(`MEMORY.md:\n${remembered.memoryMd}`);
  }
  if (remembered.userMd) {
    parts.push(`USER.md:\n${remembered.userMd}`);
  }
  if (remembered.soulMd) {
    parts.push(`SOUL.md:\n${remembered.soulMd}`);
  }
  const full = parts.join("\n\n");
  if (full.length <= maxLen) return full;
  return full.slice(0, maxLen) + "...";
}

/**
 * @brief Adds a message to the chat display.
 * User messages are shown as plain text; assistant messages are rendered as Markdown.
 * @param role - "user" or "assistant"
 * @param content - Message text content (Markdown for assistant)
 * @param remembered - Optional content Maia remembered (per file); shown in icon tooltip on hover
 */
function addMessage(
  role: "user" | "assistant",
  content: string,
  remembered?: { memoryMd?: string; userMd?: string; soulMd?: string }
): void {
  // Remove welcome message on first chat
  if (welcomeVisible) {
    const welcome = messagesContainer.querySelector(".welcome-message");
    if (welcome) welcome.remove();
    welcomeVisible = false;
  }

  const div = document.createElement("div");
  div.className = `message ${role}`;

  const body = document.createElement("div");
  body.className = "message-body";

  if (role === "user") {
    body.textContent = content;
    body.style.whiteSpace = "pre-wrap";
  } else {
    body.textContent = content; // placeholder until markdown resolves
    renderMarkdown(content).then((html) => {
      body.innerHTML = html;
      body.style.whiteSpace = "";
      scrollToBottom();
    });
  }

  div.appendChild(body);

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = new Date().toLocaleTimeString();
  const hasRemembered = remembered && (
    (remembered.memoryMd?.trim()) ||
    (remembered.userMd?.trim()) ||
    (remembered.soulMd?.trim())
  );
  if (role === "assistant" && hasRemembered) {
    const rememberBlurb = document.createElement("span");
    rememberBlurb.className = "message-remembered";
    const tooltip = formatRememberedTooltip(remembered);
    rememberBlurb.title = tooltip;
    rememberBlurb.setAttribute("aria-label", tooltip);
    rememberBlurb.innerHTML = "&#128161; Maia will remember that";
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(rememberBlurb);
  }
  div.appendChild(meta);

  messagesContainer.appendChild(div);
  scrollToBottom();
}

/**
 * @brief Adds an error message to the chat display.
 * @param message - Error text
 */
function addErrorMessage(message: string): void {
  const div = document.createElement("div");
  div.className = "message error";
  div.textContent = message;
  messagesContainer.appendChild(div);
  scrollToBottom();
}

/**
 * @brief Shows the typing indicator.
 */
function showTypingIndicator(): void {
  let indicator = messagesContainer.querySelector(".typing-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "typing-indicator";
    indicator.innerHTML =
      '<div class="typing-dot"></div>' +
      '<div class="typing-dot"></div>' +
      '<div class="typing-dot"></div>';
    messagesContainer.appendChild(indicator);
  }
  indicator.classList.add("visible");
  scrollToBottom();
}

/**
 * @brief Hides the typing indicator.
 */
function hideTypingIndicator(): void {
  const indicator = messagesContainer.querySelector(".typing-indicator");
  if (indicator) {
    indicator.classList.remove("visible");
  }
}

/**
 * @brief Updates the connection status indicator.
 * @param status - "connected", "disconnected", or "connecting"
 */
function updateStatus(status: "connected" | "disconnected" | "connecting"): void {
  connectionStatus.className = `status-indicator ${status}`;
  connectionStatus.textContent =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting..."
        : "Disconnected";
}

/**
 * @brief Enables or disables the input area.
 * @param enabled - Whether to enable input
 */
function setInputEnabled(enabled: boolean): void {
  chatInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  if (enabled) {
    chatInput.focus();
  }
}

/**
 * @brief Scrolls the message container to the bottom.
 */
function scrollToBottom(): void {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// ─── Event Handlers ─────────────────────────────────────────────

/**
 * @brief Handles form submission (sending a chat message).
 */
chatForm.addEventListener("submit", (e: Event): void => {
  e.preventDefault();

  const content = chatInput.value.trim();
  if (!content) return;

  // Add user message to display
  addMessage("user", content);

  // Send to server
  messageIdCounter++;
  sendMessage({
    type: "chat",
    id: String(messageIdCounter),
    content,
  });

  // Show typing indicator
  showTypingIndicator();

  // Clear input
  chatInput.value = "";
  chatInput.style.height = "auto";
});

/**
 * @brief Auto-resize textarea and handle Enter key for sending.
 */
chatInput.addEventListener("input", (): void => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
});

chatInput.addEventListener("keydown", (e: KeyboardEvent): void => {
  // Enter sends, Shift+Enter adds newline
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

/**
 * @brief Handles token form submit: validates token, then stores and connects.
 */
tokenForm.addEventListener("submit", async (e: Event): Promise<void> => {
  e.preventDefault();
  const raw = tokenInput.value.trim();
  if (!raw) {
    setTokenGateError("Please enter your access token.");
    return;
  }

  tokenConnectBtn.disabled = true;
  setTokenGateError("");

  const valid = await validateToken(raw);
  tokenConnectBtn.disabled = false;

  if (!valid) {
    setTokenGateError("Invalid token. Check MAIA_AUTH_TOKEN from your .env and try again.");
    return;
  }

  setAuthToken(raw);
  tokenInput.value = "";
  hideTokenGate();
  disconnect();
  connect();
});

/**
 * @brief Re-enter token: clear storage, disconnect, show token gate.
 */
reenterTokenBtn.addEventListener("click", (): void => {
  clearAuthToken();
  disconnect();
  showTokenGate();
});

// ─── Initialization ─────────────────────────────────────────────

setInputEnabled(false);
if (getAuthToken()) {
  hideTokenGate();
  reenterTokenBtn.style.display = "block";
  connect();
} else {
  showTokenGate();
}
