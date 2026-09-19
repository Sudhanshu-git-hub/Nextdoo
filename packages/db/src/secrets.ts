import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets held at rest (PRD §11.4).
 *
 * Used for TOTP secrets: unlike a password they must be recoverable to verify a
 * code, so hashing is not an option. AES-256-GCM gives confidentiality plus
 * tamper detection — a modified ciphertext fails to decrypt rather than
 * yielding attacker-chosen plaintext.
 *
 * Keys are derived per purpose via HKDF, so a compromise of one derived key
 * does not extend to another use of the same AUTH_SECRET.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const TAG_BYTES = 16;
const VERSION = 'v1';

function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('nextdoo-salt'), Buffer.from(purpose), 32));
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function sealSecret(plaintext: string, secret: string, purpose = 'mfa'): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function openSecret(payload: string, secret: string, purpose = 'mfa'): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed ciphertext');
  }
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];

  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed ciphertext');
  }

  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret, purpose), iv);
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify, which is the behaviour we want.
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}
