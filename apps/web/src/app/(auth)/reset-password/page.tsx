import { ResetPasswordForm } from '@/components/ResetPasswordForm';

export const dynamic = 'force-dynamic';

/** The token arrives in the emailed link's query string. */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token ?? null} />;
}
