import webpush from 'web-push';
import type { PushTransport } from '@nextdoo/db';

let configured = false;

/**
 * Production Web Push transport (PRD §6.6). Built on the standard `web-push`
 * library, which handles VAPID signing and payload encryption; the transport
 * only reports the push provider's HTTP status so the delivery engine
 * (packages/db/push-delivery.ts) owns all queue semantics.
 *
 * Returns null when VAPID is not configured — the delivery pass is then a
 * no-op (no stub fallback, mirroring mail delivery without SMTP).
 */
export function createWebPushTransport(): PushTransport | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  if (!configured) {
    // RFC 8292: the VAPID subject must be a mailto: or https: URL.
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:push@nextdoo.local', publicKey, privateKey);
    configured = true;
  }
  return {
    async send(subscription, payload) {
      const response = await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
      );
      return { statusCode: response.statusCode };
    },
  };
}
