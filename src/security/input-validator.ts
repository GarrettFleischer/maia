/**
 * @fileoverview Input validators for chat, memory store, and memory search requests.
 * Uses Zod for schema validation. Returns typed data or error message.
 * @module security/input-validator
 */

import { z } from "zod";
import type { MemoryCategory } from "../core/types.js";

/**
 * @brief Validated chat request payload.
 */
export interface ChatRequest {
  message: string;
  sessionId?: string;
  private?: boolean;
}

/**
 * @brief Validated memory store request payload.
 */
export interface MemoryStoreRequest {
  text: string;
  category: MemoryCategory;
  importance: number;
}

/**
 * @brief Validated memory search request payload.
 */
export interface MemorySearchRequest {
  query: string;
  category?: MemoryCategory;
  limit?: number;
}

/**
 * @brief Result of validation (success or error).
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const memoryCategorySchema = z.enum(["preference", "fact", "decision", "entity", "other"]);

const chatRequestSchema = z.object({
  message: z.string().min(1, "message is required and must be non-empty"),
  sessionId: z.string().optional(),
  private: z.boolean().optional(),
});

const memoryStoreRequestSchema = z.object({
  text: z.string().min(1, "text is required and must be non-empty"),
  category: memoryCategorySchema,
  importance: z.number().min(0).max(1),
});

const memorySearchRequestSchema = z.object({
  query: z.string().min(1, "query is required and must be non-empty"),
  category: memoryCategorySchema.optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * @brief Validates a chat request payload.
 * @param data - Unknown payload to validate
 * @returns { success, data?, error? }
 */
export function validateChatRequest(data: unknown): ValidationResult<ChatRequest> {
  const result = chatRequestSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as ChatRequest };
  }
  const msg = result.error.issues.map((e) => e.message).join("; ");
  return { success: false, error: msg };
}

/**
 * @brief Validates a memory store request payload.
 * @param data - Unknown payload to validate
 * @returns { success, data?, error? }
 */
export function validateMemoryStoreRequest(data: unknown): ValidationResult<MemoryStoreRequest> {
  const result = memoryStoreRequestSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as MemoryStoreRequest };
  }
  const msg = result.error.issues.map((e) => e.message).join("; ");
  return { success: false, error: msg };
}

/**
 * @brief Validates a memory search request payload.
 * @param data - Unknown payload to validate
 * @returns { success, data?, error? }
 */
export function validateMemorySearchRequest(data: unknown): ValidationResult<MemorySearchRequest> {
  const result = memorySearchRequestSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as MemorySearchRequest };
  }
  const msg = result.error.issues.map((e) => e.message).join("; ");
  return { success: false, error: msg };
}
