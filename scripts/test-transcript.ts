#!/usr/bin/env bun
/**
 * Transcript quality tester — AssemblyAI or NVIDIA NIM (gRPC).
 *
 * Usage:
 *   bun scripts/test-transcript.ts --file <audio/video> [options]
 *
 * Options:
 *   --file <path>          Audio or video file (required)
 *   --provider <name>      assemblyai | nvidia  (default: nvidia)
 *   --model <name>         NVIDIA model name (default: nvidia/parakeet-tdt-0.6b-v2)
 *   --api-key <key>        API key (or set ASSEMBLYAI_API_KEY / NVIDIA_API_KEY)
 *   --reference <path>     Plain-text reference transcript for WER
 *   --language <code>      Language code (default: en_us / en-US)
 *   --no-speaker-labels    Disable diarization
 *   --json                 Dump raw response object
 */

import { promises as fsp } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as wav from 'wav';

// ── Load .env ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt  = (n: string) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined; };

const filePath      = opt('--file');
const provider      = (opt('--provider') ?? 'nvidia') as 'assemblyai' | 'nvidia';
const modelOverride = opt('--model');
const referencePath = opt('--reference');
const language      = opt('--language') ?? (provider === 'nvidia' ? 'en-US' : 'en_us');
const speakerLabels = !flag('--no-speaker-labels');
const dumpJson      = flag('--json');
const outputPath    = opt('--output');

const apiKey = opt('--api-key') ??
  (provider === 'nvidia' ? process.env.NVIDIA_API_KEY : process.env.ASSEMBLYAI_API_KEY);

