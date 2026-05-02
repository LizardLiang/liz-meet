// src/components/SpeakerLabelEditor.tsx
// Inline editor for speaker label overrides.

import { useState } from 'react';
import { invokeIpc } from '../lib/ipc.js';

interface Props {
  sessionId: string;
  originalLabel: string;
  currentLabel: string;
  onRenamed: (originalLabel: string, newLabel: string) => void;
}

export default function SpeakerLabelEditor({ sessionId, originalLabel, currentLabel, onRenamed }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentLabel);
  const [saving, setSaving] = useState(false);

  const handleCommit = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === currentLabel) {
      setEditing(false);
      setValue(currentLabel);
      return;
    }
    setSaving(true);
    try {
      await invokeIpc('speakerLabel:upsert', {
        sessionId,
        originalLabel,
        customLabel: trimmed,
      });
      onRenamed(originalLabel, trimmed);
      setEditing(false);
    } catch {
      setValue(currentLabel);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        type="text"
        className="input input-bordered input-xs w-32"
        value={value}
        autoFocus
        disabled={saving}
        onChange={e => setValue(e.target.value)}
        onBlur={handleCommit}
        onKeyDown={e => {
          if (e.key === 'Enter') handleCommit();
          if (e.key === 'Escape') {
            setValue(currentLabel);
            setEditing(false);
          }
        }}
        aria-label={`Rename speaker ${currentLabel}`}
      />
    );
  }

  return (
    <button
      className="text-xs font-semibold hover:underline cursor-pointer bg-transparent border-none p-0"
      onClick={() => setEditing(true)}
      title="Click to rename speaker"
      aria-label={`Rename speaker ${currentLabel}`}
    >
      {currentLabel}
    </button>
  );
}
