/**
 * Token bucket rate limiter for API request throttling.
 *
 * Tokens are added at a constant rate (requestsPerMinute / 60 seconds).
 * The bucket has a maximum capacity (maxBurst) to allow temporary spikes.
 *
 * This provides smooth rate limiting while allowing bursts up to maxBurst.
 */

import type { RateLimiterConfig } from "../types/config.js";

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per millisecond
  private state: TokenBucketState;

  constructor(config: RateLimiterConfig) {
    this.capacity = config.maxBurst;
    // Convert requests per minute to tokens per millisecond
    this.refillRate = config.requestsPerMinute / 60000;
    this.state = {
      tokens: config.maxBurst,
      lastRefill: Date.now()
    };
  }

  /**
   * Get current number of available tokens without consuming them.
   */
  getAvailableTokens(): number {
    this.refill();
    return this.state.tokens;
  }

  /**
   * Calculate estimated wait time in milliseconds for a given number of tokens.
   * Returns 0 if tokens are immediately available.
   */
  calculateWaitTime(tokensNeeded: number = 1): number {
    this.refill();
    if (this.state.tokens >= tokensNeeded) {
      return 0;
    }
    const tokensShort = tokensNeeded - this.state.tokens;
    return Math.ceil(tokensShort / this.refillRate);
  }

  /**
   * Acquire the specified number of tokens.
   * Returns a promise that resolves when tokens are available.
   * If tokens are available immediately, resolves without delay.
   * Otherwise, waits until enough tokens have been added.
   */
  async acquire(tokens: number = 1): Promise<void> {
    while (true) {
      const waitTime = this.calculateWaitTime(tokens);
      if (waitTime === 0) {
        this.state.tokens -= tokens;
        return;
      }
      await sleep(waitTime);
    }
  }

  /**
   * Refill tokens based on elapsed time since last refill.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastRefill;
    if (elapsed <= 0) return;

    const tokensToAdd = elapsed * this.refillRate;
    this.state.tokens = Math.min(this.capacity, this.state.tokens + tokensToAdd);
    this.state.lastRefill = now;
  }

  /**
   * Reset the bucket to full capacity (useful for testing).
   */
  reset(): void {
    this.state = {
      tokens: this.capacity,
      lastRefill: Date.now()
    };
  }
}

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a rate limiter from environment variables with sensible defaults.
 */
export function createRateLimiter(): TokenBucket {
  const rpm = parseInt(process.env.RATE_LIMIT_RPM || "60", 10);
  const maxBurst = parseInt(process.env.RATE_LIMIT_MAX_BURST || "10", 10);

  return new TokenBucket({
    requestsPerMinute: Math.max(1, rpm),
    maxBurst: Math.max(1, maxBurst)
  });
}
