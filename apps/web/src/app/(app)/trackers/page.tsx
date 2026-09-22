import { requireAuth } from '@/server/auth';
import { TrackersView } from '@/components/views/TrackersView';
export const dynamic = 'force-dynamic';
export default async function Page() { const auth = await requireAuth(); return <TrackersView workspaceId={auth.workspaceId} />; }
