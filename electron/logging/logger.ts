// electron/logging/logger.ts
// Structured, rotating file logger. NEVER accepts variadic/positional arguments.
// API keys, audio bytes, and transcript text must never appear in logs.

import { app } from 'electron';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { WriteStream } from 'node:fs';

type Severity = 'info' | 'warn' | 'error';

interface LogEntry {
  level: Severity;
  ts: string;
  [key: string]: unknown;
}

const SECRET_KEY_PATTERN =
  /^(authorization|api[-_]?key|token|secret|password|cookie)$/i;

/**
 * Recursively sanitize a structured log payload:
 * - keys matching the secret-key pattern → value replaced with '<redacted>'
 * - string values > 256 chars → truncated
 * - URL with query strings → query string replaced with '?<redacted>'
 */
export function sanitizeForLog(obj: unknown): unknown {
  if (typeof obj === 'string') {
    const truncated = obj.length > 256 ? `${obj.slice(0, 253)}...` : obj;
    // Replace query strings in URLs
    return truncated.replace(/(\?[^\s"',}]*)/g, '?<redacted>');
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLog);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        result[k] = '<redacted>';
      } else {
        result[k] = sanitizeForLog(v);
      }
    }
    return result;
  }
  return obj;
}

class Logger {
  private stream: WriteStream | null = null;
  private currentDate = '';

  private getStream(): WriteStream {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (today !== this.currentDate || !this.stream) {
      this.stream?.end();
      const logDir = path.join(app.getPath('userData'), 'logs');
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `liz-transcribe-${today}.log`);
      this.stream = createWriteStream(logPath, { flags: 'a', encoding: 'utf-8' });
      this.currentDate = today;
    }
    return this.stream!;
  }

  private write(level: Severity, fields: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      ts: new Date().toISOString(),
      ...sanitizeForLog(fields) as Record<string, unknown>,
    };
    try {
      this.getStream().write(JSON.stringify(entry) + '\n');
    } catch {
      // Swallow logger errors — never crash the app on logging failure
    }
  }

  info(fields: Record<string, unknown>): void {
    this.write('info', fields);
  }

  warn(fields: Record<string, unknown>): void {
    this.write('warn', fields);
  }

  error(fields: Record<string, unknown>): void {
    this.write('error', fields);
  }
}

export const logger = new Logger();
