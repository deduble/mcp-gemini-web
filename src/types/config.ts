/**
 * Configuration types for rate limiting, retry logic, and Gemini client.
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  requestsPerMinute: number;
  /** Maximum burst capacity (allows temporary spikes) */
  maxBurst: number;
}

export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay before first retry in milliseconds */
  baseDelay: number;
  /** Maximum delay between retries in milliseconds */
  maxDelay: number;
  /** Jitter factor (0-1) to add randomness to delays */
  jitterFactor: number;
}

export interface ClientConfig {
  /** Gemini API key */
  apiKey: string;
  /** Optional base URL override */
  baseUrl?: string;
  /** Default request timeout in milliseconds */
  timeout: number;
  /** Rate limiter configuration */
  rateLimiter: RateLimiterConfig;
  /** Retry configuration */
  retry: RetryConfig;
  /** Fallback model to use on specific errors */
  fallbackModel?: string;
  /** Default model to use */
  defaultModel?: string;
}

export interface GenerateContentParams {
  model: string;
  prompt: string;
  maxOutputTokens?: number;
  systemInstruction?: string;
  responseMimeType?: string;
  useSearch?: boolean;
}

export interface GenerateContentResult {
  text: string;
  sources: Array<{ uri: string; title: string }>;
  queries: string[];
  raw: any;
}

export interface BatchResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  index: number;
}

export interface HealthMetrics {
  healthy: boolean;
  uptime: number;
  requestsTotal: number;
  requestsPending: number;
  lastError?: string;
  lastErrorTime?: number;
  rateLimitTokens: number;
}

/** Custom error types for better error handling */

export class GeminiApiError extends Error {
  code: string;
  statusCode: number;
  retryable: boolean;

  constructor(message: string, code: string, statusCode: number, retryable: boolean = false) {
    super(message);
    this.name = "GeminiApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class RateLimitError extends GeminiApiError {
  retryAfter?: number;

  constructor(message: string, retryAfter?: number) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, true);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class TimeoutError extends GeminiApiError {
  timeout: number;

  constructor(message: string, timeout: number) {
    super(message, "TIMEOUT", 408, true);
    this.name = "TimeoutError";
    this.timeout = timeout;
  }
}

export class ConcurrencyLimitError extends GeminiApiError {
  queuePosition: number;

  constructor(message: string, queuePosition: number) {
    super(message, "CONCURRENCY_LIMIT", 429, true);
    this.name = "ConcurrencyLimitError";
    this.queuePosition = queuePosition;
  }
}
