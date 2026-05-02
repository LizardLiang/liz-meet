// electron/ipc/error-wrapper.ts
// IPC error classification contract per §4.9.1.
// The renderer NEVER receives raw error.message — only stable codes.

import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ProviderError } from '../asr/provider-errors.js';
import { logger, sanitizeForLog } from '../logging/logger.js';

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; logId?: string } };

type Severity = 'warn' | 'error';

interface ErrorClassification {
  code: string;
  message: string;
  severity: Severity;
}

function isSqliteError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.constructor.name === 'SqliteError' || 'code' in err)
  );
}

function isCaptureError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('naudiodon') ||
      err.message.includes('loopback') ||
      err.message.includes('capture'))
  );
}

function isSafeStorageError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('safeStorage');
}

function classifyError(err: unknown): ErrorClassification {
  if (err instanceof ProviderError) {
    switch (err.code) {
      case 'auth_failed':
        return {
          code: 'provider_auth_failed',
          message: 'AssemblyAI rejected the API key. Re-enter in Settings.',
          severity: 'warn',
        };
      case 'rate_limited':
        return {
          code: 'provider_rate_limited',
          message: 'AssemblyAI rate limit reached. Try again shortly.',
          severity: 'warn',
        };
      case 'provider_5xx':
        return {
          code: 'provider_unavailable',
          message: 'AssemblyAI is temporarily unavailable.',
          severity: 'warn',
        };
      case 'timeout':
        return {
          code: 'provider_timeout',
          message: 'Request to AssemblyAI timed out.',
          severity: 'warn',
        };
      case 'network':
        return {
          code: 'network_error',
          message: 'Network error contacting AssemblyAI.',
          severity: 'warn',
        };
      case 'redirect_rejected':
        return {
          code: 'provider_unexpected',
          message: 'AssemblyAI returned an unexpected redirect.',
          severity: 'error',
        };
      case 'bad_request':
        return {
          code: 'provider_bad_request',
          message: 'AssemblyAI rejected the request.',
          severity: 'error',
        };
      default:
        return {
          code: 'provider_unexpected',
          message: 'AssemblyAI request failed.',
          severity: 'error',
        };
    }
  }

  if (err instanceof ZodError) {
    return { code: 'invalid_argument', message: 'Invalid request payload.', severity: 'warn' };
  }

  if (isSqliteError(err)) {
    return { code: 'internal_error', message: 'Internal database error.', severity: 'error' };
  }

  if (isCaptureError(err)) {
    return { code: 'capture_failed', message: 'Audio capture failed.', severity: 'error' };
  }

  if (isSafeStorageError(err)) {
    return {
      code: 'apikey_unreadable',
      message: 'Stored API key cannot be read. Please re-enter.',
      severity: 'error',
    };
  }

  return {
    code: 'internal_error',
    message: 'An unexpected error occurred.',
    severity: 'error',
  };
}

/** Pull a small, hand-picked set of fields from an unknown error for logging. */
function extractSafeFields(err: unknown): Record<string, unknown> {
  if (err instanceof ProviderError) {
    return { kind: 'provider', code: err.code, status: err.status, safeMessage: err.safeMessage };
  }
  if (err instanceof Error) {
    return { kind: 'generic', name: err.name }; // .message intentionally omitted
  }
  return { kind: 'unknown' };
}

/**
 * Wraps an IPC handler function with error classification.
 * Every error is mapped to a stable code; the renderer never sees raw error.message.
 *
 * Usage:
 *   ipcMain.handle(CHANNELS.SESSION_LIST, withErrorWrapper('session:list', async (_, args) => {
 *     return sessionRepo.findAll(args);
 *   }));
 */
export function withErrorWrapper<Args extends unknown[], R>(
  channel: string,
  handler: (...args: Args) => Promise<R> | R,
): (...args: Args) => Promise<IpcResult<R>> {
  return async (...args: Args): Promise<IpcResult<R>> => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      const { code, message, severity } = classifyError(err);
      const logId = randomUUID();
      logger[severity]({
        event: 'ipc_handler_error',
        channel,
        code,
        logId,
        details: sanitizeForLog(extractSafeFields(err)),
      });
      return { ok: false, error: { code, message, logId } };
    }
  };
}
