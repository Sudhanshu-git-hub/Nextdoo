import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) and base32 (RFC 4648) for optional MFA (PRD §6.2).
 *
 * Implemented directly rather than pulled from a dependency: the algorithm is
 * forty lines, it must be auditable, and an authentication primitive is a poor
 * place to inherit someone else's supply chain.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
/**
 * Accept the immediately preceding and following windows. One step either side
 * tolerates clock skew and a code typed as it rolls over; more than that widens
 * the replay surface for no real usability gain.
 */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  // Authenticator apps display secrets in spaced, lower-case groups; padding is optional.
  const cleaned = input.replace(/[\s=]/g, '').toUpperCase();
  if (!cleaned.length) throw new Error('Empty base32 input');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit secret, matching the SHA-1 block size recommended by RFC 4226. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226): dynamic truncation of an HMAC over the counter. */
export function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totp(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Verifies a submitted code.
 *
 * Returns the matched counter so the caller can persist it and refuse to accept
 * the same counter twice — without that, a code stays replayable for its whole
 * 30-second window.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  options: { atMs?: number; window?: number; lastUsedCounter?: number | null } = {},
): { valid: boolean; counter: number | null } {
  const { atMs = Date.now(), window = DEFAULT_WINDOW, lastUsedCounter = null } = options;

  const candidate = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return { valid: false, counter: null };

  const secret = base32Decode(secretBase32);
  const current = Math.floor(atMs / 1000 / PERIOD_SECONDS);

  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    if (!constantTimeEqual(hotp(secret, counter), candidate)) continue;
    // Correct code, but already spent — treat as a replay.
    if (lastUsedCounter !== null && counter <= lastUsedCounter) return { valid: false, counter: null };
    return { valid: true, counter };
  }
  return { valid: false, counter: null };
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** `otpauth://` URI for QR provisioning. */
export function totpUri(secretBase32: string, accountName: string, issuer = 'NEXTDOO'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Alphabet for recovery codes: base32 minus the glyphs that are misread when
 * copied off paper — O/0, I/1, S/5, B/8. 24 symbols, so ten characters still
 * carry ~46 bits, far beyond what a single-use code needs.
 */
const RECOVERY_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ2346';

/** Recovery codes for when the authenticator is lost. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes = new Set<string>();
  // A collision is vanishingly unlikely, but the caller is promised `count`
  // distinct codes, so loop until the set is full rather than assuming.
  while (codes.size < count) {
    const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomIndex(RECOVERY_ALPHABET.length)]).join('');
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return [...codes];
}

/** Rejection sampling: `% n` on a raw byte would bias toward low indices. */
function randomIndex(n: number): number {
  const limit = Math.floor(256 / n) * n;
  for (;;) {
    const byte = randomBytes(1)[0]!;
    if (byte < limit) return byte % n;
  }
}

export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
