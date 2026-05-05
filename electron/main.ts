import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { update } from './update.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// Enable remote debugging in dev mode so agent-browser can connect via CDP
if (VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

let win: BrowserWindow | null

// Lazy-loaded services (initialized after app is ready)
let chunkProcessorInstance: import('./asr/chunk-processor.js').ChunkProcessor | null = null
let stateMachineInstance: import('./capture/session-state.js').SessionStateMachine | null = null

async function bootstrap() {
  const { getDatabase, closeDatabase } = await import('./db/database.js')
  const { SessionRepository } = await import('./db/session-repository.js')
  const { ChunkRepository } = await import('./db/chunk-repository.js')
  const { SegmentRepository } = await import('./db/segment-repository.js')
  const { SpeakerLabelRepository } = await import('./db/speaker-label-repository.js')
  const { SettingsRepository } = await import('./db/settings-repository.js')
  const { SessionStateMachine } = await import('./capture/session-state.js')
  const { detectOrphanedSessions } = await import('./capture/recovery.js')
  const { AssemblyAIClient } = await import('./asr/assemblyai-client.js')
  const { NvidiaNimClient } = await import('./asr/nvidia-nim-client.js')
  const { getProtoPath } = await import('./asr/proto-path.js')
  const { DeepgramClient } = await import('./asr/deepgram-client.js')
const { ChunkProcessor } = await import('./asr/chunk-processor.js')
  const { TranscriptAssembler } = await import('./asr/transcript-assembler.js')
  const { SessionFinalizer } = await import('./asr/session-finalizer.js')
  const { apiKeyService } = await import('./services/api-key-service.js')
  const { PrivacyService } = await import('./services/privacy-service.js')
  const { registerHandlers } = await import('./ipc/handlers.js')
  const { logger } = await import('./logging/logger.js')

  const db = getDatabase()
  const sessionRepo = new SessionRepository(db)
  const chunkRepo = new ChunkRepository(db)
  const segmentRepo = new SegmentRepository(db)
  const speakerLabelRepo = new SpeakerLabelRepository(db)
  const settingsRepo = new SettingsRepository(db)

  const privacyService = new PrivacyService(settingsRepo)

  // Detect orphaned sessions before creating the window
  // Move non-stale candidates to 'processing' so the chunk processor can finalize them
  const orphans = detectOrphanedSessions(sessionRepo, chunkRepo)
  for (const orphan of orphans) {
    sessionRepo.updateStatus(orphan.sessionId, 'processing')
  }

  createWindow()

  if (!win) throw new Error('Window not created')

  const stateMachine = new SessionStateMachine(win, sessionRepo, chunkRepo, settingsRepo)
  stateMachineInstance = stateMachine

  // Provider factory — evaluated on every upload/poll so that a key set after
  // bootstrap (first-run flow, key rotation) is always used (fixes H-03).
  const providerFactory = () => {
    let key = '';
    try { key = apiKeyService.get(); } catch { /* no key yet */ }
    const providerName = (settingsRepo.get('provider') as string) ?? 'nvidia';
    if (providerName === 'nvidia') {
      return new NvidiaNimClient(key, getProtoPath());
    }
    if (providerName === 'deepgram') {
      return new DeepgramClient(key);
    }
    return new AssemblyAIClient(key);
  }

  const assembler = new TranscriptAssembler(chunkRepo, segmentRepo)
  const finalizer = new SessionFinalizer(chunkRepo, sessionRepo, segmentRepo, settingsRepo, assembler, win)
  const processor = new ChunkProcessor(chunkRepo, segmentRepo, sessionRepo, providerFactory, finalizer, win)
  chunkProcessorInstance = processor
  processor.start()

  registerHandlers({
    win,
    sessionRepo,
    chunkRepo,
    segmentRepo,
    speakerLabelRepo,
    settingsRepo,
    stateMachine,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiKeyService: apiKeyService as any,
    privacyService,
  })

  app.on('before-quit', () => {
    processor.stop()
    stateMachine.cleanup()
    closeDatabase()
    logger.info({ event: 'app_quit' })
  })

  logger.info({ event: 'app_started' })
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC!, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,  // defense-in-depth §4.2.4 R-SEC-2
    },
  })

  // Allow getUserMedia(audio) so Bluetooth mics trigger Windows HFP profile switch.
  // Deny everything else (camera, geolocation, notifications, …).
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const req = details as { mediaTypes?: string[] };
      const audioOnly = Array.isArray(req.mediaTypes)
        && req.mediaTypes.includes('audio')
        && !req.mediaTypes.includes('video');
      return callback(audioOnly);
    }
    callback(false);
  });

  update(win)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(bootstrap).catch(console.error)

// Export for testing
export { chunkProcessorInstance, stateMachineInstance }
