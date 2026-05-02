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
  detectOrphanedSessions(sessionRepo, chunkRepo)

  createWindow()

  if (!win) throw new Error('Window not created')

  const stateMachine = new SessionStateMachine(win, sessionRepo, chunkRepo, settingsRepo)
  stateMachineInstance = stateMachine

  // Build ASR pipeline (provider may not have key yet — it reads on demand)
  const getProvider = () => {
    try {
      const key = apiKeyService.get()
      return new AssemblyAIClient(key)
    } catch {
      // No key yet; provider will be unavailable until key is set
      return new AssemblyAIClient('')
    }
  }

  const assembler = new TranscriptAssembler(chunkRepo, segmentRepo, getProvider())
  const finalizer = new SessionFinalizer(chunkRepo, sessionRepo, segmentRepo, settingsRepo, assembler, win)
  const processor = new ChunkProcessor(chunkRepo, segmentRepo, sessionRepo, getProvider(), finalizer, win)
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
