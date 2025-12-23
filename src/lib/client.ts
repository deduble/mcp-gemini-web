/**
 * Wrapped Gemini client with timeout handling, retry logic, and rate limiting.
 *
 * Provides a resilient interface to the Google GenAI API with:
 * - Automatic retries with exponential backoff
 * - Request rate limiting via token bucket
 * - Per-request timeout handling
 * - Model fallback on specific errors
 * - Health check capabilities
 */

import { GoogleGenAI } from "@google/genai";
import { RateLimitError, TimeoutError } from "../types/config.js";
import type { ClientConfig, GenerateContentParams, GenerateContentResult, HealthMetrics } from "../types/config.js";
import { TokenBucket } from "./rateLimiter.js";
import { retryWithBackoffOrThrow, isRetryableError, createRetryConfig } from "./retry.js";

/**
 * Metrics tracking for health monitoring.
 */
interface Metrics {
  requestsTotal: number;
  requestsPending: number;
  errorsTotal: number;
  lastError?: Error;
  lastErrorTime?: number;
  startTime: number;
}

/**
 * Wrapped Gemini client with resilience features.
 */
export class GeminiClient {
  private readonly ai: GoogleGenAI;
  private readonly rateLimiter: TokenBucket;
  private readonly defaultTimeout: number;
  private readonly fallbackModel?: string;
  private readonly defaultModel: string;
  private readonly retryConfig = createRetryConfig();
  private metrics: Metrics;

