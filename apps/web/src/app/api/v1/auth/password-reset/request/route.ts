import { passwordResetRequestSchema } from '@nextdoo/contracts';
import { publicRoute, parseBody } from '@/server/http';
import { requestPasswordReset } from '@/server/services/auth-tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Always returns 202, whether or not the address exists — a 404 here would let
 * anyone test which emails have accounts.
 */
export const POST = publicRoute(
  { routeName: 'auth.password_reset_request', rateLimitPerMinute: 5 },
  async (request) => {
    const input = await parseBody(request, passwordResetRequestSchema);
    await requestPasswordReset(input.email);
    return { status: 'accepted', message: 'If that address has an account, a reset link is on its way.' };
  },
);
