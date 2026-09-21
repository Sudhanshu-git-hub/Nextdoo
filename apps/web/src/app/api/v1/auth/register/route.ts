import { registerSchema } from '@nextdoo/contracts';
import { createSession, hashPassword, setSessionCookie } from '@/server/auth';
import { publicRoute, parseBody } from '@/server/http';
import { registerUser } from '@/server/services/accounts';
import { requestEmailVerification } from '@/server/services/auth-tokens';
import { logger } from '@/server/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = publicRoute({ routeName: 'auth.register', rateLimitPerMinute: 10 }, async (request) => {
  const input = await parseBody(request, registerSchema);
  const user = await registerUser({
    email: input.email,
    passwordHash: await hashPassword(input.password),
    name: input.name ?? null,
    timeZone: input.timeZone,
  });
  const token = await createSession(user.id, 'web');
  await setSessionCookie(token);

  // The account is usable straight away; verification is a follow-up, so a mail
  // failure must not fail the registration the user just completed.
  try {
    await requestEmailVerification(user.id, user.email);
  } catch (error) {
    logger.error('register.verification_email_failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  return { id: user.id, email: user.email, workspaceId: user.workspaceId, emailVerified: false };
});
