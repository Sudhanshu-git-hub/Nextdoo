import { authedRoute } from '@/server/http';
import { startMfaEnrolment } from '@/server/services/mfa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns the secret and otpauth URI. MFA is not active until /mfa/confirm
 * proves the user can generate a code from it.
 */
export const POST = authedRoute({ routeName: 'auth.mfa_enrol', rateLimitPerMinute: 10 }, async (_r, ctx) =>
  startMfaEnrolment(ctx.auth.userId),
);
