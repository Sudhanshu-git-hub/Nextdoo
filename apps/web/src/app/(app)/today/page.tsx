import { requireAuth } from '@/server/auth';
import { TodayView } from '@/components/views/TodayView';

export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const auth = await requireAuth();
  return <TodayView workspaceId={auth.workspaceId} />;
}
