// electron/ipc/handlers.ts
// ipcMain.handle registrations for all liz-transcribe channels.

import { ipcMain, dialog, app } from 'electron';
import type { BrowserWindow } from 'electron';
import { CHANNELS } from './channels.js';
import { withErrorWrapper } from './error-wrapper.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { ChunkRepository } from '../db/chunk-repository.js';
import type { SegmentRepository } from '../db/segment-repository.js';
import type { SpeakerLabelRepository } from '../db/speaker-label-repository.js';
import type { SettingsRepository } from '../db/settings-repository.js';
import type { SessionStateMachine } from '../capture/session-state.js';
import type { apiKeyService as ApiKeyServiceType } from '../services/api-key-service.js';
import type { PrivacyService } from '../services/privacy-service.js';
import { runPreflight } from '../capture/preflight.js';
import { NOTICE_VERSION_HASH, NOTICE_TEXT } from '../../src/constants/privacy-notice.js';
import { notify } from './notifier.js';
import { PUSH_CHANNELS as PC } from './channels.js';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

interface HandlerDeps {
  win: BrowserWindow;
  sessionRepo: SessionRepository;
  chunkRepo: ChunkRepository;
  segmentRepo: SegmentRepository;
  speakerLabelRepo: SpeakerLabelRepository;
  settingsRepo: SettingsRepository;
  stateMachine: SessionStateMachine;
  apiKeyService: typeof ApiKeyServiceType;
  privacyService: PrivacyService;
}

// Sanitize filenames for dialog defaultPath (SUGGESTION: strip reserved names and ..)
function sanitizeFileName(name: string): string {
  const stripped = name.replace(/[/\\?%*:|"<>]/g, '-').replace(/^\.+/, '').slice(0, 60);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stripped)) return `session-${stripped}`;
  return stripped || 'session';
}

// --- settings:set allowlist (H-02) ---
// Maps each permitted settings key to a validator function.
// Returning a non-null string means invalid; null means valid.
type SettingsValidator = (v: unknown) => string | null;

const SETTINGS_ALLOWLIST: Record<string, SettingsValidator> = {
  chunk_seconds: (v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 5 || v > 120) {
      return 'chunk_seconds must be an integer in [5, 120]';
    }
    return null;
  },
  mic_device_id: (v) => {
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v))) {
      return 'mic_device_id must be an integer or null';
    }
    return null;
  },
  provider: (v) => {
    if (v !== 'assemblyai' && v !== 'deepgram' && v !== 'nvidia') {
      return "provider must be 'assemblyai', 'deepgram', or 'nvidia'";
    }
    return null;
  },
  keep_raw_audio: (v) => {
    if (typeof v !== 'boolean') return 'keep_raw_audio must be a boolean';
    return null;
  },
  telemetry_opt_in: (v) => {
    if (typeof v !== 'boolean') return 'telemetry_opt_in must be a boolean';
    return null;
  },
};

function validateSettingsKeyValue(key: string, value: unknown): { ok: true } | { ok: false; message: string } {
  const validator = SETTINGS_ALLOWLIST[key];
  if (!validator) {
    return { ok: false, message: `Unknown settings key: '${key}'` };
  }
  const err = validator(value);
  if (err) return { ok: false, message: err };
  return { ok: true };
}

function renderText(segments: ReturnType<SegmentRepository['findBySessionId']>, overrides: Map<string, string>): string {
  return segments
    .map(s => {
      const label = overrides.get(s.speakerLabel) ?? s.speakerLabel;
      const ts = `[${formatTime(s.startSeconds)}]`;
      return `${ts} ${label}: ${s.text}`;
    })
    .join('\n');
}

function renderMarkdown(segments: ReturnType<SegmentRepository['findBySessionId']>, overrides: Map<string, string>): string {
  return segments
    .map(s => {
      const label = overrides.get(s.speakerLabel) ?? s.speakerLabel;
      return `**[${formatTime(s.startSeconds)}] ${label}:** ${s.text}`;
    })
    .join('\n\n');
}

