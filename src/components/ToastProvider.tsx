// src/components/ToastProvider.tsx
// In-app toast notification system. Listens on session:status-changed,
// session:auto-stopped, and asr:provider-banner push channels.

import { useState, useEffect, useCallback } from 'react';
import { onPush } from '../lib/ipc.js';
import type { SessionStatus } from '../types/liz-transcribe.js';
import { ToastContext, type Toast } from '../lib/toast-context.js';

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5_000);
  }, []);

  // Subscribe to push channels
  useEffect(() => {
    const unsubStatus = onPush<{ sessionId: string; newStatus: SessionStatus }>(
      'session:status-changed',
      ({ newStatus }) => {
        if (newStatus === 'completed') {
          addToast({ type: 'success', message: 'Transcription completed.' });
        } else if (newStatus === 'failed') {
          addToast({ type: 'error', message: 'Transcription failed.' });
        } else if (newStatus === 'completed_with_failures') {
          addToast({ type: 'warning', message: 'Transcription completed with some gaps.' });
        }
      },
    );

    const unsubAutoStop = onPush<{ sessionId: string; reason: string }>(
      'session:auto-stopped',
      ({ reason }) => {
        const msg =
          reason === 'sleep'
            ? 'Recording auto-stopped: sleep/hibernate detected.'
            : 'Recording auto-stopped after 4-hour pause timeout.';
        addToast({ type: 'warning', message: msg });
      },
    );

    const unsubBanner = onPush<{ visible: boolean }>(
      'asr:provider-banner',
      ({ visible }) => {
        if (visible) {
          addToast({ type: 'error', message: 'ASR provider unreachable — uploads paused.' });
        }
      },
    );

    return () => {
      unsubStatus();
      unsubAutoStop();
      unsubBanner();
    };
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}

      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`alert shadow-lg ${
              toast.type === 'success' ? 'alert-success' :
              toast.type === 'warning' ? 'alert-warning' :
              toast.type === 'error'   ? 'alert-error' :
                                          'alert-info'
            }`}
            role="alert"
            aria-live="polite"
          >
            <span className="text-sm">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
