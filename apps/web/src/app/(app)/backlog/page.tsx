import { requireAuth } from '@/server/auth';
import { DailyTasksView } from '@/components/views/DailyTasksView';
export const dynamic = 'force-dynamic';
export default async function Page() { const auth = await requireAuth(); return <DailyTasksView workspaceId={auth.workspaceId} view="backlog"/>; }