function renderJson(segments: ReturnType<SegmentRepository['findBySessionId']>, overrides: Map<string, string>): string {
  const data = segments.map(s => ({
    start: s.startSeconds,
    end: s.endSeconds,
    speaker: overrides.get(s.speakerLabel) ?? s.speakerLabel,
    text: s.text,
  }));
  return JSON.stringify(data, null, 2);
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function registerHandlers(deps: HandlerDeps): void {
  const {
    sessionRepo,
    chunkRepo,
    segmentRepo,
    speakerLabelRepo,
    settingsRepo,
    stateMachine,
    apiKeyService,
    privacyService,
  } = deps;

  // ---- Session ----
  ipcMain.handle(
    CHANNELS.SESSION_LIST,
    withErrorWrapper(CHANNELS.SESSION_LIST, (_event, args: Parameters<SessionRepository['findAll']>[0]) =>
      sessionRepo.findAll(args ?? {}),
    ),
  );

  ipcMain.handle(
    CHANNELS.SESSION_GET,
    withErrorWrapper(CHANNELS.SESSION_GET, (_event, { id }: { id: string }) =>
      sessionRepo.findById(id),
    ),
  );

  ipcMain.handle(
    CHANNELS.SESSION_UPDATE,
    withErrorWrapper(CHANNELS.SESSION_UPDATE, (_event, args: { id: string; title?: string; notes?: string }) =>
      sessionRepo.updateMeta(args.id, { title: args.title, notes: args.notes }),
    ),
  );

  ipcMain.handle(
    CHANNELS.SESSION_DELETE,
    withErrorWrapper(CHANNELS.SESSION_DELETE, (_event, { id }: { id: string }) => {
      const session = sessionRepo.findById(id);
      if (session?.rawAudioPath) {
        const recordingsDir = path.join(app.getPath('userData'), 'recordings', id);
        if (existsSync(recordingsDir)) {
          try {
            rmSync(recordingsDir, { recursive: true });
          } catch {
            logger.warn({ event: 'audio_delete_failed_on_session_delete', sessionId: id });
          }
        }
      }
      const deleted = sessionRepo.delete(id);
      return { deleted };
    }),
  );

  // ---- Capture ----
  ipcMain.handle(
    CHANNELS.CAPTURE_PREFLIGHT,
    withErrorWrapper(CHANNELS.CAPTURE_PREFLIGHT, () => runPreflight()),
  );

  ipcMain.handle(
    CHANNELS.CAPTURE_START,
    withErrorWrapper(CHANNELS.CAPTURE_START, (_event, args: { title: string; source: 'mic' | 'system' | 'both' }) =>
      stateMachine.start(args),
    ),
  );

  ipcMain.handle(
    CHANNELS.CAPTURE_PAUSE,
    withErrorWrapper(CHANNELS.CAPTURE_PAUSE, () => {
      stateMachine.pause();
      return { ok: true };
    }),
  );

  ipcMain.handle(
    CHANNELS.CAPTURE_RESUME,
    withErrorWrapper(CHANNELS.CAPTURE_RESUME, () => {
      stateMachine.resume();
      return { ok: true };
    }),
  );

  ipcMain.handle(
    CHANNELS.CAPTURE_STOP,
    withErrorWrapper(CHANNELS.CAPTURE_STOP, () => {
      stateMachine.stop();
      return { ok: true };
    }),
  );

  ipcMain.handle(
    CHANNELS.CAPTURE_STATUS,
    withErrorWrapper(CHANNELS.CAPTURE_STATUS, () => ({
      state: stateMachine.getState(),
    })),
  );

  ipcMain.handle(
    CHANNELS.CAPTURE_LOOPBACK_CHUNK,
    withErrorWrapper(CHANNELS.CAPTURE_LOOPBACK_CHUNK, (_event, payload: {
      sessionId: string;
      seq: number;
      mimeType: string;
      buffer: ArrayBuffer;
      startSeconds: number;
      endSeconds: number;
    }) => {
      const result = stateMachine.getLoopbackRecorder().handleChunk(payload);
      if (!result.ok) {
        if (result.error?.code === 'chunk_too_large') {
          notify(deps.win, PC.CAPTURE_DEVICE_EVENT, {
            stream: 'system',
            event: 'chunk_oversize',
          });
        }
        return result;
      }
      return { ok: true };
    }),
  );

  // ---- Segments ----
  ipcMain.handle(
    CHANNELS.SEGMENT_FIND_BY_SESSION,
    withErrorWrapper(CHANNELS.SEGMENT_FIND_BY_SESSION, (_event, { sessionId }: { sessionId: string }) =>
      segmentRepo.findBySessionId(sessionId),
    ),
  );

  ipcMain.handle(
    CHANNELS.SEGMENT_SEARCH,
    withErrorWrapper(CHANNELS.SEGMENT_SEARCH, (_event, { query, limit }: { query: string; limit?: number }) =>
      segmentRepo.search(query, { limit }),
    ),
  );

  // ---- Speaker Labels ----
  ipcMain.handle(
    CHANNELS.SPEAKER_LABEL_UPSERT,
    withErrorWrapper(CHANNELS.SPEAKER_LABEL_UPSERT, (_event, args: { sessionId: string; originalLabel: string; customLabel: string }) => {
      speakerLabelRepo.upsert(args.sessionId, args.originalLabel, args.customLabel);
      return { ok: true };
    }),
  );

  ipcMain.handle(
    CHANNELS.SPEAKER_LABEL_LIST,
    withErrorWrapper(CHANNELS.SPEAKER_LABEL_LIST, (_event, { sessionId }: { sessionId: string }) => {
      const overrides = speakerLabelRepo.findAllBySession(sessionId);
      return overrides.map(o => ({ originalLabel: o.originalLabel, customLabel: o.customLabel }));
    }),
  );

  // ---- Settings ----
  ipcMain.handle(
    CHANNELS.SETTINGS_GET,
    withErrorWrapper(CHANNELS.SETTINGS_GET, (_event, { key }: { key: string }) =>
      settingsRepo.get(key),
    ),
  );

  ipcMain.handle(
    CHANNELS.SETTINGS_SET,
    withErrorWrapper(CHANNELS.SETTINGS_SET, (_event, { key, value }: { key: string; value: unknown }) => {
      const validation = validateSettingsKeyValue(key, value);
      if (!validation.ok) {
        throw Object.assign(new Error(validation.message), { code: 'invalid_argument' });
      }
      settingsRepo.set(key, value);
      return { ok: true };
    }),
  );

  // ---- API Key ----
  ipcMain.handle(
    CHANNELS.APIKEY_SET,
    withErrorWrapper(CHANNELS.APIKEY_SET, (_event, { key }: { key: string }) => {
      apiKeyService.set(key);
      return { ok: true };
    }),
  );

  ipcMain.handle(
    CHANNELS.APIKEY_EXISTS,
    withErrorWrapper(CHANNELS.APIKEY_EXISTS, () => apiKeyService.exists()),
  );

  ipcMain.handle(
    CHANNELS.APIKEY_TEST,
    withErrorWrapper(CHANNELS.APIKEY_TEST, async (_event, { key }: { key: string }) => {
      const providerName = (settingsRepo.get('provider') as string) ?? 'assemblyai';
      if (providerName === 'nvidia') {
        const { NvidiaNimClient } = await import('../asr/nvidia-nim-client.js');
        const { getProtoPath } = await import('../asr/proto-path.js');
        return new NvidiaNimClient(key, getProtoPath()).testConnection();
      }
      const { AssemblyAIClient: AAIClient } = await import('../asr/assemblyai-client.js');
      return new AAIClient(key).testConnection();
    }),
  );

  // ---- Privacy ----
  ipcMain.handle(
    CHANNELS.PRIVACY_ACK_GET,
    withErrorWrapper(CHANNELS.PRIVACY_ACK_GET, () => ({
      acknowledged: privacyService.isAcknowledged(NOTICE_VERSION_HASH),
      content: NOTICE_TEXT,
    })),
  );

  ipcMain.handle(
    CHANNELS.PRIVACY_ACK_SET,
    withErrorWrapper(CHANNELS.PRIVACY_ACK_SET, (_event, { noticeHash }: { noticeHash: string }) => {
      privacyService.acknowledge(noticeHash);
      return { ok: true };
    }),
  );

  ipcMain.handle(
    CHANNELS.PRIVACY_REVOKE,
    withErrorWrapper(CHANNELS.PRIVACY_REVOKE, () => {
      privacyService.revoke();
      return { ok: true };
    }),
  );

  // ---- Transcript Retry ----
  ipcMain.handle(
    CHANNELS.TRANSCRIPT_RETRY_CHUNK,
    withErrorWrapper(CHANNELS.TRANSCRIPT_RETRY_CHUNK, (_event, { chunkId }: { chunkId: string }) => {
      const chunk = chunkRepo.findById(chunkId);
      if (!chunk) return { ok: false };
      if (!existsSync(chunk.filePath)) return { ok: false };
      chunkRepo.resetToPending(chunkId);
      const session = sessionRepo.findById(chunk.sessionId);
      if (session && session.status !== 'recording' && session.status !== 'paused') {
        sessionRepo.updateStatus(chunk.sessionId, 'processing');
      }
      return { ok: true };
    }),
  );

  ipcMain.handle(
    CHANNELS.TRANSCRIPT_RETRY_ALL,
    withErrorWrapper(CHANNELS.TRANSCRIPT_RETRY_ALL, (_event, { sessionId }: { sessionId: string }) => {
      const failedChunks = chunkRepo.findFailedBySession(sessionId);
      let queued = 0;
      for (const chunk of failedChunks) {
        if (existsSync(chunk.filePath)) {
          chunkRepo.resetToPending(chunk.id);
          queued++;
        }
      }
      if (queued > 0) {
        sessionRepo.updateStatus(sessionId, 'processing');
      }
      return { queued };
    }),
  );

  // ---- Export ----
  ipcMain.handle(
    CHANNELS.TRANSCRIPT_EXPORT,
    withErrorWrapper(CHANNELS.TRANSCRIPT_EXPORT, async (_event, args: { sessionId: string; format: 'txt' | 'md' | 'json' }) => {
      const session = sessionRepo.findById(args.sessionId);
      if (!session) return { ok: false };

      const result = await dialog.showSaveDialog({
        title: 'Export transcript',
        defaultPath: `${sanitizeFileName(session.title)}.${args.format}`,
        filters: [{ name: args.format.toUpperCase(), extensions: [args.format] }],
      });

      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

      const segments = segmentRepo.findBySessionId(args.sessionId);
      const overrides = speakerLabelRepo.findBySession(args.sessionId);

      let content: string;
      if (args.format === 'json') content = renderJson(segments, overrides);
      else if (args.format === 'md') content = renderMarkdown(segments, overrides);
      else content = renderText(segments, overrides);

      const { promises: fsp } = await import('node:fs');
      await fsp.writeFile(result.filePath, content, 'utf-8');

      return { ok: true, path: result.filePath };
    }),
  );

  logger.info({ event: 'ipc_handlers_registered' });
}
