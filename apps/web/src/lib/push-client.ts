import { api } from '@/lib/api';

/**
 * M8-i1 (PRD §6.6): browser push client helper.
 *
 * Every capability check degrades cleanly: unsupported browsers, denied
 * permissions and unconfigured deployments all report a reason instead of
 * throwing, and no permission prompt is ever requested without an explicit
 * user action (the page only calls `requestPermission()` inside a click).
 */

export type PushSupport =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'supported' };

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return { kind: 'unsupported', reason: 'no-window' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { kind: 'unsupported', reason: 'missing-api' };
  }
  return { kind: 'supported' };
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** Registers /sw.js (idempotent). Fails soft in unsupported contexts. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (pushSupport().kind !== 'supported') return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

/**
 * Subscribes the browser to Web Push for the given VAPID public key and
 * registers the subscription with the server. Only called from an explicit
 * user action (button click), which also triggers the permission prompt.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<{ ok: boolean; total: number }> {
  const support = pushSupport();
  if (support.kind !== 'supported') return { ok: false, total: 0 };
  const permission = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission);
  if (permission !== 'granted') return { ok: false, total: 0 };
  const registration = (await navigator.serviceWorker.getRegistration().catch(() => null)) ?? (await registerServiceWorker());
  if (!registration) return { ok: false, total: 0 };
  let subscription: PushSubscription | null = null;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  } catch {
    return { ok: false, total: 0 };
  }
  if (!subscription) return { ok: false, total: 0 };
  try {
    const result = await api<{ created: boolean; total: number }>('/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription.toJSON()),
    });
    return { ok: true, total: result.total };
  } catch {
    return { ok: false, total: 0 };
  }
}

/** Unsubscribes this browser and removes the registration server-side. */
export async function unsubscribeFromPush(): Promise<boolean> {
  if (pushSupport().kind !== 'supported') return false;
  const registration = await navigator.serviceWorker.getRegistration().catch(() => null);
  if (!registration) return false;
  const subscription = await registration.pushManager.getSubscription().catch(() => null);
  if (!subscription) return true;
  let removed = false;
  try {
    await api<{ removed: boolean }>('/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    removed = true;
  } catch {
    removed = false;
  }
  await subscription.unsubscribe().catch(() => undefined);
  return removed;
}

export async function fetchPushStatus(): Promise<{
  configured: boolean;
  total: number;
  endpoints: string[];
  permission: NotificationPermission | 'unsupported';
}> {
  const support = pushSupport();
  const permission = support.kind === 'supported' ? Notification.permission : 'unsupported';
  let configured = false;
  try {
    await api<{ vapidPublicKey: string }>('/push/public-key');
    configured = true;
  } catch {
    configured = false;
  }
  let total = 0;
  let endpoints:string[]=[];
  if (configured) {
    try {
      const body = await api<{ data: Array<{ endpoint: string }> }>('/push/subscriptions');
      total = body.data.length;
      endpoints=body.data.map(row=>row.endpoint);
    } catch {
      total = 0;
    }
  }
  return { configured, total, endpoints, permission };
}
