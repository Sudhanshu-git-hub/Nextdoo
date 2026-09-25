import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';
import { Sidebar } from '@/components/Sidebar';
import { loadWorkspaceSettings } from '@/server/services/workspaces';
import { WorkspaceProvider } from '@/components/WorkspaceContext';
import { OfflineBadge } from '@/components/OfflineBadge';
import { getPersonalization } from '@/server/services/personalization';
import { PersonalizationProvider } from '@/components/PersonalizationContext';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuth();
  if (!auth) redirect('/login');
  const workspace = await loadWorkspaceSettings(auth.workspaceId, auth.workspaceId);
  const preferences=await getPersonalization(auth);

  return (
    <PersonalizationProvider key={auth.workspaceId} initial={preferences}><WorkspaceProvider value={workspace}><div className="app">
      <a className="skip-link" href="#main">Skip to main content</a>
      <Sidebar />
      <main className="main" id="main" tabIndex={-1}>{children}</main>
      <OfflineBadge workspaceId={auth.workspaceId} />
    </div></WorkspaceProvider></PersonalizationProvider>
  );
}
