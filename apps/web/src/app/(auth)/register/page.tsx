import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';
import { AuthForm } from '@/components/AuthForm';

export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  if (await getAuth()) redirect('/today');
  return <AuthForm mode="register" />;
}
