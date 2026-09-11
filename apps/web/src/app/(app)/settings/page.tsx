import { Suspense } from 'react';
import { requireAuth } from '@/server/auth';
import { getEntitlementSnapshot } from '@/server/services/entitlements';
import { getProfile } from '@/server/services/account-sessions';
import { SettingsView } from '@/components/views/SettingsView';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const auth = await requireAuth();
  const entitlements = await getEntitlementSnapshot(auth.userId, auth.workspaceId);
  const profile = await getProfile(auth.userId);

  return (
    /* SettingsView reads search params for the deletion-cancelled notice. */
    <Suspense fallback={<div className="skeleton" style={{ height: 320 }} />}>
      <SettingsView
        email={auth.email}
        emailVerified={auth.emailVerified}
        entitlements={entitlements}
        profile={{ name: profile.name, timeZone: profile.timeZone }}
      />
    </Suspense>
  );
}
