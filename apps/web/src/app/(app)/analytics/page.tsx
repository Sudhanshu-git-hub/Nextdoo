import { requireAuth } from '@/server/auth';
import { AnalyticsView } from '@/components/views/AnalyticsView';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const auth = await requireAuth();
  return <AnalyticsView workspaceId={auth.workspaceId} />;
}
