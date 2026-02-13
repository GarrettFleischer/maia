/**
 * @fileoverview WebChat client logic for the Maia web interface.
 * @module web/chat
 *
 * @brief Handles WebSocket connection, message sending/receiving,
 * auto-reconnection, and UI updates.
 *
 * @note This module runs in the browser and connects to the Maia gateway
 * via WebSocket. It manages the chat UI lifecycle including message display,
 * typing indicators, and connection status.
 */

// ─── Configuration ──────────────────────────────────────────────

/** @brief Default WebSocket URL (relative to current host) */
const WS_URL = `ws://${window.location.host}/ws`;

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

// ─── State ──────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: number | null = null;
let messageIdCounter = 0;
let welcomeVisible = true;

// ─── WebSocket Management ───────────────────────────────────────

/**
 * @brief Establishes a WebSocket connection to the Maia gateway.
 * @note Automatically attempts reconnection on disconnect using
 * exponential backoff.
 */
function connect(): void {
  updateStatus("connecting");

  try {
    ws = new WebSocket(WS_URL);
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
    // onclose will also fire, so we just update status here
    updateStatus("disconnected");
  };
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
    };

    switch (msg.type) {
      case "chat_response":
        hideTypingIndicator();
        if (msg.content) {
          addMessage("assistant", msg.content);
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

// ─── UI Functions ───────────────────────────────────────────────

/**
 * @brief Adds a message to the chat display.
 * @param role - "user" or "assistant"
 * @param content - Message text content
 */
function addMessage(role: "user" | "assistant", content: string): void {
  // Remove welcome message on first chat
  if (welcomeVisible) {
    const welcome = messagesContainer.querySelector(".welcome-message");
    if (welcome) welcome.remove();
    welcomeVisible = false;
  }

  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = new Date().toLocaleTimeString();
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

// ─── Initialization ─────────────────────────────────────────────

setInputEnabled(false);
connect();
