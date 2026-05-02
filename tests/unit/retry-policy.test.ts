// tests/unit/retry-policy.test.ts
// Suite U4: Retry Policy (UNIT-033–037b)

import { describe, it, expect } from 'vitest';
import { delayFor, shouldRetry, MAX_ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS } from '../../electron/asr/retry-policy.js';

describe('RetryPolicy', () => {
  it('UNIT-033: attempt 0 delay is BASE_DELAY_MS (2000ms)', () => {
    expect(delayFor(0)).toBe(BASE_DELAY_MS);
    expect(delayFor(0)).toBe(2000);
  });

  it('UNIT-034: delay is capped at MAX_DELAY_MS (60000ms)', () => {
    expect(delayFor(10)).toBe(MAX_DELAY_MS);
    expect(delayFor(10)).toBe(60_000);
  });

  it('UNIT-035: 401 is not retriable at any attempt', () => {
    expect(shouldRetry(401, 0)).toBe(false);
    expect(shouldRetry(401, 4)).toBe(false);
  });

  it('UNIT-035: 403 is not retriable at any attempt', () => {
    expect(shouldRetry(403, 0)).toBe(false);
  });

  it('UNIT-036: 400 (bad request) is not retriable', () => {
    expect(shouldRetry(400, 0)).toBe(false);
  });

  it('UNIT-037: 429 is retriable until attempt MAX_ATTEMPTS-1', () => {
    expect(shouldRetry(429, 4)).toBe(true);
    expect(shouldRetry(429, MAX_ATTEMPTS)).toBe(false);
  });

  it('UNIT-037: 5xx is retriable until attempt MAX_ATTEMPTS-1', () => {
    expect(shouldRetry(500, 4)).toBe(true);
    expect(shouldRetry(500, MAX_ATTEMPTS)).toBe(false);
  });

  it('UNIT-037b: attempt >= MAX_ATTEMPTS is never retriable', () => {
    expect(shouldRetry(200, 5)).toBe(false);
    expect(shouldRetry(200, 10)).toBe(false);
  });

  it('delays grow exponentially: attempt 1 is BASE*2', () => {
    expect(delayFor(1)).toBe(BASE_DELAY_MS * 2);
  });

  it('delays grow exponentially: attempt 2 is BASE*4', () => {
    expect(delayFor(2)).toBe(BASE_DELAY_MS * 4);
  });
});
