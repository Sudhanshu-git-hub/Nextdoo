import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';
import { Sidebar } from '@/components/Sidebar';
import { OfflineBadge } from '@/components/OfflineBadge';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await getAuth();
  if (!auth) redirect('/login');

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to main content</a>
      <Sidebar />
      <main className="main" id="main" tabIndex={-1}>{children}</main>
      <OfflineBadge />
    </div>
  );
}
