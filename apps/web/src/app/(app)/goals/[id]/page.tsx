import { requireAuth } from '@/server/auth';
import { GoalDetailView } from '@/components/views/GoalsView';
export const dynamic = 'force-dynamic';
export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  const { id } = await params;
  return <GoalDetailView key={id} workspaceId={auth.workspaceId} goalId={id} />;
}
