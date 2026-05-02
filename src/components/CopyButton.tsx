// src/components/CopyButton.tsx
// Copy full transcript or selected segments to clipboard.

import { useState } from 'react';
import type { Segment } from '../types/liz-transcribe.js';

interface Props {
  segments: Segment[];
  labelOverrides: Map<string, string>;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function CopyButton({ segments, labelOverrides }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = segments
      .map(s => {
        const label = labelOverrides.get(s.speakerLabel) ?? s.speakerLabel;
        return `[${formatTime(s.startSeconds)}] ${label}: ${s.text}`;
      })
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Fallback: select all text in a textarea
    }
  };

  return (
    <button
      className="btn btn-outline btn-sm"
      onClick={handleCopy}
      aria-label="Copy transcript to clipboard"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}
