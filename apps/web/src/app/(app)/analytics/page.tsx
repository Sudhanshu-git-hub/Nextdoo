import { notFound } from 'next/navigation';
import { AppError, uuid } from '@nextdoo/contracts';
import { loadTask } from '@/server/services/tasks';
import { requireAuth } from '@/server/auth';
import { AnalyticsView } from '@/components/views/AnalyticsView';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ taskId?: string }> }) {
  const auth = await requireAuth();
  const { taskId } = await searchParams;
  if (taskId) {
    if (!uuid.safeParse(taskId).success) notFound();
    try { await loadTask(auth.workspaceId, taskId); } catch (error) { if (error instanceof AppError && error.code === 'NOT_FOUND') notFound(); throw error; }
  }
  return <AnalyticsView key={`${auth.workspaceId}:${taskId ?? ''}`} workspaceId={auth.workspaceId} taskId={taskId} />;
}
