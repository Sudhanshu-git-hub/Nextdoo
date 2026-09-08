import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const auth = await getAuth();
  redirect(auth ? '/today' : '/login');
}
