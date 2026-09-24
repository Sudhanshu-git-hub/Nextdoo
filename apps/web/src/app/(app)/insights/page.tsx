import { requireAuth } from '@/server/auth';
import { InsightsView } from '@/components/views/InsightsView';
export const dynamic='force-dynamic';
export default async function InsightsPage(){const auth=await requireAuth();return <InsightsView key={auth.workspaceId} />;}
