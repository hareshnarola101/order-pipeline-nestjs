import { NonRetryableError } from './non-retryable.error';
import { RetryPolicy } from './retry-policy';

describe('RetryPolicy', () => {
  const policy = new RetryPolicy({ maxAttempts: 4, baseDelayMs: 1000 });
  const transient = new Error('gateway timeout');

  it('doubles the delay for each attempt', () => {
    expect(policy.delaysMs).toEqual([1000, 2000, 4000]);
  });

  it.each([
    [1, 1000, 2],
    [2, 2000, 3],
    [3, 4000, 4],
  ])('retries attempt %i after %ims as attempt %i', (attempt, delayMs, nextAttempt) => {
    expect(policy.decide(attempt, transient)).toEqual({ action: 'retry', delayMs, nextAttempt });
  });

  it('dead-letters once the last attempt fails', () => {
    expect(policy.decide(4, transient)).toEqual({
      action: 'dead-letter',
      reason: 'max-attempts-exceeded',
    });
  });

  it('dead-letters non-retryable errors immediately', () => {
    expect(policy.decide(1, new NonRetryableError('bad message'))).toEqual({
      action: 'dead-letter',
      reason: 'non-retryable',
    });
  });

  it('treats a missing or invalid attempt count as the first attempt', () => {
    expect(policy.decide(0, transient)).toEqual({ action: 'retry', delayMs: 1000, nextAttempt: 2 });
  });

  it('never retries when maxAttempts is 1', () => {
    const noRetries = new RetryPolicy({ maxAttempts: 1, baseDelayMs: 1000 });
    expect(noRetries.delaysMs).toEqual([]);
    expect(noRetries.decide(1, transient).action).toBe('dead-letter');
  });

  it('rejects invalid configuration', () => {
    expect(() => new RetryPolicy({ maxAttempts: 0, baseDelayMs: 1000 })).toThrow();
    expect(() => new RetryPolicy({ maxAttempts: 3, baseDelayMs: 0 })).toThrow();
  });
});
