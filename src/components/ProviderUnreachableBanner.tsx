// src/components/ProviderUnreachableBanner.tsx
// Banner shown when the ASR provider has been unreachable for 3 consecutive uploads.

import { useState, useEffect } from 'react';
import { onPush } from '../lib/ipc.js';

export default function ProviderUnreachableBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unsub = onPush<{ visible: boolean }>('asr:provider-banner', ({ visible }) => {
      setVisible(visible);
    });
    return unsub;
  }, []);

  if (!visible) return null;

  return (
    <div className="alert alert-error rounded-none" role="alert" aria-live="assertive">
      <span>
        ASR provider unreachable — uploads paused. Check your network connection.
      </span>
      <button
        className="btn btn-ghost btn-xs"
        onClick={() => setVisible(false)}
        aria-label="Dismiss banner"
      >
        Dismiss
      </button>
    </div>
  );
}
