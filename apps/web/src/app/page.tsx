import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';
import { getPersonalization } from '@/server/services/personalization';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const auth = await getAuth();
  redirect(auth ? (await getPersonalization(auth)).startPage : '/login');
}
