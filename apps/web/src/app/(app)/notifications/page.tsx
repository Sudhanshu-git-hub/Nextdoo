import { notFound } from 'next/navigation';
import { AppError, uuid } from '@nextdoo/contracts';
import { requireAuth } from '@/server/auth';
import { loadTask, serialiseTask } from '@/server/services/tasks';
import { NotificationsView } from '@/components/views/NotificationsView';
export const dynamic = 'force-dynamic';
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ taskId?: string }> }) {
 const auth = await requireAuth(), { taskId } = await searchParams;
 let task = null;
 if (taskId) {
  const parsed = uuid.safeParse(taskId); if (!parsed.success) notFound();
  try { task = serialiseTask(await loadTask(auth.workspaceId, parsed.data)); } catch (error) { if (error instanceof AppError && error.code === 'NOT_FOUND') notFound(); throw error; }
 }
 return <NotificationsView key={`${auth.workspaceId}:${taskId ?? ''}`} initialTask={task} />;
}