  constructor(config: ClientConfig) {
    this.ai = new GoogleGenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? {
        httpOptions: { baseUrl: config.baseUrl }
      } : {})
    });
    this.rateLimiter = new TokenBucket(config.rateLimiter);
    this.defaultTimeout = config.timeout;
    this.fallbackModel = config.fallbackModel;
    this.defaultModel = config.defaultModel || "gemini-3-flash-preview";
    this.metrics = {
      requestsTotal: 0,
      requestsPending: 0,
      errorsTotal: 0,
      startTime: Date.now()
    };
  }

  /**
   * Generate content with retry, rate limiting, and timeout handling.
   */
  async generateContent(params: GenerateContentParams, timeout?: number): Promise<GenerateContentResult> {
    const effectiveTimeout = timeout ?? this.defaultTimeout;
    const model = params.model || this.defaultModel;

    // Acquire rate limit token
    await this.rateLimiter.acquire();

    // Track metrics
    this.metrics.requestsTotal++;
    this.metrics.requestsPending++;

    try {
      const result = await retryWithBackoffOrThrow(
        () => this.executeWithTimeout(model, params, effectiveTimeout),
        this.retryConfig
      );
      return result;
    } catch (error) {
      // Try fallback model if configured and error is retryable
      if (
        this.fallbackModel &&
        model !== this.fallbackModel &&
        isRetryableError(error)
      ) {
        try {
          return await retryWithBackoffOrThrow(
            () => this.executeWithTimeout(this.fallbackModel!, params, effectiveTimeout),
            { ...this.retryConfig, maxRetries: 2 } // Fewer retries for fallback
          );
        } catch {
          // Fall through to original error
        }
      }
      this.recordError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.metrics.requestsPending--;
    }
  }

  /**
   * Execute multiple queries in parallel (batch mode).
   * Returns results with individual success/failure status.
   */
  async generateContentBatch(
    paramsArray: GenerateContentParams[],
    timeout?: number
  ): Promise<Array<{ success: boolean; data?: GenerateContentResult; error?: Error }>> {
    const results = await Promise.allSettled(
      paramsArray.map((params, index) =>
        this.generateContent(params, timeout).then(data => ({ data, index }))
      )
    );

    return results.map((result, i) => {
      if (result.status === "fulfilled") {
        return { success: true, data: result.value.data };
      }
      return {
        success: false,
        error: result.reason instanceof Error ? result.reason : new Error(String(result.reason))
      };
    });
  }

  /**
   * Internal method to execute with timeout handling.
   */
  private async executeWithTimeout(
    model: string,
    params: GenerateContentParams,
    timeout: number
  ): Promise<GenerateContentResult> {
    try {
      const response = await this.ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: params.prompt }] }],
        config: {
          httpOptions: { timeout },
          ...(params.useSearch !== false ? { tools: [{ googleSearch: {} }] } : {}),
          ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
          ...(params.responseMimeType ? { responseMimeType: params.responseMimeType } : {}),
          ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {})
        }
      });

      const text =
        (response.text ?? "").trim() ||
        (response.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text ?? "");

      const candidate: any = response.candidates?.[0] ?? {};
      const gm = candidate.groundingMetadata ?? null;

      const sources =
        gm?.groundingChunks?.map((c: any) =>
          c?.web?.uri ? { uri: c.web.uri, title: c.web.title ?? "" } : null
        ).filter(Boolean) ?? [];

      const queries = gm?.webSearchQueries ?? [];

      return { text, sources, queries, raw: response };
    } catch (error) {
      const status =
        typeof (error as any)?.status === "number" ? (error as any).status
          : typeof (error as any)?.statusCode === "number" ? (error as any).statusCode
            : typeof (error as any)?.response?.status === "number" ? (error as any).response.status
              : undefined;

      if (status === 429) {
        const retryAfterHeader =
          (error as any)?.response?.headers?.get?.("retry-after") ??
          (error as any)?.headers?.get?.("retry-after") ??
          (error as any)?.retryAfter;
        const retryAfterSeconds = retryAfterHeader != null ? parseInt(String(retryAfterHeader), 10) : undefined;
        throw new RateLimitError(
          (error instanceof Error ? error.message : "Rate limit exceeded"),
          Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
        );
      }

      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      const code = String((error as any)?.code ?? "").toLowerCase();
      if (code.includes("timedout") || message.includes("timeout")) {
        throw new TimeoutError(
          (error instanceof Error ? error.message : "Request timed out"),
          timeout
        );
      }

      throw error;
    }
  }

  /**
   * Health check - makes a lightweight API call to verify connectivity.
   */
  async healthCheck(timeoutMs: number = 10000): Promise<boolean> {
    try {
      const result = await this.generateContent(
        {
          model: this.defaultModel,
          prompt: "ping",
          maxOutputTokens: 5,
          useSearch: false
        },
        timeoutMs
      );
      return result.text.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get current health metrics.
   */
  getMetrics(): HealthMetrics {
    return {
      healthy: !this.metrics.lastErrorTime || (Date.now() - this.metrics.lastErrorTime) > 60_000,
      uptime: Math.floor((Date.now() - this.metrics.startTime) / 1000),
      requestsTotal: this.metrics.requestsTotal,
      requestsPending: this.metrics.requestsPending,
      lastError: this.metrics.lastError?.message,
      lastErrorTime: this.metrics.lastErrorTime,
      rateLimitTokens: this.rateLimiter.getAvailableTokens()
    };
  }

  /**
   * Get estimated wait time for next request in milliseconds.
   */
  getEstimatedWaitTime(): number {
    return this.rateLimiter.calculateWaitTime(1);
  }

  /**
   * Record an error for metrics tracking.
   */
  private recordError(error: Error): void {
    this.metrics.errorsTotal++;
    this.metrics.lastError = error;
    this.metrics.lastErrorTime = Date.now();
  }
}

/**
 * System instruction for grounded web research.
 */
export function systemInstruction(): string {
  return [
    "You are a grounded web research assistant.",
    "Always use Google Search grounding; cite trustworthy primary sources.",
    "When the user is asking about an API/library/framework:",
    "- Prefer OFFICIAL documentation, standards, and vendor references.",
    "- State version numbers when available.",
    "- Provide minimal, correct examples (no pseudocode) only if helpful.",
    "When not about APIs, still provide concise, sourced answers.",
    "Return claims that require evidence with citations."
  ].join("\n");
}

/**
 * Create a configured Gemini client from environment variables.
 */
export function createGeminiClient(): GeminiClient {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY or GOOGLE_API_KEY environment variable");
  }

  const baseUrl =
    process.env.GENAI_BASE_URL ||
    process.env.GEMINI_BASE_URL ||
    undefined;

  const timeout = parseInt(process.env.REQUEST_TIMEOUT || "60000", 10);

  return new GeminiClient({
    apiKey,
    baseUrl,
    timeout,
    defaultModel: process.env.MODEL || "gemini-3-flash-preview",
    fallbackModel: "gemini-2.5-flash",
    rateLimiter: {
      requestsPerMinute: parseInt(process.env.RATE_LIMIT_RPM || "60", 10),
      maxBurst: parseInt(process.env.RATE_LIMIT_MAX_BURST || "10", 10)
    },
    retry: {
      maxRetries: parseInt(process.env.MAX_RETRIES || "5", 10),
      baseDelay: parseInt(process.env.BASE_RETRY_DELAY || "1000", 10),
      maxDelay: parseInt(process.env.MAX_RETRY_DELAY || "60000", 10),
      jitterFactor: parseFloat(process.env.JITTER_FACTOR || "0.1")
    }
  });
}
