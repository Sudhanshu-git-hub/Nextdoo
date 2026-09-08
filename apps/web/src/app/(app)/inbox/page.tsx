import { requireAuth } from '@/server/auth';
import { InboxView } from '@/components/views/InboxView';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const auth = await requireAuth();
  return <InboxView workspaceId={auth.workspaceId} />;
}
