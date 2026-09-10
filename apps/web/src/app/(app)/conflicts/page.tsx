import { requireAuth } from '@/server/auth';
import { ConflictsView } from '@/components/views/ConflictsView';

export const dynamic = 'force-dynamic';

/**
 * Conflict resolution (PRD §8.6/§10.6): side-by-side local vs server values
 * with the choose action, plus this device's quarantined changes.
 */
export default async function ConflictsPage() {
  await requireAuth();
  return <ConflictsView />;
}
