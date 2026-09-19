import { requireAuth } from '@/server/auth';
import { TaskHistoryView } from '@/components/views/TaskHistoryView';
export const dynamic = 'force-dynamic';
export default async function TaskHistoryPage() {
 const auth = await requireAuth();
 return <TaskHistoryView workspaceId={auth.workspaceId} />;
}
