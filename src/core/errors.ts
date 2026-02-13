/**
 * @fileoverview Typed error hierarchy for the Maia system.
 * @module core/errors
 *
 * @note All Maia errors extend MaiaError with a machine-readable code.
 * Specific error subclasses carry additional context (status codes, field names, etc.).
 */

/**
 * @brief Base error class for all Maia errors.
 * @param code - Machine-readable error code
 * @param message - Human-readable error description
 */
export class MaiaError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MaiaError";
    // Maintain proper prototype chain for instanceof
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * @brief Configuration-related error.
 * @param message - Description of the config issue
 */
export class ConfigError extends MaiaError {
  constructor(message: string) {
    super("CONFIG_ERROR", message);
    this.name = "ConfigError";
  }
}

/**
 * @brief Authentication error with HTTP status code.
 * @param message - Description of the auth failure
 */
export class AuthError extends MaiaError {
  public readonly statusCode = 401;

  constructor(message: string) {
    super("AUTH_ERROR", message);
    this.name = "AuthError";
  }
}

/**
 * @brief Rate limit exceeded error with retry-after hint.
 * @param retryAfter - Seconds until the client can retry
 */
export class RateLimitError extends MaiaError {
  public readonly statusCode = 429;
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("RATE_LIMITED", `Rate limit exceeded. Retry after ${retryAfter}s.`);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

/**
 * @brief LLM provider error.
 * @param providerId - The provider that failed
 * @param message - Description of the failure
 */
export class ProviderError extends MaiaError {
  public readonly providerId: string;

  constructor(providerId: string, message: string) {
    super("PROVIDER_ERROR", message);
    this.name = "ProviderError";
    this.providerId = providerId;
  }
}

/**
 * @brief Memory subsystem error.
 * @param message - Description of the memory error
 */
export class MemoryError extends MaiaError {
  constructor(message: string) {
    super("MEMORY_ERROR", message);
    this.name = "MemoryError";
  }
}

/**
 * @brief Input validation error with field context.
 * @param field - The field that failed validation
 * @param message - Description of the validation failure
 */
export class ValidationError extends MaiaError {
  public readonly field: string;
  public readonly statusCode = 400;

  constructor(field: string, message: string) {
    super("VALIDATION_ERROR", `${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

/**
 * @brief Security-related error with severity level.
 * @param message - Description of the security issue
 * @param severity - "low" | "medium" | "high" | "critical"
 */
export class SecurityError extends MaiaError {
  public readonly severity: string;

  constructor(message: string, severity: string) {
    super("SECURITY_ERROR", message);
    this.name = "SecurityError";
    this.severity = severity;
  }
}
