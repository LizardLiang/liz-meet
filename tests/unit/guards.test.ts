// tests/unit/guards.test.ts
// Suite U11: React Router Guards (UNIT-101–104)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock window.ipcRenderer for renderer-side code
const mockInvoke = vi.fn();
vi.stubGlobal('window', {
  ipcRenderer: {
    invoke: mockInvoke,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
  },
});

vi.mock('react-router-dom', () => ({
  redirect: vi.fn((path: string) => ({ type: 'redirect', location: path })),
}));

import { rootGuard, privacyAckGuard, setupCompleteGuard } from '../../src/routes/guards.js';
import * as reactRouterDom from 'react-router-dom';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reactRouterDom.redirect).mockImplementation(
    (path: string) => ({ type: 'redirect', location: path }) as never,
  );
});

function makeRequest(url: string) {
  return { request: new Request(url) };
}

describe('rootGuard', () => {
  it('UNIT-101: no privacy ack → redirects to /first-run/privacy', async () => {
    mockInvoke.mockResolvedValue({ ok: true, data: { acknowledged: false, content: 'notice' } });

    const result = await rootGuard(makeRequest('http://localhost/library'));

    expect(reactRouterDom.redirect).toHaveBeenCalledWith('/first-run/privacy');
    expect(result).toEqual({ type: 'redirect', location: '/first-run/privacy' });
  });

  it('privacy ack present but no API key → redirects to /first-run/api-key', async () => {
    mockInvoke
      .mockResolvedValueOnce({ ok: true, data: { acknowledged: true, content: 'notice' } })
      .mockResolvedValueOnce({ ok: true, data: false });

    const result = await rootGuard(makeRequest('http://localhost/library'));

    expect(reactRouterDom.redirect).toHaveBeenCalledWith('/first-run/api-key');
    expect(result).toEqual({ type: 'redirect', location: '/first-run/api-key' });
  });

  it('UNIT-104 (root): both ack + key present → returns null', async () => {
    mockInvoke
      .mockResolvedValueOnce({ ok: true, data: { acknowledged: true, content: 'notice' } })
      .mockResolvedValueOnce({ ok: true, data: true });

    const result = await rootGuard(makeRequest('http://localhost/library'));

    expect(result).toBeNull();
  });

  it('/first-run/* routes are unconditionally allowed', async () => {
    const result = await rootGuard(makeRequest('http://localhost/first-run/privacy'));

    expect(result).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('privacyAckGuard', () => {
  it('UNIT-102: no ack → redirects to /first-run/privacy', async () => {
    mockInvoke.mockResolvedValue({ ok: true, data: { acknowledged: false, content: 'notice' } });

    const result = await privacyAckGuard();

    expect(reactRouterDom.redirect).toHaveBeenCalledWith('/first-run/privacy');
    expect(result).toEqual({ type: 'redirect', location: '/first-run/privacy' });
  });

  it('ack present → allows route (returns null)', async () => {
    mockInvoke.mockResolvedValue({ ok: true, data: { acknowledged: true, content: 'notice' } });

    const result = await privacyAckGuard();

    expect(result).toBeNull();
  });

  it('IPC error → redirects to privacy (safe default)', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC failure'));

    await privacyAckGuard();

    expect(reactRouterDom.redirect).toHaveBeenCalledWith('/first-run/privacy');
  });
});

describe('setupCompleteGuard', () => {
  it('UNIT-103: no API key → redirects to /first-run/api-key', async () => {
    mockInvoke
      .mockResolvedValueOnce({ ok: true, data: { acknowledged: true, content: 'notice' } })
      .mockResolvedValueOnce({ ok: true, data: false }); // no key

    const result = await setupCompleteGuard();

    expect(reactRouterDom.redirect).toHaveBeenCalledWith('/first-run/api-key');
    expect(result).toEqual({ type: 'redirect', location: '/first-run/api-key' });
  });

  it('UNIT-104: both ack + key present → returns null (allow)', async () => {
    mockInvoke
      .mockResolvedValueOnce({ ok: true, data: { acknowledged: true, content: 'notice' } })
      .mockResolvedValueOnce({ ok: true, data: true });

    const result = await setupCompleteGuard();

    expect(result).toBeNull();
  });

  it('no privacy ack → redirects to /first-run/privacy (checked first)', async () => {
    mockInvoke
      .mockResolvedValueOnce({ ok: true, data: { acknowledged: false, content: 'notice' } });

    const result = await setupCompleteGuard();

    expect(reactRouterDom.redirect).toHaveBeenCalledWith('/first-run/privacy');
    expect(result).toEqual({ type: 'redirect', location: '/first-run/privacy' });
  });
});
