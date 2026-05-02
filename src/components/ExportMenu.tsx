// src/components/ExportMenu.tsx
// Export transcript to .txt, .md, or .json via Electron save dialog.

import { useState } from 'react';
import { invokeIpc } from '../lib/ipc.js';

interface Props {
  sessionId: string;
}

export default function ExportMenu({ sessionId }: Props) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: 'txt' | 'md' | 'json') => {
    setOpen(false);
    setExporting(true);
    try {
      await invokeIpc('transcript:export', { sessionId, format });
    } catch {
      // Error is handled by IPC layer
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="dropdown dropdown-end">
      <button
        className="btn btn-outline btn-sm"
        onClick={() => setOpen(!open)}
        disabled={exporting}
        aria-label="Export transcript"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {exporting ? 'Exporting...' : 'Export'}
      </button>
      {open && (
        <ul className="dropdown-content z-10 menu p-2 shadow bg-base-200 rounded-box w-36">
          <li><button onClick={() => handleExport('txt')}>Plain Text (.txt)</button></li>
          <li><button onClick={() => handleExport('md')}>Markdown (.md)</button></li>
          <li><button onClick={() => handleExport('json')}>JSON (.json)</button></li>
        </ul>
      )}
    </div>
  );
}
