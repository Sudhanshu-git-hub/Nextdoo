import { Suspense } from 'react';
import { requireAuth } from '@/server/auth';
import { getEntitlementSnapshot } from '@/server/services/entitlements';
import { getProfile } from '@/server/services/account-sessions';
import { SettingsView } from '@/components/views/SettingsView';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const auth = await requireAuth();
  const entitlements = await getEntitlementSnapshot(auth.userId, auth.workspaceId);
  // A transient profile read must not 500 the whole settings page: the auth
  // context already carries the session-joined time zone, so fall back to it.
  let profile: { name: string | null; timeZone: string };
  try {
    const p = await getProfile(auth.userId);
    profile = { name: p.name, timeZone: p.timeZone };
  } catch {
    profile = { name: null, timeZone: auth.timeZone };
  }

  return (
    /* SettingsView reads search params for the deletion-cancelled notice. */
    <Suspense fallback={<div className="skeleton" style={{ height: 320 }} />}>
      <SettingsView
        email={auth.email}
        emailVerified={auth.emailVerified}
        entitlements={entitlements}
        profile={profile}
      />
    </Suspense>
  );
}
