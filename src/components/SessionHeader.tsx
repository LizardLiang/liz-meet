// src/components/SessionHeader.tsx
// Inline-editable session title and notes.

import { useState } from 'react';
import { invokeIpc } from '../lib/ipc.js';
import type { Session } from '../types/liz-transcribe.js';

interface Props {
  session: Session;
  onUpdated: (updated: Session) => void;
}

export default function SessionHeader({ session, onUpdated }: Props) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(session.title);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState(session.notes);

  const saveTitle = async () => {
    const trimmed = titleValue.trim();
    if (trimmed && trimmed !== session.title) {
      try {
        const updated = await invokeIpc<Session>('session:update', {
          id: session.id,
          title: trimmed,
        });
        onUpdated(updated);
      } catch {
        setTitleValue(session.title);
      }
    } else {
      setTitleValue(session.title);
    }
    setEditingTitle(false);
  };

  const saveNotes = async () => {
    if (notesValue !== session.notes) {
      try {
        const updated = await invokeIpc<Session>('session:update', {
          id: session.id,
          notes: notesValue,
        });
        onUpdated(updated);
      } catch {
        setNotesValue(session.notes);
      }
    }
    setEditingNotes(false);
  };

  return (
    <div className="mb-4">
      {editingTitle ? (
        <input
          type="text"
          className="input input-bordered text-2xl font-bold w-full max-w-xl"
          value={titleValue}
          autoFocus
          onChange={e => setTitleValue(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={e => {
            if (e.key === 'Enter') saveTitle();
            if (e.key === 'Escape') { setTitleValue(session.title); setEditingTitle(false); }
          }}
          aria-label="Session title"
        />
      ) : (
        <h1
          className="text-2xl font-bold cursor-pointer hover:opacity-80"
          onClick={() => setEditingTitle(true)}
          title="Click to rename"
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && setEditingTitle(true)}
        >
          {session.title || 'Untitled session'}
        </h1>
      )}

      {editingNotes ? (
        <textarea
          className="textarea textarea-bordered w-full mt-2 text-sm"
          value={notesValue}
          rows={2}
          autoFocus
          onChange={e => setNotesValue(e.target.value)}
          onBlur={saveNotes}
          placeholder="Add notes..."
          aria-label="Session notes"
        />
      ) : (
        <p
          className="text-sm text-base-content/60 mt-1 cursor-pointer hover:opacity-80"
          onClick={() => setEditingNotes(true)}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && setEditingNotes(true)}
          title="Click to add notes"
        >
          {session.notes || 'Add notes...'}
        </p>
      )}
    </div>
  );
}
