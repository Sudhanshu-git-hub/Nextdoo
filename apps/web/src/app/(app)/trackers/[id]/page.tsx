import { requireAuth } from '@/server/auth';
import { TrackerDetailView } from '@/components/views/TrackersView';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(), { id } = await params;
  return <TrackerDetailView key={id} workspaceId={auth.workspaceId} id={id} />;
}
