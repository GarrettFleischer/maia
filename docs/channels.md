# Channel Setup Guides

Maia supports four communication channels. Each channel is an adapter that normalizes messages to a common format and handles channel-specific formatting on output.

## Channel Overview

| Channel | Type | Requirements | Use Case |
|---------|------|--------------|----------|
| **CLI** | Interactive REPL | None | Development, local chat |
| **WebChat** | Browser-based | Gateway running | Web interface |
| **Discord** | Discord bot | Bot token | Team/personal Discord |
| **Telegram** | Telegram bot | Bot token | Mobile chat |

## CLI

The CLI channel is an interactive REPL (Read-Eval-Print Loop) that runs in your terminal.

### Setup

No configuration needed. Enabled by default.

```bash
# Start interactive chat
maia chat
```

### Features

- Full ANSI color output with markdown rendering
- Arrow key history navigation
- Multi-line input (paste or Shift+Enter)
- `/private` command for privacy mode
- `/quit` to exit

### Configuration

```json5
{
  "channels": {
    "cli": {
      "enabled": true
    }
  }
}
```

### Message Formatting

- Full ANSI color codes for syntax highlighting
- Markdown headers, bold, italic, code blocks rendered in terminal
- No message length limits

## WebChat

A browser-based chat interface served by the gateway.

### Setup

1. Start the gateway:

   ```bash
   maia start
   ```

2. Open `http://localhost:3000` in your browser

The WebChat frontend is a static HTML/CSS/JS page served by the gateway. It connects via WebSocket for real-time streaming.

### Configuration

```json5
{
  "gateway": {
    "port": 3000,
    "auth": {
      "token": "${MAIA_AUTH_TOKEN}"
    }
  },
  "channels": {
    "webchat": {
      "enabled": true
    }
  }
}
```

### Message Formatting

- Full HTML/markdown rendering
- Code syntax highlighting
- No practical message length limits
- Streaming response display

## Discord

Connect Maia as a Discord bot.

### Setup

1. **Create a Discord Application**:
   - Go to [discord.com/developers/applications](https://discord.com/developers/applications)
   - Click "New Application", give it a name
   - Go to the "Bot" section
   - Click "Add Bot"
   - Under "Privileged Gateway Intents", enable:
     - Message Content Intent
     - Server Members Intent (if needed)

2. **Get the bot token**:
   - In the Bot section, click "Reset Token"
   - Copy the token

3. **Store the token securely**:

   ```bash
   maia credentials add discord-bot-token
   ```

4. **Invite the bot to your server**:
   - Go to OAuth2 > URL Generator
   - Select scopes: `bot`, `applications.commands`
   - Select permissions: `Send Messages`, `Read Message History`, `Embed Links`
   - Copy the generated URL and open it in your browser

5. **Configure Maia**:

   ```json5
   {
     "channels": {
       "discord": {
         "enabled": true,
         "credentialName": "discord-bot-token"
       }
     }
   }
   ```

### Discord-Specific Behavior

- Responds to direct messages
- In servers, responds when mentioned (`@Maia`) or when configured prefixes are used
- Group chat rules from AGENTS.md apply in server channels

### Message Formatting

- Discord-flavored markdown (bold, italic, code, spoilers)
- No headers (Discord does not render `#` headers)
- Links wrapped in `<>` to suppress embeds
- Tables converted to bullet lists
- Messages longer than 2000 characters are split into multiple messages

## Telegram

Connect Maia as a Telegram bot.

### Setup

1. **Create a Telegram bot**:
   - Open Telegram and message [@BotFather](https://t.me/BotFather)
   - Send `/newbot`
   - Choose a name and username for your bot
   - BotFather gives you a token

2. **Store the token securely**:

   ```bash
   maia credentials add telegram-bot-token
   ```

3. **Configure Maia**:

   ```json5
   {
     "channels": {
       "telegram": {
         "enabled": true,
         "credentialName": "telegram-bot-token"
       }
     }
   }
   ```

4. **Start Maia** and message your bot on Telegram

### Telegram-Specific Behavior

- Responds to all direct messages
- In group chats, responds when mentioned or when commands are used
- Supports inline keyboards for structured responses (future)

### Message Formatting

- Telegram HTML subset: `<b>`, `<i>`, `<code>`, `<pre>`, `<a>`
- Markdown converted to Telegram HTML automatically
- Messages longer than 4096 characters are split

## Channel Adapter Interface

All channels implement the `Channel` interface:

```typescript
interface Channel {
  readonly id: string;
  readonly name: string;
  initialize(config: ChannelConfig): Promise<void>;
  shutdown(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: InboundMessageHandler): void;
}
```

Each channel also has a `MessageFormatter` that translates the agent's response into the appropriate format:

```typescript
interface MessageFormatter {
  format(content: string, channel: string): string;
  splitIfNeeded(content: string, maxLength: number): string[];
}
```

## Adding a New Channel

To add a new channel:

1. Create `src/channels/my-channel.ts` implementing the `Channel` interface
2. Create a formatter entry in `src/channels/formatter.ts`
3. Register the channel in `src/channels/index.ts`
4. Add configuration schema in `src/core/config/schema.ts`
5. Write tests in `tests/unit/channels/my-channel.test.ts`

## Multi-Channel Architecture

```
Discord ──┐
Telegram ─┤
WebChat ──┼─→ Normalize to InboundMessage ──→ Agent Runtime
CLI ──────┘                                        │
                                                   │
Discord ──┐                                        │
Telegram ─┤                                        │
WebChat ──┼─← Format OutboundMessage ←────────────┘
CLI ──────┘
```

The agent runtime does not know which channel a message came from. It processes normalized `InboundMessage` objects and returns `OutboundMessage` objects. The channel adapter handles all formatting and delivery.
