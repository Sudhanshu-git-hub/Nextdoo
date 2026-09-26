import { requireAuth } from '@/server/auth';
import { getProfile } from '@/server/services/account-sessions';
import { HomeView } from '@/components/views/HomeView';
export const dynamic = 'force-dynamic';
export default async function HomePage() { const auth = await requireAuth(); const profile = await getProfile(auth.userId); return <HomeView name={profile.name}/>; }
