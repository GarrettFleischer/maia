# Credential Store

The credential store is Maia's secure, LLM-opaque vault for API keys and tokens. It is the critical security boundary that prevents the LLM from ever seeing your secret credentials.

## How It Works

```
┌──────────────────┐     ┌────────────────────┐     ┌─────────────┐
│   User stores    │     │   Tool describes   │     │ At execution │
│   API key via    │────▶│   credential by    │────▶│ time, runtime│
│   CLI            │     │   NAME only        │     │ resolves and │
│                  │     │   (LLM sees this)  │     │ injects key  │
└──────────────────┘     └────────────────────┘     └─────────────┘
                                                           │
                                                    The LLM never
                                                    sees the actual
                                                    key value
```

1. You store credentials via CLI: `maia credentials add github-token`
2. The credential is encrypted and stored in `~/.maia/credentials/vault.enc`
3. Tool descriptions reference credentials by **name** (e.g., "authenticates using credential: github-token")
4. When a tool runs, the runtime resolves the credential name to its encrypted value and injects it into the HTTP request at the transport layer
5. The LLM never has the actual key in its prompt, conversation history, or memory

## Why LLM-Opaque?

Even if a prompt injection attack tricks the LLM into trying to reveal credentials, it cannot:

- The key values are never in the LLM's context window
- The LLM only knows credential **names**, not values
- Credential resolution happens at the Bun/Node runtime layer, outside the LLM's reach
- The secret scanner catches any accidental leakage into memory

## CLI Commands

### Add a Credential

```bash
maia credentials add <name>
```

Prompts for the value securely (input hidden). Example:

```bash
$ maia credentials add groq-api-key
Enter value for 'groq-api-key': ********
Credential 'groq-api-key' stored securely.
```

### List Credentials

```bash
maia credentials list
```

Shows credential names (never values):

```
Stored credentials:
  - groq-api-key (added 2026-02-10)
  - github-token (added 2026-02-12)
  - discord-bot-token (added 2026-02-13)
```

### Remove a Credential

```bash
maia credentials remove <name>
```

```bash
$ maia credentials remove github-token
Credential 'github-token' removed.
```

## Encryption Details

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key derivation**: Argon2id from user passphrase
  - Memory: 64 MiB
  - Iterations: 3
  - Parallelism: 4
  - Salt: random 16 bytes per vault
- **Storage**: Single encrypted JSON file at `~/.maia/credentials/vault.enc`
- **File permissions**: `600` (owner read/write only, best-effort on Windows)

### Vault Format (Encrypted)

When decrypted, the vault is a JSON object:

```json
{
  "version": 1,
  "credentials": {
    "groq-api-key": {
      "value": "gsk_abc123...",
      "addedAt": "2026-02-10T14:30:00.000Z"
    }
  }
}
```

This JSON is encrypted as a single blob. Individual credentials cannot be decrypted separately.

## Master Passphrase

On first use, the credential store prompts for a master passphrase:

```bash
$ maia credentials add my-key
No credential vault found. Creating new vault.
Enter master passphrase: ********
Confirm passphrase: ********
Vault created.
Enter value for 'my-key': ********
Credential 'my-key' stored securely.
```

On subsequent uses, the passphrase is needed to unlock:

```bash
$ maia credentials list
Enter master passphrase: ********
Stored credentials:
  - my-key (added 2026-02-13)
```

### Passphrase Caching

During a gateway session, the derived master key is held in memory (never written to disk). This means:

- You enter the passphrase once when starting the gateway
- Credentials are available for the session duration
- The key is zeroed on graceful shutdown

## Using Credentials in Config

Reference credentials by name in provider/channel configuration:

```json5
{
  "provider": {
    "groq": {
      "credentialName": "groq-api-key"  // Name, not the actual key
    }
  },
  "channels": {
    "discord": {
      "credentialName": "discord-bot-token"
    }
  }
}
```

## Using Credentials in Tools

Tools reference credentials by name. The tool description the LLM sees:

```
web_fetch: Fetch a URL. Optional authentication via stored credential.
Parameters:
  - url: string (required)
  - credentialName: string (optional) -- name of stored credential for auth
```

What the LLM sends:

```json
{
  "tool": "web_fetch",
  "args": { "url": "https://api.github.com/user", "credentialName": "github-token" }
}
```

What happens at execution time (invisible to LLM):

```typescript
const credential = await credentialStore.get("github-token");
const response = await httpClient.fetch(url, {
  headers: { Authorization: `Bearer ${credential.value}` },
});
```

## Security Audit Trail

All credential operations are logged to the audit log:

```
[CREDENTIAL_ADD] name=groq-api-key
[CREDENTIAL_ACCESS] name=github-token tool=web_fetch
[CREDENTIAL_REMOVE] name=old-key
```

The audit log never contains credential values.

## Backup and Restore

The credential vault is included in backups (`maia backup`). Since the backup itself is encrypted with the same master key, credentials remain protected.

When restoring (`maia restore`), the vault is restored as-is. The master passphrase is needed to access credentials.
