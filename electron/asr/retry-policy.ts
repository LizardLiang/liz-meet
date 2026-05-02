// electron/asr/retry-policy.ts
// Exponential backoff retry policy for chunk uploads.

export const MAX_ATTEMPTS = 5;
export const BASE_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 60_000;

/**
 * Returns true if the given HTTP status + attempt count should be retried.
 * 401/403 (auth failures) and 400 (bad request) are not retriable.
 */
export function shouldRetry(status: number, attempt: number): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  if (status === 401 || status === 403) return false;
  if (status === 400) return false;
  return true;
}

/**
 * Returns the delay in ms for the given attempt number (0-indexed).
 * Uses exponential backoff: BASE_DELAY * 2^attempt, capped at MAX_DELAY.
 */
export function delayFor(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

/**
 * Wait for the delay appropriate for the given attempt.
 */
export function waitForRetry(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayFor(attempt)));
}
