import { passwordResetConfirmSchema } from '@nextdoo/contracts';
import { publicRoute, parseBody } from '@/server/http';
import { resetPassword } from '@/server/services/auth-tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = publicRoute(
  { routeName: 'auth.password_reset_confirm', rateLimitPerMinute: 10 },
  async (request) => {
    const input = await parseBody(request, passwordResetConfirmSchema);
    await resetPassword(input.token, input.password);
    return { status: 'ok', message: 'Your password has been changed and all sessions were signed out.' };
  },
);
