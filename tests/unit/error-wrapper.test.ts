// tests/unit/error-wrapper.test.ts
// Suite U6: IPC error classification (UNIT-086–092)

import { describe, it, expect, vi } from 'vitest';
import { withErrorWrapper } from '../../electron/ipc/error-wrapper.js';
import { ProviderError } from '../../electron/asr/provider-errors.js';
import { sanitizeForLog } from '../../electron/logging/logger.js';
import { ZodError } from 'zod';

// Mock logger to suppress output in tests
vi.mock('../../electron/logging/logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../electron/logging/logger.js')>();
  return {
    ...orig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

describe('withErrorWrapper', () => {
  it('UNIT-086: ProviderError(auth_failed) → provider_auth_failed', async () => {
    const handler = withErrorWrapper('test', async () => {
      throw new ProviderError('auth_failed', 401, '');
    });
    const result = await handler();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider_auth_failed');
      expect(result.error.message).toContain('AssemblyAI');
    }
  });

  it('UNIT-087: ProviderError(rate_limited) → provider_rate_limited', async () => {
    const handler = withErrorWrapper('test', async () => {
      throw new ProviderError('rate_limited', 429, '');
    });
    const result = await handler();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('provider_rate_limited');
  });

  it('UNIT-088: ZodError → invalid_argument', async () => {
    const handler = withErrorWrapper('test', async () => {
      throw new ZodError([]);
    });
    const result = await handler();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_argument');
  });

  it('UNIT-090: unknown error → internal_error with logId', async () => {
    const handler = withErrorWrapper('test', async () => {
      throw new Error('something unexpected');
    });
    const result = await handler();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal_error');
      expect(result.error.logId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('UNIT-091: renderer never receives raw error.message from main', async () => {
    const rawMessage = 'raw internal error with secret path /home/user/.ssh/id_rsa';
    const handler = withErrorWrapper('test', async () => {
      throw new Error(rawMessage);
    });
    const result = await handler();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(rawMessage);
      expect(result.error.message).not.toContain('secret');
    }
  });

  it('returns ok:true with data on success', async () => {
    const handler = withErrorWrapper('test', async () => 42);
    const result = await handler();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(42);
  });
});

describe('sanitizeForLog', () => {
  it('UNIT-092: redacts authorization field', () => {
    const result = sanitizeForLog({ authorization: 'secret-key', data: 'ok' }) as Record<string, unknown>;
    expect(result['authorization']).toBe('<redacted>');
    expect(result['data']).toBe('ok');
  });

  it('UNIT-092: redacts apiKey field', () => {
    const result = sanitizeForLog({ apiKey: 'abc123', msg: 'hello' }) as Record<string, unknown>;
    expect(result['apiKey']).toBe('<redacted>');
    expect(result['msg']).toBe('hello');
  });

  it('redacts token field', () => {
    const result = sanitizeForLog({ token: 'mytoken' }) as Record<string, unknown>;
    expect(result['token']).toBe('<redacted>');
  });

  it('truncates strings over 256 chars', () => {
    const long = 'a'.repeat(300);
    const result = sanitizeForLog(long) as string;
    expect(result.length).toBeLessThanOrEqual(256);
  });

  it('redacts URL query strings', () => {
    const result = sanitizeForLog('https://api.assemblyai.com/v2/upload?signed=abc123') as string;
    expect(result).not.toContain('signed=abc123');
    expect(result).toContain('?<redacted>');
  });
});