if (!filePath) {
  console.error('Error: --file is required');
  process.exit(1);
}
if (!apiKey) {
  const envVar = provider === 'nvidia' ? 'NVIDIA_API_KEY' : 'ASSEMBLYAI_API_KEY';
  console.error(`Error: provide --api-key or set ${envVar} in .env`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function msToTimestamp(ms: number): string {
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  const s  = Math.floor((ms % 60_000) / 1_000);
  const r  = ms % 1_000;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(r).padStart(3,'0')}`;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinIdx = 0, spinTimer: ReturnType<typeof setInterval> | null = null;
function spinStart(label: string) {
  spinIdx = 0;
  spinTimer = setInterval(() => process.stdout.write(`\r${SPIN[spinIdx++ % SPIN.length]}  ${label}   `), 80);
}
function spinStop(label: string) {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  process.stdout.write(`\r✓  ${label}\n`);
}

// ── Word Error Rate ──────────────────────────────────────────────────────────

function normalise(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
}
function computeWer(hyp: string, ref: string) {
  const h = normalise(hyp), r = normalise(ref);
  const n = r.length, m = h.length;
  const dp = Array.from({length: n+1}, (_,i) =>
    Array.from({length: m+1}, (_,j) => i===0 ? j : j===0 ? i : 0));
  for (let i=1;i<=n;i++)
    for (let j=1;j<=m;j++)
      dp[i][j] = r[i-1]===h[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j-1],dp[i-1][j],dp[i][j-1]);
  let sub=0,del=0,ins=0,i=n,j=m;
  while (i>0||j>0) {
    if (i>0&&j>0&&r[i-1]===h[j-1])               {i--;j--;}
    else if (i>0&&j>0&&dp[i][j]===dp[i-1][j-1]+1) {sub++;i--;j--;}
    else if (i>0&&dp[i][j]===dp[i-1][j]+1)         {del++;i--;}
    else                                             {ins++;j--;}
  }
  return { wer: n>0 ? dp[n][m]/n : 0, sub, del, ins, refLen: n };
}

// ── Provider: NVIDIA gRPC ─────────────────────────────────────────────────────

// NVCF function IDs per model (base function IDs for shared/public models).
// Sourced from the live NVCF catalog (api.nvcf.nvidia.com/v2/nvcf/functions).
const NVIDIA_FUNCTION_IDS: Record<string, string> = {
  'nvidia/parakeet-tdt-0.6b-v2':  'd3fe9151-442b-4204-a70d-5fcc597fd610',
  'nvidia/parakeet-ctc-0.6b-asr': 'd8dd4e9b-fbf5-4fb0-9dba-8cf436c8d965',
  'nvidia/parakeet-ctc-1.1b-asr': '1598d209-5e27-4d3c-8079-4751568b1081',
  'nvidia/canary-1b-asr':         'b0e8b4a5-217c-40b7-9b96-17d84e666317',
};

const NVIDIA_MODEL   = modelOverride ?? 'nvidia/parakeet-tdt-0.6b-v2';
const NVIDIA_HOST    = 'grpc.nvcf.nvidia.com:443';
const FUNCTION_ID    = NVIDIA_FUNCTION_IDS[NVIDIA_MODEL];

if (provider === 'nvidia' && !FUNCTION_ID) {
  console.error(`Unknown NVIDIA model: ${NVIDIA_MODEL}`);
  console.error('Known models:', Object.keys(NVIDIA_FUNCTION_IDS).join(', '));
  process.exit(1);
}

interface RivaWordInfo {
  word: string;
  confidence: number;
  speaker_tag: number;
  start_time: number; // milliseconds
  end_time: number;   // milliseconds
}
interface RivaAlternative { transcript: string; confidence: number; words: RivaWordInfo[] }
interface RivaResult      { alternatives: RivaAlternative[] }
interface RivaResponse    { results: RivaResult[] }

function durationToMs(ms: number): number { return ms; }

// Max PCM bytes per gRPC call — 50 MB keeps us well under the 64 MB message limit
const CHUNK_BYTES = 50 * 1024 * 1024;

async function transcribeNvidiaGrpc(filePath: string): Promise<{ text: string; raw: RivaResponse }> {
  const protoPath = resolve(__dirname, 'protos/riva_asr.proto');
  const pkgDef = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true,
    includeDirs: [resolve(__dirname, 'protos')],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg = grpc.loadPackageDefinition(pkgDef) as any;
  const RivaSpeechRecognition = pkg.nvidia.riva.asr.RivaSpeechRecognition;

  const creds = grpc.credentials.createSsl();
  const client = new RivaSpeechRecognition(NVIDIA_HOST, creds, {
    'grpc.max_send_message_length':    64 * 1024 * 1024,
    'grpc.max_receive_message_length': 64 * 1024 * 1024,
  });

  // Extract raw PCM frames from WAV
  const { frames, sampleRate } = await new Promise<{ frames: Buffer; sampleRate: number }>((res, rej) => {
    const reader = new wav.Reader();
    const chunks: Buffer[] = [];
    let fmt: wav.Format | null = null;
    reader.on('format', (f: wav.Format) => { fmt = f; });
    reader.on('data', (chunk: Buffer) => chunks.push(chunk));
    reader.on('end', () => res({ frames: Buffer.concat(chunks), sampleRate: fmt?.sampleRate ?? 16000 }));
    reader.on('error', rej);
    fsp.readFile(filePath).then(buf => { reader.end(buf); }).catch(rej);
  });

  // Split into chunks if audio exceeds per-call limit
  const totalChunks = Math.ceil(frames.length / CHUNK_BYTES);
  const bytesPerMs  = (sampleRate * 2) / 1000; // 16-bit mono

  const config = {
    encoding: 1,
    sample_rate_hertz: sampleRate,
    language_code: language,
    max_alternatives: 1,
    enable_automatic_punctuation: true,
    enable_word_time_offsets: true,
    ...(speakerLabels ? { diarization_config: { enable_speaker_diarization: true, max_speaker_count: 8 } } : {}),
  };

  const callMeta = new grpc.Metadata();
  callMeta.set('authorization', `Bearer ${apiKey}`);
  callMeta.set('function-id', FUNCTION_ID);

  const recognize = (audio: Buffer): Promise<RivaResponse> =>
    new Promise((resolve, reject) => {
      client.Recognize({ config, audio }, callMeta, (err: grpc.ServiceError | null, res: RivaResponse) => {
        if (err) reject(err); else resolve(res);
      });
    });

  if (totalChunks === 1) {
    spinStart(`Transcribing via NVIDIA gRPC (${NVIDIA_MODEL})…`);
    const response = await recognize(frames);
    spinStop('Transcription complete');
    const text = response.results.flatMap(r => r.alternatives[0]?.transcript ?? '').join(' ').trim();
    return { text, raw: response };
  }

  // Multi-chunk: process sequentially, offset timestamps per chunk
  const allResults: RivaResult[] = [];
  let fullText = '';

  for (let i = 0; i < totalChunks; i++) {
    const chunkFrames  = frames.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const offsetMs     = Math.round((i * CHUNK_BYTES) / bytesPerMs);
    const chunkSec     = Math.round(chunkFrames.length / bytesPerMs / 1000);

    spinStart(`Chunk ${i + 1}/${totalChunks} — offset ${msToTimestamp(offsetMs)}, ${chunkSec}s…`);
    const resp = await recognize(chunkFrames);
    spinStop(`Chunk ${i + 1}/${totalChunks} done`);

    // Shift word timestamps by chunk offset
    for (const result of resp.results) {
      for (const alt of result.alternatives) {
        fullText += (fullText ? ' ' : '') + alt.transcript;
        for (const w of alt.words) {
          w.start_time += offsetMs;
          w.end_time   += offsetMs;
        }
      }
    }
    allResults.push(...resp.results);
  }

  // Return a merged RivaResponse
  const merged: RivaResponse = { results: allResults };
  return { text: fullText.trim(), raw: merged };
}

// ── Provider: AssemblyAI ─────────────────────────────────────────────────────

const AAI_BASE = 'https://api.assemblyai.com/v2';
const aaiAuth  = { Authorization: apiKey! };

interface AaiUtterance { speaker: string; start: number; end: number; text: string; confidence?: number }
interface AaiResult {
  status: string; text?: string;
  utterances?: AaiUtterance[];
  words?: Array<{ text: string; confidence: number }>;
  error?: string;
}

async function transcribeAssemblyAI(filePath: string): Promise<{ text: string; raw: AaiResult }> {
  spinStart('Uploading audio…');
  const body = await fsp.readFile(filePath);
  const up = await fetch(`${AAI_BASE}/upload`, { method:'POST', headers:aaiAuth, body, redirect:'manual' });
  if (!up.ok) throw new Error(`AssemblyAI upload failed: ${up.status}`);
  const { upload_url } = await up.json() as { upload_url: string };
  spinStop('Upload complete');

  spinStart('Submitting transcription job…');
  const sub = await fetch(`${AAI_BASE}/transcript`, {
    method: 'POST',
    headers: { ...aaiAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, speaker_labels: speakerLabels, language_code: language }),
    redirect: 'manual',
  });
  if (!sub.ok) throw new Error(`AssemblyAI submit failed: ${sub.status}`);
  const { id } = await sub.json() as { id: string };
  spinStop(`Job submitted  (id: ${id})`);

  spinStart('Waiting for transcription…');
  let result: AaiResult;
  for (;;) {
    const poll = await fetch(`${AAI_BASE}/transcript/${id}`, { headers: aaiAuth, redirect: 'manual' });
    if (!poll.ok) throw new Error(`AssemblyAI poll failed: ${poll.status}`);
    result = await poll.json() as AaiResult;
    if (result.status === 'completed' || result.status === 'error') break;
    await new Promise(r => setTimeout(r, 3_000));
  }
  spinStop('Transcription complete');

  if (result!.status === 'error') throw new Error(`AssemblyAI: ${result!.error ?? 'unknown'}`);
  return { text: result!.text ?? '', raw: result! };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const absPath  = resolve(filePath!);
const fileName = basename(absPath);
const modelLabel = provider === 'nvidia' ? `  |  Model: ${NVIDIA_MODEL}` : '';

console.log(`\nTranscript quality test — ${fileName}`);
console.log(`Provider: ${provider}${modelLabel}  |  Language: ${language}  |  Speaker labels: ${speakerLabels}\n`);

let transcriptText = '';
let rawResult: unknown;

if (provider === 'nvidia') {
  const { text, raw } = await transcribeNvidiaGrpc(absPath);
  transcriptText = text; rawResult = raw;
} else {
  const { text, raw } = await transcribeAssemblyAI(absPath);
  transcriptText = text; rawResult = raw;
}

// ── Output ───────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────────────────────');

if (provider === 'nvidia') {
  const resp = rawResult as RivaResponse;
  const allWords = resp.results.flatMap(r => r.alternatives[0]?.words ?? []);

  if (speakerLabels && allWords.some(w => w.speaker_tag != null)) {
    // Group consecutive words by speaker into turns
    const turns: Array<{ speaker: number; words: RivaWordInfo[] }> = [];
    for (const w of allWords) {
      const last = turns[turns.length - 1];
      if (last && last.speaker === w.speaker_tag) { last.words.push(w); }
      else turns.push({ speaker: w.speaker_tag, words: [w] });
    }
    for (const turn of turns) {
      const start = durationToMs(turn.words[0].start_time);
      const end   = durationToMs(turn.words[turn.words.length - 1].end_time);
      const text  = turn.words.map(w => w.word).join(' ');
      console.log(`\n[${msToTimestamp(start)} → ${msToTimestamp(end)}]  Speaker ${turn.speaker}`);
      console.log(`  ${text}`);
    }
  } else {
    console.log(`\n${transcriptText || '(empty transcript)'}`);
    if (allWords.length > 0) {
      console.log('\n── Word timestamps ───────────────────────────────────────────');
      for (const w of allWords) {
        const s = durationToMs(w.start_time), e = durationToMs(w.end_time);
        const conf = w.confidence != null ? `  [${pct(w.confidence)}]` : '';
        console.log(`  [${msToTimestamp(s)} → ${msToTimestamp(e)}]  ${w.word}${conf}`);
      }
    }
  }
} else {
  const aai = rawResult as AaiResult;
  if (aai.utterances && aai.utterances.length > 0) {
    for (const u of aai.utterances) {
      const conf = u.confidence != null ? `  [${pct(u.confidence)}]` : '';
      console.log(`\n[${msToTimestamp(u.start)} → ${msToTimestamp(u.end)}]  Speaker ${u.speaker}${conf}`);
      console.log(`  ${u.text}`);
    }
  } else {
    console.log(`\n${transcriptText || '(empty transcript)'}`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────────────────────');
console.log(`\nWords transcribed : ${transcriptText.split(/\s+/).filter(Boolean).length}`);

if (provider === 'assemblyai') {
  const aai = rawResult as AaiResult;
  const words = aai.words ?? [];
  if (words.length > 0) {
    const avg = words.reduce((s,w) => s+w.confidence, 0) / words.length;
    console.log(`Avg word confidence: ${pct(avg)}`);
  }
  if (aai.utterances) {
    const speakers = new Set(aai.utterances.map(u => u.speaker));
    console.log(`Speakers detected : ${speakers.size}  (${[...speakers].map(s=>`Speaker ${s}`).join(', ')})`);
  }
} else {
  const resp  = rawResult as RivaResponse;
  const words = resp.results.flatMap(r => r.alternatives[0]?.words ?? []);
  if (words.length > 0) {
    const avg = words.reduce((s,w) => s+w.confidence, 0) / words.length;
    console.log(`Avg word confidence: ${pct(avg)}`);
    if (speakerLabels) {
      const speakers = new Set(words.map(w => w.speaker_tag));
      console.log(`Speakers detected : ${speakers.size}  (${[...speakers].map(s=>`Speaker ${s}`).join(', ')})`);
    }
  }
}

// ── Optional WER ─────────────────────────────────────────────────────────────

if (referencePath) {
  const refText = await fsp.readFile(resolve(referencePath), 'utf-8');
  const score   = computeWer(transcriptText, refText);
  console.log('\n── Word Error Rate ───────────────────────────────────────────');
  console.log(`WER            : ${pct(score.wer)}  (${score.wer.toFixed(4)})`);
  console.log(`Substitutions  : ${score.sub}`);
  console.log(`Deletions      : ${score.del}`);
  console.log(`Insertions     : ${score.ins}`);
  console.log(`Reference words: ${score.refLen}`);
}

// ── Raw dump ──────────────────────────────────────────────────────────────────

if (dumpJson) {
  console.log('\n── Raw response ──────────────────────────────────────────────');
  console.log(JSON.stringify(rawResult, null, 2));
}

// ── Save output ───────────────────────────────────────────────────────────────

{
  const defaultOut = absPath.replace(/(\.[^.]+)$/, '') + '.transcript.json';
  const savePath   = outputPath ? resolve(outputPath) : defaultOut;

  const output = {
    meta: {
      file:      fileName,
      provider,
      model:     provider === 'nvidia' ? NVIDIA_MODEL : 'assemblyai-default',
      language,
      speakerLabels,
      createdAt: new Date().toISOString(),
    },
    transcript: transcriptText,
    ...(provider === 'assemblyai' && (rawResult as AaiResult).utterances
      ? {
          speakers: [...new Set((rawResult as AaiResult).utterances!.map(u => u.speaker))],
          turns: (rawResult as AaiResult).utterances!.map(u => ({
            speaker:    u.speaker,
            startMs:    u.start,
            endMs:      u.end,
            text:       u.text,
            confidence: u.confidence ?? null,
          })),
        }
      : {}),
    ...(provider === 'nvidia'
      ? (() => {
          const resp  = rawResult as RivaResponse;
          const words = resp.results.flatMap(r => r.alternatives[0]?.words ?? []);
          const speakers = speakerLabels ? [...new Set(words.map(w => w.speaker_tag))] : undefined;
          return {
            ...(speakers ? { speakers } : {}),
            words: words.map(w => ({
              word:      w.word,
              startMs:   w.start_time,
              endMs:     w.end_time,
              confidence: w.confidence,
              ...(speakerLabels ? { speaker: w.speaker_tag } : {}),
            })),
          };
        })()
      : {}),
    raw: rawResult,
  };

  await fsp.writeFile(savePath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nSaved → ${savePath}`);
}

console.log();
