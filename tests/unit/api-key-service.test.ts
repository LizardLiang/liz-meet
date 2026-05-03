// tests/unit/api-key-service.test.ts
// Suite U13: API Key / safeStorage (UNIT-056, UNIT-057)

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((key: string) => Buffer.from(`encrypted:${key}`)),
    decryptString: vi.fn((buf: Buffer) => buf.toString().replace('encrypted:', '')),
  },
  app: {
    getPath: () => '/tmp/test-userData',
  },
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../../electron/logging/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { apiKeyService } from '../../electron/services/api-key-service.js';
import * as electron from 'electron';
import * as fs from 'node:fs';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(true);
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(electron.safeStorage.encryptString).mockImplementation(
    (key: string) => Buffer.from(`encrypted:${key}`)
  );
  vi.mocked(electron.safeStorage.decryptString).mockImplementation(
    (buf: Buffer) => buf.toString().replace('encrypted:', '')
  );
});

describe('ApiKeyService — UNIT-056, UNIT-057', () => {
  it('UNIT-056: set() calls safeStorage.encryptString before writing', () => {
    apiKeyService.set('test-api-key-12345');

    expect(electron.safeStorage.encryptString).toHaveBeenCalledWith('test-api-key-12345');
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('UNIT-056: encrypted bytes are written to file, not plaintext key', () => {
    const plainKey = 'my-secret-api-key';
    vi.mocked(electron.safeStorage.encryptString).mockReturnValue(Buffer.from('ENCRYPTED_BYTES'));

    apiKeyService.set(plainKey);

    const [, writtenData] = vi.mocked(fs.writeFileSync).mock.calls[0] as [string, Buffer];
    const writtenStr = writtenData.toString();
    expect(writtenStr).toBe('ENCRYPTED_BYTES');
    expect(writtenStr).not.toBe(plainKey);
  });

  it('UNIT-057: exists() returns true when file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(apiKeyService.exists()).toBe(true);
  });

  it('UNIT-057: exists() returns false when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(apiKeyService.exists()).toBe(false);
  });

  it('UNIT-057: get() decrypts via safeStorage.decryptString', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const encryptedBuf = Buffer.from('encrypted:real-api-key');
    vi.mocked(fs.readFileSync).mockReturnValue(encryptedBuf as never);
    vi.mocked(electron.safeStorage.decryptString).mockReturnValue('real-api-key');

    const result = apiKeyService.get();

    expect(electron.safeStorage.decryptString).toHaveBeenCalledWith(encryptedBuf);
    expect(result).toBe('real-api-key');
  });

  it('UNIT-057: get() without stored key throws', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => apiKeyService.get()).toThrow();
  });

  it('set() throws when safeStorage is unavailable', () => {
    vi.mocked(electron.safeStorage.isEncryptionAvailable).mockReturnValue(false);
    expect(() => apiKeyService.set('some-key')).toThrow('safeStorage encryption is not available');
    expect(electron.safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('delete() removes the key file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    apiKeyService.delete();

    expect(fs.unlinkSync).toHaveBeenCalled();
  });

  it('delete() is a no-op when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    apiKeyService.delete();

    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
