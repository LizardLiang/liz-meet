// src/routes/guards.ts
// React Router v6 loaders for the first-run gate (locked decision L2).

import { redirect } from 'react-router-dom';
import { invokeIpc } from '../lib/ipc.js';

// Channels (inline strings to avoid circular import from electron/ into src/)
const PRIVACY_ACK_GET = 'privacy:get';
const APIKEY_EXISTS   = 'apikey:exists';

async function getPrivacyAcknowledged(): Promise<boolean> {
  try {
    const result = await invokeIpc<{ acknowledged: boolean; content: string }>(PRIVACY_ACK_GET);
    return result.acknowledged;
  } catch {
    return false;
  }
}

async function getApiKeyExists(): Promise<boolean> {
  try {
    const result = await invokeIpc<boolean>(APIKEY_EXISTS);
    return result;
  } catch {
    return false;
  }
}

/**
 * rootGuard: allows /first-run/* unconditionally.
 * Otherwise enforces: privacyAck → apiKey → allowed.
 */
export async function rootGuard({ request }: { request: Request }) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/first-run')) return null;

  const privacyAck = await getPrivacyAcknowledged();
  if (!privacyAck) return redirect('/first-run/privacy');

  const apiKeyExists = await getApiKeyExists();
  if (!apiKeyExists) return redirect('/first-run/api-key');

  return null;
}

/**
 * privacyAckGuard: requires privacyAck.
 * Used on /first-run/api-key so user can't skip the privacy notice.
 */
export async function privacyAckGuard() {
  const privacyAck = await getPrivacyAcknowledged();
  if (!privacyAck) return redirect('/first-run/privacy');
  return null;
}

/**
 * setupCompleteGuard: requires both privacyAck and apiKey.
 * Used on library, session, recording, settings routes.
 */
export async function setupCompleteGuard() {
  const privacyAck = await getPrivacyAcknowledged();
  if (!privacyAck) return redirect('/first-run/privacy');

  const apiKeyExists = await getApiKeyExists();
  if (!apiKeyExists) return redirect('/first-run/api-key');

  return null;
}
