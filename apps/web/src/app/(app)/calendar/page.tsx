import { requireAuth } from '@/server/auth';
import { CalendarView } from '@/components/views/CalendarView';

export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const auth = await requireAuth();
  return <CalendarView workspaceId={auth.workspaceId} />;
}
