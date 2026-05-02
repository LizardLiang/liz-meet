// src/pages/LibraryPage.tsx
// Session library with virtualized list and search.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import SessionCard from '../components/SessionCard.js';
import SearchBar from '../components/SearchBar.js';
import LibraryFilters, { type FilterState } from '../components/LibraryFilters.js';
import DeleteConfirmDialog from '../components/DeleteConfirmDialog.js';
import { invokeIpc, onPush } from '../lib/ipc.js';
import type { Session, SessionStatus, SearchResult } from '../types/liz-transcribe.js';

export default function LibraryPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filters, setFilters] = useState<FilterState>({ status: '', dateFrom: '', dateTo: '' });
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const args: Record<string, unknown> = {};
      if (filters.status) args['status'] = [filters.status];
      if (filters.dateFrom) args['dateFrom'] = filters.dateFrom;
      if (filters.dateTo) args['dateTo'] = filters.dateTo;
      const data = await invokeIpc<Session[]>('session:list', args);
      setSessions(data);
    } catch {
      // Display empty state
    }
  }, [filters]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Subscribe to status-changed push events
  useEffect(() => {
    const unsub = onPush<{ sessionId: string; newStatus: SessionStatus }>(
      'session:status-changed',
      ({ sessionId, newStatus }) => {
        setSessions(prev =>
          prev.map(s => (s.id === sessionId ? { ...s, status: newStatus } : s)),
        );
      },
    );
    return unsub;
  }, []);

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    overscan: 5,
  });

  const handleDelete = async (session: Session) => {
    try {
      await invokeIpc('session:delete', { id: session.id });
      setSessions(prev => prev.filter(s => s.id !== session.id));
    } catch {
      // Show error toast
    }
    setDeleteTarget(null);
  };

  const handleSearchResult = (result: SearchResult) => {
    navigate(`/session/${result.sessionId}?seg=${result.segmentId}`);
  };

  return (
    <div className="min-h-screen bg-base-100 text-base-content flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-base-100 border-b border-base-300 px-6 py-4">
        <div className="flex items-center justify-between gap-4 mb-3">
          <h1 className="text-2xl font-bold">Sessions</h1>
          <div className="flex gap-2">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => navigate('/recording')}
            >
              New recording
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate('/settings')}
            >
              Settings
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <SearchBar onResultClick={handleSearchResult} />
          <LibraryFilters filters={filters} onChange={setFilters} />
        </div>
      </div>

      {/* Session list */}
      <div ref={parentRef} className="flex-1 overflow-y-auto px-6 py-4">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-base-content/50">
            <p className="text-lg mb-2">No sessions yet</p>
            <p className="text-sm">Start a new recording to get started</p>
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map(item => {
              const session = sessions[item.index];
              return (
                <div
                  key={session.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                    padding: '4px 0',
                  }}
                >
                  <SessionCard
                    session={session}
                    onClick={() => navigate(`/session/${session.id}`)}
                    onDelete={() => setDeleteTarget(session)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <DeleteConfirmDialog
          sessionTitle={deleteTarget.title}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
