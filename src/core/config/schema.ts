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
  }).default({ name: "Maia", emoji: "🌙", personality: "helpful, security-conscious assistant" }),

  workspace: z.object({
    path: z.string().default("~/.maia/workspace"),
  }).default({ path: "~/.maia/workspace" }),

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
    }).default({ enabled: true, intervalMs: 60000, consecutiveFailures: 3 }),
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
      }).default({ token: "" }),
      cors: z.object({
        origins: z.array(z.string()).default(["http://localhost:3000"]),
      }).default({ origins: ["http://localhost:3000"] }),
    })
    .default({
      port: 3000,
      host: "0.0.0.0",
      auth: { token: "" },
      cors: { origins: ["http://localhost:3000"] },
    }),

  channels: z
    .object({
      cli: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
      webchat: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
      discord: z.object({
        enabled: z.boolean().default(false),
        credentialName: z.string().optional(),
      }).default({ enabled: false }),
      telegram: z.object({
        enabled: z.boolean().default(false),
        credentialName: z.string().optional(),
      }).default({ enabled: false }),
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
        }).default({ enabled: true, vectorWeight: 0.7, textWeight: 0.3 }),
        defaultLimit: z.number().int().positive().default(5),
      }).default({ hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 }, defaultLimit: 5 }),
      autoCapture: z.boolean().default(true),
      autoRecall: z.boolean().default(true),
      consolidation: z.object({
        schedule: z.string().default("0 23 * * *"),
        onDemand: z.boolean().default(true),
        sizeThreshold: z.number().positive().default(5000),
      }).default({ schedule: "0 23 * * *", onDemand: true, sizeThreshold: 5000 }),
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
      }).default({ maxRequests: 60, windowMs: 60000 }),
      promptInjection: z.object({
        detection: z.boolean().default(true),
        wrapping: z.boolean().default(true),
      }).default({ detection: true, wrapping: true }),
      ssrf: z.object({
        blockPrivateIPs: z.boolean().default(true),
      }).default({ blockPrivateIPs: true }),
      encryption: z.object({
        enabled: z.boolean().default(false),
        scope: z.array(z.string()).default([]),
      }).default({ enabled: false, scope: [] }),
      secretScanner: z.object({
        enabled: z.boolean().default(true),
        patterns: z.array(z.string()).default([]),
      }).default({ enabled: true, patterns: [] }),
      auditLog: z.object({
        enabled: z.boolean().default(true),
      }).default({ enabled: true }),
      toolPermissions: z.record(z.string(), z.object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })).default({
        main: { allow: ["*"] },
        group: { allow: ["memory_search"], deny: ["web_fetch"] },
      }),
      sandbox: z.object({
        enabled: z.boolean().default(true),
        root: z.string().optional(),
      }).default({ enabled: true }),
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
  }).default({ enabled: true, checkIntervalMs: 60000 }),

  watchdog: z.object({
    enabled: z.boolean().default(true),
    healthCheckIntervalMs: z.number().positive().default(60000),
    threatWindow: z.object({
      durationMs: z.number().positive().default(300000),
      bruteForceThreshold: z.number().int().positive().default(10),
      injectionThreshold: z.number().int().positive().default(5),
    }).default({ durationMs: 300000, bruteForceThreshold: 10, injectionThreshold: 5 }),
    alertChannels: z.array(z.string()).default(["console"]),
    autoShutdown: z.boolean().default(true),
  }).default({
    enabled: true,
    healthCheckIntervalMs: 60000,
    threatWindow: { durationMs: 300000, bruteForceThreshold: 10, injectionThreshold: 5 },
    alertChannels: ["console"],
    autoShutdown: true,
  }),

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
  }).default({ includeAuditLog: false }),

  mcp: z
    .object({
      servers: z
        .array(
          z.object({
            name: z.string().min(1),
            command: z.string().min(1),
            args: z.array(z.string()).optional().default([]),
          })
        )
        .optional()
        .default([]),
    })
    .default({ servers: [] }),
});

/**
 * @brief Inferred TypeScript type from the config schema.
 */
export type ValidatedConfig = z.infer<typeof configSchema>;
