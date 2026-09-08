import { requireAuth } from '@/server/auth';
import { FocusView } from '@/components/views/FocusView';

export const dynamic = 'force-dynamic';

export default async function FocusPage() {
  const auth = await requireAuth();
  return <FocusView workspaceId={auth.workspaceId} />;
}
