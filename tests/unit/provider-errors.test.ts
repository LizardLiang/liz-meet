// tests/unit/provider-errors.test.ts
// Suite U5: AssemblyAI Client Security Contracts (UNIT-076–085)

import { describe, it, expect } from 'vitest';
import {
  classifyStatus,
  classifyHttpError,
  sanitizeProviderBody,
  ProviderError,
} from '../../electron/asr/provider-errors.js';

describe('classifyStatus', () => {
  it('UNIT-081: 401 → auth_failed', () => {
    expect(classifyStatus(401)).toBe('auth_failed');
  });
  it('UNIT-081: 403 → auth_failed', () => {
    expect(classifyStatus(403)).toBe('auth_failed');
  });
  it('UNIT-081: 429 → rate_limited', () => {
    expect(classifyStatus(429)).toBe('rate_limited');
  });
  it('UNIT-081: 500 → provider_5xx', () => {
    expect(classifyStatus(500)).toBe('provider_5xx');
  });
  it('UNIT-081: 400 → bad_request', () => {
    expect(classifyStatus(400)).toBe('bad_request');
  });
  it('301 → redirect_rejected', () => {
    expect(classifyStatus(301)).toBe('redirect_rejected');
  });
});

describe('classifyHttpError', () => {
  it('UNIT-082: AbortError → timeout', () => {
    const err = new Error('abort');
    err.name = 'AbortError';
    expect(classifyHttpError(err)).toBe('timeout');
  });

  it('UNIT-082: TimeoutError → timeout', () => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    expect(classifyHttpError(err)).toBe('timeout');
  });

  it('UNIT-082: unknown error → network', () => {
    expect(classifyHttpError(new Error('ECONNREFUSED'))).toBe('network');
  });

  it('ProviderError returns its own code', () => {
    const err = new ProviderError('rate_limited', 429, '');
    expect(classifyHttpError(err)).toBe('rate_limited');
  });
});

describe('sanitizeProviderBody', () => {
  it('UNIT-078: strips query strings from error body', async () => {
    const body = 'error at https://api.assemblyai.com/v2/upload?token=secret123abc';
    const encoder = new TextEncoder();
    const uint8 = encoder.encode(body);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(uint8);
        controller.close();
      },
    });
    const res = new Response(stream);
    const result = await sanitizeProviderBody(res);
    expect(result).not.toContain('token=secret123abc');
    expect(result).toContain('?<redacted>');
  });

  it('UNIT-079: redacts token-like strings (≥16 alphanumeric)', async () => {
    const body = 'key: abcdefghijklmnop';
    const res = new Response(body);
    const result = await sanitizeProviderBody(res);
    expect(result).toContain('<redacted>');
    expect(result).not.toContain('abcdefghijklmnop');
  });

  it('UNIT-080: truncates to 200 chars after stripping', async () => {
    const body = 'x'.repeat(300);
    const res = new Response(body);
    const result = await sanitizeProviderBody(res);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('returns empty string for null body', async () => {
    const res = new Response(null);
    const result = await sanitizeProviderBody(res);
    expect(result).toBe('');
  });
});

describe('ProviderError', () => {
  it('has correct name and code', () => {
    const err = new ProviderError('auth_failed', 401, 'test');
    expect(err.name).toBe('ProviderError');
    expect(err.code).toBe('auth_failed');
    expect(err.status).toBe(401);
    expect(err.safeMessage).toBe('test');
  });
});
