// electron/asr/provider-interface.ts
// IASRProvider interface — AssemblyAI and future providers implement this.

export interface RawUtterance {
  speakerLabel: string;     // "A", "B", … from AssemblyAI; or "1", "2", … from Deepgram
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
}

export interface TranscribeOptions {
  speakerLabels?: boolean;
  languageCode?: string;
}

export interface TranscriptResult {
  status: 'queued' | 'processing' | 'completed' | 'error';
  utterances?: Array<{
    speaker: string;
    start: number;
    end: number;
    text: string;
    confidence?: number;
  }>;
  error?: string;
}

export interface IASRProvider {
  readonly name: 'assemblyai' | 'deepgram';
  uploadChunk(filePath: string, signal?: AbortSignal): Promise<string>;
  submitTranscript(
    audioUrl: string,
    options: TranscribeOptions,
    signal?: AbortSignal,
  ): Promise<string>;
  pollTranscript(
    transcriptId: string,
    signal?: AbortSignal,
  ): Promise<TranscriptResult>;
  parseUtterances(result: TranscriptResult): RawUtterance[];
}
