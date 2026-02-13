/**
 * @fileoverview Error handler middleware for the gateway. Catches errors from
 * request handlers and produces structured JSON error responses.
 * @module gateway/middleware/error-handler
 *
 * @note Maps known MaiaError subclasses to appropriate HTTP status codes
 * and error response bodies. Unknown errors are mapped to 500.
 */

import { MaiaError, AuthError, RateLimitError, ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/types.js";

/**
 * @brief Dependencies for createErrorHandler.
 */
export interface ErrorHandlerDeps {
  logger: Logger;
  /** Whether to include stack traces in error responses (dev mode) */
  includeStack?: boolean;
}

/**
 * @brief Structured error response body.
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    stack?: string;
  };
  statusCode: number;
  headers: Record<string, string>;
}

/**
 * @brief Error handler interface.
 */
export interface ErrorHandler {
  /**
   * @brief Converts an error into a structured HTTP error response.
   * @param err - The error that was caught
   * @returns ErrorResponse with code, message, status code, and headers
   */
  handle(err: unknown): ErrorResponse;
}

/**
 * @brief Creates an error handler middleware.
 * @param deps - Dependencies: logger, optional includeStack flag
 * @returns ErrorHandler instance
 *
 * @example
 * const errorHandler = createErrorHandler({ logger, includeStack: false });
 * try {
 *   await processRequest(req);
 * } catch (err) {
 *   const response = errorHandler.handle(err);
 *   res.status(response.statusCode).json(response.error);
 * }
 */
export function createErrorHandler(deps: ErrorHandlerDeps): ErrorHandler {
  const { logger, includeStack = false } = deps;

  return {
    handle(err: unknown): ErrorResponse {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Rate limit error: include Retry-After header
      if (err instanceof RateLimitError) {
        headers["Retry-After"] = String(err.retryAfter);
        logger.warn("Rate limit error", { retryAfter: err.retryAfter });
        return {
          error: {
            code: err.code,
            message: err.message,
            ...(includeStack && err.stack ? { stack: err.stack } : {}),
          },
          statusCode: err.statusCode,
          headers,
        };
      }

      // Auth error
      if (err instanceof AuthError) {
        logger.warn("Auth error", { message: err.message });
        return {
          error: {
            code: err.code,
            message: err.message,
            ...(includeStack && err.stack ? { stack: err.stack } : {}),
          },
          statusCode: err.statusCode,
          headers,
        };
      }

      // Validation error
      if (err instanceof ValidationError) {
        logger.warn("Validation error", {
          field: err.field,
          message: err.message,
        });
        return {
          error: {
            code: err.code,
            message: err.message,
            ...(includeStack && err.stack ? { stack: err.stack } : {}),
          },
          statusCode: err.statusCode,
          headers,
        };
      }

      // Generic MaiaError
      if (err instanceof MaiaError) {
        logger.error("Application error", {
          code: err.code,
          message: err.message,
        });
        return {
          error: {
            code: err.code,
            message: err.message,
            ...(includeStack && err.stack ? { stack: err.stack } : {}),
          },
          statusCode: 500,
          headers,
        };
      }

      // Unknown error
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred";
      const stack = err instanceof Error ? err.stack : undefined;

      logger.error("Unhandled error", { message });

      return {
        error: {
          code: "INTERNAL_ERROR",
          message,
          ...(includeStack && stack ? { stack } : {}),
        },
        statusCode: 500,
        headers,
      };
    },
  };
}
