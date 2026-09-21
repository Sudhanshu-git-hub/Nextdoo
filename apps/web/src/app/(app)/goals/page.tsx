import { requireAuth } from '@/server/auth';
import { GoalsView } from '@/components/views/GoalsView';
export const dynamic = 'force-dynamic';
export default async function GoalsPage() {
  const auth = await requireAuth();
  return <GoalsView workspaceId={auth.workspaceId} />;
}
