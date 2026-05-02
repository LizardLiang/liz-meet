// electron/asr/deepgram-client.ts
// Deepgram provider stub — behind LIZMEET_PROVIDER=deepgram feature flag.
// Not functional in v1; provides the interface compliance structure.

import type { IASRProvider, RawUtterance, TranscribeOptions, TranscriptResult } from './provider-interface.js';

export class DeepgramClient implements IASRProvider {
  readonly name = 'deepgram' as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_apiKey: string) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async uploadChunk(_filePath: string, _signal?: AbortSignal): Promise<string> {
    throw new Error('Deepgram provider not yet implemented');
  }

  async submitTranscript(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _audioUrl: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: TranscribeOptions,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _signal?: AbortSignal,
  ): Promise<string> {
    throw new Error('Deepgram provider not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async pollTranscript(_transcriptId: string, _signal?: AbortSignal): Promise<TranscriptResult> {
    throw new Error('Deepgram provider not yet implemented');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  parseUtterances(_result: TranscriptResult): RawUtterance[] {
    throw new Error('Deepgram provider not yet implemented');
  }
}
