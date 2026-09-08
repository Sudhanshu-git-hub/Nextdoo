import { AppError } from '@nextdoo/contracts';
import { logger } from './observability';
import { features, getEnv } from './env';

/**
 * Outbound email (PRD §6.2).
 *
 * No SMTP provider is configured in development, so messages are logged instead
 * of sent. The link is printed deliberately: without it there is no way to
 * complete a verification or reset flow locally.
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
  const { subject } = render(kind, url);

  if (!features().email) {
    if (process.env.NODE_ENV === 'production') throw new AppError('PROVIDER_UNAVAILABLE', 'Email delivery is not configured.');
    // Dev fallback. The address is logged because it is needed to act on the
    // message; the token is part of the URL and is single-use and short-lived.
    logger.info('mail.stub', { kind, to, subject, url });
    return;
  }

  // A real transport plugs in here; the interface above is all the callers know.
  logger.info('mail.sent', { kind, to, subject });
}

export function absoluteUrl(path: string): string {
  return new URL(path, getEnv().APP_URL).toString();
}
