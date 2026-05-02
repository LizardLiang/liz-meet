// src/components/SearchBar.tsx
// Debounced full-text search bar.
// Uses STX/ETX markers from FTS5 snippet — renders <mark> via JSX, NOT dangerouslySetInnerHTML.

import { useState, useRef } from 'react';
import type { SearchResult } from '../types/liz-transcribe.js';
import { invokeIpc } from '../lib/ipc.js';

const STX = ''; // start of highlight
const ETX = ''; // end of highlight
const DEBOUNCE_MS = 250;

function renderSnippet(snippet: string): React.ReactNode[] {
  const parts = snippet.split(new RegExp(`[${STX}${ETX}]`));
  const nodes: React.ReactNode[] = [];
  // After split: [text, highlighted, text, highlighted, ...]
  // Parts at odd indices are highlighted
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      nodes.push(parts[i]);
    } else {
      nodes.push(<mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5">{parts[i]}</mark>);
    }
  }
  return nodes;
}

interface Props {
  onResultClick?: (result: SearchResult) => void;
}

export default function SearchBar({ onResultClick }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setQuery(q);

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }

    debounceTimer.current = setTimeout(async () => {
      try {
        const hits = await invokeIpc<SearchResult[]>('segment:search', { query: q.trim(), limit: 20 });
        setResults(hits);
        setOpen(hits.length > 0);
      } catch {
        setResults([]);
      }
    }, DEBOUNCE_MS);
  };

  const handleSelect = (result: SearchResult) => {
    setOpen(false);
    onResultClick?.(result);
  };

  return (
    <div className="relative w-full max-w-lg">
      <input
        type="search"
        className="input input-bordered w-full"
        placeholder="Search transcripts..."
        value={query}
        onChange={handleChange}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label="Search transcripts"
        aria-autocomplete="list"
        aria-expanded={open}
      />

      {open && (
        <ul
          className="absolute z-50 bg-base-200 border border-base-300 rounded-lg shadow-xl w-full mt-1 max-h-80 overflow-y-auto"
          role="listbox"
        >
          {results.map(r => (
            <li
              key={r.segmentId}
              className="px-4 py-2 hover:bg-base-300 cursor-pointer text-sm"
              role="option"
              aria-selected={false}
              onMouseDown={() => handleSelect(r)}
            >
              <div className="font-medium text-xs text-base-content/50 mb-0.5">
                {r.speakerLabel} · {formatTime(r.startSeconds)}
              </div>
              <div>{renderSnippet(r.snippet)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
