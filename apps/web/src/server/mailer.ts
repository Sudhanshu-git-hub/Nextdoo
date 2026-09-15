import { eq, sql } from 'drizzle-orm';
import { sealSecret, users } from '@nextdoo/db';
import { getDb } from './db';
import { newId } from './ids';
import { AppError } from '@nextdoo/contracts';
import { logger } from './observability';
import { features, getEnv } from './env';

/**
 * Outbound email (PRD §6.2).
 *
 * Configured SMTP is queued durably and encrypted; the worker delivers it.
 * Without SMTP, only development/test may log a local link. Production fails
 * explicitly; it never logs credential URLs or claims provider delivery.
 *
 * Subjects and bodies never contain task content — only the action being
 * confirmed.
 */

export type MailKind = 'verify-email' | 'reset-password' | 'password-changed' | 'account-deletion';

interface Mail {
  to: string;
  subject: string;
  text: string;
}

function render(kind: MailKind, url: string | null): Mail['subject'] extends never ? never : Omit<Mail, 'to'> {
  switch (kind) {
    case 'verify-email':
      return {
        subject: 'Confirm your NEXTDOO email address',
        text: `Confirm your email address to finish setting up your account:\n\n${url}\n\nThe link expires in 24 hours. If you did not create an account, ignore this message.`,
      };
    case 'reset-password':
      return {
        subject: 'Reset your NEXTDOO password',
        text: `Use this link to choose a new password:\n\n${url}\n\nThe link expires in 30 minutes and can be used once. If you did not request this, ignore this message — your password has not changed.`,
      };
    case 'password-changed':
      return {
        subject: 'Your NEXTDOO password was changed',
        text: 'Your password was changed and every other session was signed out.\n\nIf this was not you, reset your password immediately.',
      };
    case 'account-deletion':
      return {
        subject: 'Your NEXTDOO account is scheduled for deletion',
        text: `Your account is scheduled for permanent deletion in 30 days. Sign in before then to cancel.\n\n${url ?? ''}`,
      };
  }
}

export async function sendMail(kind: MailKind, to: string, url: string | null = null): Promise<void> {
  const { subject, text } = render(kind, url);

  if (!features().email) {
    if (process.env.NODE_ENV === 'production') throw new AppError('PROVIDER_UNAVAILABLE', 'Email delivery is not configured.');
    // Dev fallback. The address is logged because it is needed to act on the
    // message; the token is part of the URL and is single-use and short-lived.
    logger.info('mail.stub', { kind, to, subject, url });
    return;
  }

  const env = getEnv();
  const [owner] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, to.toLowerCase()));
  const id = newId();
  const message = sealSecret(JSON.stringify({ to, from: env.MAIL_FROM, subject, text, url }), env.AUTH_SECRET, 'mail');
  const expiresAt = new Date(Date.now() + (kind === 'reset-password' ? 30 * 60000 : 24 * 3600000));
  await getDb().execute(sql`insert into mail_deliveries(id,user_id,kind,encrypted_message,expires_at)
    values(${id},${owner?.id ?? null},${kind},${message},${expiresAt.toISOString()}::timestamptz)`);
  logger.info('mail.queued', { deliveryId: id, kind });

}

export function absoluteUrl(path: string): string {
  return new URL(path, getEnv().APP_URL).toString();
}
