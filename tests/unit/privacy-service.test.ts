// tests/unit/privacy-service.test.ts
// §5.3.1: Privacy notice acknowledgement tests

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
}));

import { PrivacyService, hashNoticeText } from '../../electron/services/privacy-service.js';

// In-memory stub for SettingsRepository
function makeSettingsStub() {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn(<T>(key: string): T => {
      if (key in store) return store[key] as T;
      return null as T;
    }),
    set: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
    _store: store,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PrivacyService', () => {
  it('isAcknowledged() returns false when no ack stored', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    expect(svc.isAcknowledged('some-hash')).toBe(false);
  });

  it('acknowledge() stores noticeHash, timestamp, appVersion', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    svc.acknowledge('abc123');

    expect(settings.set).toHaveBeenCalledWith(
      'privacy_acknowledgement',
      expect.objectContaining({
        noticeHash: 'abc123',
        timestamp: expect.any(String),
        appVersion: '1.0.0',
      }),
    );
  });

  it('isAcknowledged() returns true after acknowledge() with matching hash', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    // Simulate stored ack
    settings.get.mockReturnValue({
      noticeHash: 'abc123',
      timestamp: new Date().toISOString(),
      appVersion: '1.0.0',
    });

    expect(svc.isAcknowledged('abc123')).toBe(true);
  });

  it('isAcknowledged() returns false when hash mismatches (notice updated)', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    settings.get.mockReturnValue({
      noticeHash: 'old-hash',
      timestamp: new Date().toISOString(),
      appVersion: '1.0.0',
    });

    expect(svc.isAcknowledged('new-hash')).toBe(false);
  });

  it('revoke() sets ack to null', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    svc.revoke();

    expect(settings.set).toHaveBeenCalledWith('privacy_acknowledgement', null);
  });

  it('getStoredAck() returns null when nothing stored', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    expect(svc.getStoredAck()).toBeNull();
  });

  it('getStoredAck() returns the stored record', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    const ack = { noticeHash: 'xyz', timestamp: '2026-01-01T00:00:00Z', appVersion: '1.0.0' };
    settings.get.mockReturnValue(ack);

    expect(svc.getStoredAck()).toEqual(ack);
  });

  it('isAcknowledged() returns false when getStoredAck throws', () => {
    const settings = makeSettingsStub();
    settings.get.mockImplementation(() => { throw new Error('DB error'); });
    const svc = new PrivacyService(settings as never);

    expect(svc.isAcknowledged('some-hash')).toBe(false);
  });

  it('acknowledge() stored record includes all 3 required fields (SEC-006)', () => {
    const settings = makeSettingsStub();
    const svc = new PrivacyService(settings as never);

    svc.acknowledge('test-hash');

    const [, storedValue] = settings.set.mock.calls[0] as [string, Record<string, unknown>];
    expect(storedValue).toHaveProperty('noticeHash');
    expect(storedValue).toHaveProperty('timestamp');
    expect(storedValue).toHaveProperty('appVersion');
  });
});

describe('hashNoticeText', () => {
  it('returns a 64-character hex SHA-256 string', () => {
    const hash = hashNoticeText('some privacy notice text');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same text always returns same hash (deterministic)', () => {
    const text = 'AssemblyAI privacy notice v1';
    expect(hashNoticeText(text)).toBe(hashNoticeText(text));
  });

  it('different text returns different hash', () => {
    expect(hashNoticeText('text A')).not.toBe(hashNoticeText('text B'));
  });
});
