/**
 * Retry wrapper with exponential backoff and jitter.
 *
 * Implements the exponential backoff formula:
 * delay = min(baseDelay * 2^attempt, maxDelay) + random_jitter
 *
 * Jitter helps prevent the "thundering herd" problem where multiple
 * clients retry simultaneously after being rate-limited.
 */

import type { RetryConfig, GeminiApiError } from "../types/config.js";

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalDelay: number;
}

/**
 * Check if an error is retryable based on its type and properties.
 */
export function isRetryableError(error: unknown): boolean {
  // Already marked as retryable
  if (error instanceof Object && "retryable" in error) {
    return (error as { retryable: boolean }).retryable === true;
  }

  // Network errors (no response)
  if (!(error instanceof Error)) return false;

  const errorMessage = error.message.toLowerCase();

  // Check for common network error patterns
  const networkPatterns = [
    "econnreset",
    "etimedout",
    "enotfound",
    "econnrefused",
    "socket hang up",
    "network error",
    "fetch failed"
  ];
  if (networkPatterns.some(p => errorMessage.includes(p))) {
    return true;
  }

  // Check for HTTP status codes in error message
  const statusMatch = errorMessage.match(/status\s+(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    // Retry on 429 (Too Many Requests), 503 (Service Unavailable), 502 (Bad Gateway)
    return [429, 503, 502].includes(status);
  }

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
export function calculateDelay(
  attempt: number,
  config: RetryConfig
): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = config.baseDelay * Math.pow(2, attempt);

  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelay);

  // Add jitter: random value between -jitterFactor and +jitterFactor of the delay
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.floor(cappedDelay + jitter));
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn - The async function to retry
 * @param config - Retry configuration
 * @returns Promise with retry result containing data or error
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<RetryResult<T>> {
  let lastError: Error | undefined;
  let totalDelay = 0;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const data = await fn();
      return {
        success: true,
        data,
        attempts: attempt + 1,
        totalDelay
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const isLastAttempt = attempt === config.maxRetries;
      if (!isRetryableError(lastError) || isLastAttempt) {
        return {
          success: false,
          error: lastError,
          attempts: attempt + 1,
          totalDelay
        };
      }

      // Calculate delay and wait before retry
      const delay = calculateDelay(attempt, config);
      totalDelay += delay;
      await sleep(delay);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: config.maxRetries + 1,
    totalDelay
  };
}

/**
 * Simplified version that throws on failure (for easier integration).
 */
export async function retryWithBackoffOrThrow<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  const result = await retryWithBackoff(fn, config);
  if (!result.success) {
    throw result.error;
  }
  return result.data!;
}

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create retry config from environment variables with sensible defaults.
 */
export function createRetryConfig(): RetryConfig {
  return {
    maxRetries: parseInt(process.env.MAX_RETRIES || "5", 10),
    baseDelay: parseInt(process.env.BASE_RETRY_DELAY || "1000", 10),
    maxDelay: parseInt(process.env.MAX_RETRY_DELAY || "60000", 10),
    jitterFactor: parseFloat(process.env.JITTER_FACTOR || "0.1")
  };
}
