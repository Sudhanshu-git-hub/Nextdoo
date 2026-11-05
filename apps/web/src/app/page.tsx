import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';
import { getPersonalization } from '@/server/services/personalization';
import { AuthForm } from '@/components/AuthForm';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const auth = await getAuth();
  if (!auth) return <AuthForm mode="login" />;
  redirect(auth ? (await getPersonalization(auth)).startPage : '/login');
}
