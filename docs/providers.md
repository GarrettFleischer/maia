# Free LLM Provider Setup

Maia is designed to work with free LLM providers. This guide walks through setting up each supported provider.

## Provider Summary

| Provider | Cost | Rate Limits | Best For | Models |
|----------|------|-------------|----------|--------|
| **Ollama** | Free (local) | None (your hardware) | Privacy, no rate limits | Llama 3, Mistral, Gemma, Phi |
| **Groq** | Free tier | ~30 RPM | Fast inference | Llama 3 70B, Mixtral, Gemma |
| **Google Gemini** | Free tier | 15 RPM | Large context windows | Gemini 1.5 Flash, Gemini Pro |
| **HuggingFace** | Free tier | Rate limited | Wide model variety | Mistral, Llama, Zephyr |
| **OpenRouter** | Some free models | Varies | Model variety, routing | Various community models |

## Ollama (Recommended -- Local, Free, Private)

Ollama runs LLMs locally on your machine. No API keys, no rate limits, complete privacy.

### Setup

1. **Install Ollama**:

   ```bash
   # Linux/macOS
   curl -fsSL https://ollama.ai/install.sh | sh

   # Windows
   # Download from https://ollama.ai/download
   ```

2. **Pull a model**:

   ```bash
   # Recommended: Llama 3.2 (3B, fast, capable)
   ollama pull llama3.2

   # For more capability (requires ~8GB RAM)
   ollama pull llama3.1:8b

   # For embeddings
   ollama pull nomic-embed-text
   ```

3. **Verify Ollama is running**:

   ```bash
   ollama list
   # Should show your pulled models
   ```

4. **Configure Maia**:

   ```json5
   {
     "provider": {
       "primary": "ollama",
       "model": "llama3.2",
       "ollama": {
         "baseUrl": "http://localhost:11434"  // default
       }
     },
     "memory": {
       "embeddingProvider": "ollama",
       "embeddingModel": "nomic-embed-text"
     }
   }
   ```

### Recommended Models

| Model | Size | RAM | Use Case |
|-------|------|-----|----------|
| `llama3.2` | 3B | ~4GB | General chat, fast responses |
| `llama3.1:8b` | 8B | ~8GB | Better reasoning, longer context |
| `mistral` | 7B | ~8GB | Good balance of speed and quality |
| `gemma2:2b` | 2B | ~3GB | Lightweight, fast |
| `phi3:mini` | 3.8B | ~4GB | Good for code and reasoning |
| `nomic-embed-text` | 137M | ~1GB | Text embeddings for memory search |

## Groq

Groq offers extremely fast inference on their custom LPU hardware. Free tier with rate limits.

### Setup

