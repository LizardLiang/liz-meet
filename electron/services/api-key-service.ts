// electron/services/api-key-service.ts
// API key storage via Electron safeStorage.
// The API key NEVER crosses IPC to the renderer in plaintext.

import { safeStorage, app } from 'electron';
import { existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

const CREDENTIALS_DIR = () => path.join(app.getPath('userData'), 'credentials');
const KEY_FILE = () => path.join(CREDENTIALS_DIR(), 'api-key.bin');

class ApiKeyService {
  private ensureDir(): void {
    const dir = CREDENTIALS_DIR();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Store the API key encrypted via safeStorage. */
  set(plainKey: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.error({ event: 'safestorage_unavailable' });
      throw new Error('safeStorage encryption is not available on this system');
    }
    this.ensureDir();
    const encrypted = safeStorage.encryptString(plainKey);
    writeFileSync(KEY_FILE(), encrypted);
    // Best-effort: set restrictive permissions
    try {
      chmodSync(KEY_FILE(), 0o600);
    } catch {
      // Windows NTFS does not support Unix chmod; safeStorage is the guarantee
    }
  }

  /** Return true if a stored API key exists. */
  exists(): boolean {
    return existsSync(KEY_FILE());
  }

  /**
   * Retrieve the API key in plaintext.
   * MUST only be used in main process. NEVER pass the result to the renderer.
   */
  get(): string {
    if (!this.exists()) throw new Error('No API key stored');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is not available');
    }
    const encrypted = readFileSync(KEY_FILE());
    return safeStorage.decryptString(encrypted);
  }

  /** Remove the stored API key. */
  delete(): void {
    if (existsSync(KEY_FILE())) {
      try {
        unlinkSync(KEY_FILE());
      } catch {
        logger.warn({ event: 'apikey_delete_failed' });
      }
    }
  }
}

export const apiKeyService = new ApiKeyService();
