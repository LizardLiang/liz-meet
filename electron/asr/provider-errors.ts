// electron/asr/provider-errors.ts
// Stable error codes for the ASR provider layer.
// NEVER expose raw error.message to the renderer or logs — use these codes.

/** Stable error codes the rest of the system reasons about. */
export type ProviderErrorCode =
  | 'auth_failed'        // 401, 403
  | 'rate_limited'       // 429
  | 'bad_request'        // 400
  | 'provider_5xx'       // 500–599
  | 'redirect_rejected'  // 3xx — never followed
  | 'timeout'            // AbortSignal.timeout fired
  | 'network'            // fetch throw (DNS, conn reset, etc.)
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly status: number | null,
    /** Sanitized short string suitable for logging. Never includes URLs or auth headers. */
    public readonly safeMessage: string,
  ) {
    super(`provider:${code}:${status ?? 'no-status'}`);
    this.name = 'ProviderError';
  }
}

/**
 * Extract a safe error description from a non-2xx response.
 * NEVER returns the raw body.
 * - Reads up to 512 bytes of the response body.
 * - Strips URL query strings (which can contain signed-URL tokens).
 * - Redacts token-like strings (≥16 alphanumeric chars).
 * - Truncates to 200 chars after stripping.
 */
export async function sanitizeProviderBody(res: Response): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const { value } = await reader.read();
    reader.cancel();
    if (!value) return '';
    const text = new TextDecoder().decode(value.subarray(0, 512));
    // Strip query strings
    const noQuery = text.replace(/(\?[^\s"',}]*)/g, '?<redacted>');
    // Redact token-like substrings
    const noTokens = noQuery.replace(/[A-Za-z0-9_-]{16,}/g, '<redacted>');
    return noTokens.slice(0, 200);
  } catch {
    return '';
  }
}

export function classifyStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 400) return 'bad_request';
  if (status === 429) return 'rate_limited';
  if (status >= 300 && status < 400) return 'redirect_rejected';
  if (status >= 500 && status < 600) return 'provider_5xx';
  return 'unknown';
}

export function classifyHttpError(err: unknown): ProviderErrorCode {
  if (err instanceof ProviderError) return err.code;
  if (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  ) {
    return 'timeout';
  }
  return 'network';
}