1. **Create account**: Go to [console.groq.com](https://console.groq.com)
2. **Get API key**: Navigate to API Keys and create a new key
3. **Store the key securely**:

   ```bash
   maia credentials add groq-api-key
   # Paste your key when prompted
   ```

4. **Configure Maia**:

   ```json5
   {
     "provider": {
       "primary": "groq",
       "model": "llama-3.3-70b-versatile",
       "groq": {
         "credentialName": "groq-api-key"
       }
     }
   }
   ```

### Available Free Models

| Model | Context | Speed | Notes |
|-------|---------|-------|-------|
| `llama-3.3-70b-versatile` | 128K | Very fast | Best free model on Groq |
| `llama-3.1-8b-instant` | 128K | Extremely fast | Good for simple tasks |
| `mixtral-8x7b-32768` | 32K | Fast | Good reasoning |
| `gemma2-9b-it` | 8K | Fast | Google's Gemma 2 |

### Rate Limits

- ~30 requests per minute (free tier)
- ~14,400 tokens per minute for large models
- Maia's request queue handles this automatically

## Google Gemini

Google's Gemini models with generous free tier and large context windows.

### Setup

1. **Get API key**: Go to [aistudio.google.com](https://aistudio.google.com)
2. **Create an API key** in Google AI Studio
3. **Store the key**:

   ```bash
   maia credentials add gemini-api-key
   ```

4. **Configure Maia**:

   ```json5
   {
     "provider": {
       "primary": "gemini",
       "model": "gemini-2.0-flash",
       "gemini": {
         "credentialName": "gemini-api-key"
       }
     }
   }
   ```

### Available Free Models

| Model | Context | RPM | Notes |
|-------|---------|-----|-------|
| `gemini-2.0-flash` | 1M tokens | 15 | Default; latest Flash, recommended |
| `gemini-1.5-flash` | 1M tokens | 15 | Legacy; may 404 on some keys |
| `gemini-1.5-pro` | 2M tokens | 2 | More capable, slower |

### Rate Limits

- 15 requests per minute (Flash)
- 2 requests per minute (Pro)
- 1 million token context (Flash) -- excellent for long conversations

## HuggingFace

HuggingFace's free Inference API provides access to many open-source models.

### Setup

1. **Create account**: Go to [huggingface.co](https://huggingface.co)
2. **Get token**: Settings > Access Tokens > New Token (select "Read" scope)
3. **Store the token**:

   ```bash
   maia credentials add hf-api-token
   ```

4. **Configure Maia**:

   ```json5
   {
     "provider": {
       "primary": "huggingface",
       "model": "mistralai/Mistral-7B-Instruct-v0.3",
       "huggingface": {
         "credentialName": "hf-api-token"
       }
     }
   }
   ```

### Recommended Free Models

| Model | Size | Notes |
|-------|------|-------|
| `mistralai/Mistral-7B-Instruct-v0.3` | 7B | Reliable, fast |
| `meta-llama/Llama-3.2-3B-Instruct` | 3B | Compact, capable |
| `HuggingFaceH4/zephyr-7b-beta` | 7B | Good instruction following |

### Rate Limits

- Varies by model popularity and server load
- Free tier may have queue times during peak hours
- Maia's request queue and fallback handle this gracefully

## OpenRouter

OpenRouter aggregates multiple model providers, including some free models.

### Setup

1. **Create account**: Go to [openrouter.ai](https://openrouter.ai)
2. **Get API key**: Dashboard > Keys
3. **Store the key**:

   ```bash
   maia credentials add openrouter-api-key
   ```

4. **Configure Maia**:

   ```json5
   {
     "provider": {
       "primary": "openrouter",
       "model": "meta-llama/llama-3.2-3b-instruct:free",
       "openrouter": {
         "credentialName": "openrouter-api-key"
       }
     }
   }
   ```

### Free Models (as of 2026)

Check [openrouter.ai/models](https://openrouter.ai/models) for the latest free models. Models with `:free` suffix are free to use.

## Provider Fallback

Configure a fallback chain so Maia automatically switches if the primary provider is unavailable:

```json5
{
  "provider": {
    "primary": "ollama",
    "model": "llama3.2",
    "fallback": {
      "provider": "groq",
      "model": "llama-3.3-70b-versatile"
    }
  }
}
```

### How Fallback Works

1. Maia monitors each provider's health (latency, error rate, consecutive failures)
2. If the primary fails N consecutive times, it switches to the fallback
3. The user is notified of the switch
4. Maia periodically retries the primary and switches back when healthy
5. HTTP 429 (rate limit) responses trigger proactive fallback

## Request Queue

Free-tier providers have strict rate limits. Maia handles this with a per-provider request queue:

- Requests that would exceed the rate limit are queued (FIFO)
- The queue drains at the provider's rate limit
- Users see a "thinking..." indicator while queued
- If the queue exceeds a depth threshold (default: 5), overflow goes to the fallback provider

## Health Monitoring

Provider health is continuously monitored:

- **Latency tracking**: p50 and p95 response times
- **Error rate**: Rolling window of success/failure ratio
- **Consecutive failures**: Triggers fallback after N failures
- **Status endpoint**: `GET /api/health` returns provider status
- **Watchdog integration**: Provider health is part of periodic health checks

## Embeddings

Memory search requires text embeddings. Use the same provider or a dedicated one:

```json5
{
  "memory": {
    "embeddingProvider": "ollama",
    "embeddingModel": "nomic-embed-text"
  }
}
```

Supported embedding sources:
- **Ollama** (recommended): `nomic-embed-text`, `all-minilm`
- **HuggingFace**: `sentence-transformers/all-MiniLM-L6-v2`
- Any provider that supports the `embed()` method
