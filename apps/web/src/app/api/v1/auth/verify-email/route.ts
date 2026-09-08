import { emailVerificationSchema } from '@nextdoo/contracts';
import { authedRoute, publicRoute, parseBody } from '@/server/http';
import { requestEmailVerification, verifyEmail } from '@/server/services/auth-tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Consumes a verification token. Public: the user may not be signed in yet. */
export const POST = publicRoute({ routeName: 'auth.verify_email', rateLimitPerMinute: 20 }, async (request) => {
  const input = await parseBody(request, emailVerificationSchema);
  await verifyEmail(input.token);
  return { status: 'ok', message: 'Your email address has been confirmed.' };
});

/** Re-sends the verification email to the signed-in user. */
export const PUT = authedRoute({ routeName: 'auth.verify_email_resend', rateLimitPerMinute: 3 }, async (_r, ctx) => {
  await requestEmailVerification(ctx.auth.userId, ctx.auth.email);
  return { status: 'accepted' };
});
