/**
 * @fileoverview Zod schema for Maia configuration validation.
 * @module core/config/schema
 *
 * @note Defines the complete configuration shape with defaults for optional fields.
 * Validated at startup; invalid configs produce clear error messages.
 */

import { z } from "zod";

/**
 * @brief Configuration schema with defaults for optional fields.
 */
export const configSchema = z.object({
  identity: z.object({
    name: z.string().default("Maia"),
    emoji: z.string().default("🌙"),
    personality: z.string().default("helpful, security-conscious assistant"),
  }).default({}),

  workspace: z.object({
    path: z.string().default("~/.maia/workspace"),
  }).default({}),

  provider: z.object({
    primary: z.enum(["ollama", "groq", "gemini", "huggingface", "openrouter"]),
    model: z.string().min(1),
    fallback: z.object({
      provider: z.enum(["ollama", "groq", "gemini", "huggingface", "openrouter"]),
      model: z.string().min(1),
    }).optional(),
    healthCheck: z.object({
      enabled: z.boolean().default(true),
      intervalMs: z.number().positive().default(60000),
      consecutiveFailures: z.number().positive().default(3),
    }).default({}),
    ollama: z.object({ baseUrl: z.string().default("http://localhost:11434") }).optional(),
    groq: z.object({ credentialName: z.string() }).optional(),
    gemini: z.object({ credentialName: z.string() }).optional(),
    huggingface: z.object({ credentialName: z.string() }).optional(),
    openrouter: z.object({ credentialName: z.string() }).optional(),
  }),

  gateway: z
    .object({
      port: z.number().int().positive().default(3000),
      host: z.string().default("0.0.0.0"),
      auth: z.object({
        token: z.string().default(""),
      }).default({}),
      cors: z.object({
        origins: z.array(z.string()).default(["http://localhost:3000"]),
      }).default({}),
    })
    .default({
      port: 3000,
      host: "0.0.0.0",
      auth: { token: "" },
      cors: { origins: ["http://localhost:3000"] },
    }),

  channels: z
    .object({
      cli: z.object({ enabled: z.boolean().default(true) }).default({}),
      webchat: z.object({ enabled: z.boolean().default(false) }).default({}),
      discord: z.object({
        enabled: z.boolean().default(false),
        credentialName: z.string().optional(),
      }).default({}),
      telegram: z.object({
        enabled: z.boolean().default(false),
        credentialName: z.string().optional(),
      }).default({}),
    })
    .default({
      cli: { enabled: true },
      webchat: { enabled: false },
      discord: { enabled: false },
      telegram: { enabled: false },
    }),

  memory: z
    .object({
      enabled: z.boolean().default(true),
      embeddingProvider: z.string().default("ollama"),
      embeddingModel: z.string().default("nomic-embed-text"),
      search: z.object({
        hybrid: z.object({
          enabled: z.boolean().default(true),
          vectorWeight: z.number().min(0).max(1).default(0.7),
          textWeight: z.number().min(0).max(1).default(0.3),
        }).default({}),
        defaultLimit: z.number().int().positive().default(5),
      }).default({}),
      autoCapture: z.boolean().default(true),
      autoRecall: z.boolean().default(true),
      consolidation: z.object({
        schedule: z.string().default("0 23 * * *"),
        onDemand: z.boolean().default(true),
        sizeThreshold: z.number().positive().default(5000),
      }).default({}),
    })
    .default({
      enabled: true,
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      search: {
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
        defaultLimit: 5,
      },
      autoCapture: true,
      autoRecall: true,
      consolidation: {
        schedule: "0 23 * * *",
        onDemand: true,
        sizeThreshold: 5000,
      },
    }),

  security: z
    .object({
      rateLimiting: z.object({
        maxRequests: z.number().int().positive().default(60),
        windowMs: z.number().positive().default(60000),
      }).default({}),
      promptInjection: z.object({
        detection: z.boolean().default(true),
        wrapping: z.boolean().default(true),
      }).default({}),
      ssrf: z.object({
        blockPrivateIPs: z.boolean().default(true),
      }).default({}),
      encryption: z.object({
        enabled: z.boolean().default(false),
        scope: z.array(z.string()).default([]),
      }).default({}),
      secretScanner: z.object({
        enabled: z.boolean().default(true),
        patterns: z.array(z.string()).default([]),
      }).default({}),
      auditLog: z.object({
        enabled: z.boolean().default(true),
      }).default({}),
      toolPermissions: z.record(z.object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })).default({
        main: { allow: ["*"] },
        group: { allow: ["memory_search"], deny: ["web_fetch"] },
      }),
      sandbox: z.object({
        enabled: z.boolean().default(true),
        root: z.string().optional(),
      }).default({}),
    })
    .default({
      rateLimiting: { maxRequests: 60, windowMs: 60000 },
      promptInjection: { detection: true, wrapping: true },
      ssrf: { blockPrivateIPs: true },
      encryption: { enabled: false, scope: [] },
      secretScanner: { enabled: true, patterns: [] },
      auditLog: { enabled: true },
      toolPermissions: {
        main: { allow: ["*"] },
        group: { allow: ["memory_search"], deny: ["web_fetch"] },
      },
      sandbox: { enabled: true },
    }),

  scheduler: z.object({
    enabled: z.boolean().default(true),
    checkIntervalMs: z.number().positive().default(60000),
  }).default({}),

  watchdog: z.object({
    enabled: z.boolean().default(true),
    healthCheckIntervalMs: z.number().positive().default(60000),
    threatWindow: z.object({
      durationMs: z.number().positive().default(300000),
      bruteForceThreshold: z.number().int().positive().default(10),
      injectionThreshold: z.number().int().positive().default(5),
    }).default({}),
    alertChannels: z.array(z.string()).default(["console"]),
    autoShutdown: z.boolean().default(true),
  }).default({}),

  session: z
    .object({
      compaction: z
        .object({
          thresholdPercent: z.number().min(1).max(100).default(80),
          preserveRecentMessages: z.number().int().positive().default(10),
        })
        .default({ thresholdPercent: 80, preserveRecentMessages: 10 }),
    })
    .default({
      compaction: { thresholdPercent: 80, preserveRecentMessages: 10 },
    }),

  backup: z.object({
    includeAuditLog: z.boolean().default(false),
  }).default({}),
});

/**
 * @brief Inferred TypeScript type from the config schema.
 */
export type ValidatedConfig = z.infer<typeof configSchema>;
