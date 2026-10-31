import { NonRetryableError } from './non-retryable.error';

export interface RetryPolicyOptions {
  /** Total deliveries including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
}

export type RetryDecision =
  | { action: 'retry'; delayMs: number; nextAttempt: number }
  | { action: 'dead-letter'; reason: 'non-retryable' | 'max-attempts-exceeded' };

/**
 * Exponential backoff: the delay before attempt n+1 is base * 2^(n-1).
 * With base 1000ms and 4 attempts that is 1s, 2s, 4s, then the DLQ.
 */
export class RetryPolicy {
  readonly maxAttempts: number;
  /** delaysMs[i] is the wait after attempt i+1 fails. One retry queue exists per entry. */
  readonly delaysMs: readonly number[];

  constructor({ maxAttempts, baseDelayMs }: RetryPolicyOptions) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }
    if (baseDelayMs <= 0) {
      throw new Error('baseDelayMs must be positive');
    }
    this.maxAttempts = maxAttempts;
    this.delaysMs = Array.from({ length: maxAttempts - 1 }, (_, i) => baseDelayMs * 2 ** i);
  }

  decide(attempt: number, error: unknown): RetryDecision {
    if (error instanceof NonRetryableError) {
      return { action: 'dead-letter', reason: 'non-retryable' };
    }
    if (attempt >= this.maxAttempts) {
      return { action: 'dead-letter', reason: 'max-attempts-exceeded' };
    }
    const current = Math.max(attempt, 1);
    return { action: 'retry', delayMs: this.delaysMs[current - 1], nextAttempt: current + 1 };
  }
}
