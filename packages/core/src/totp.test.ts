import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  normaliseRecoveryCode,
  totp,
  totpUri,
  verifyTotp,
} from './totp';

describe('base32', () => {
  // RFC 4648 §10 test vectors.
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(vectors)('encodes %o as %s', (input, expected) => {
    expect(base32Encode(Buffer.from(input, 'utf8'))).toBe(expected);
  });

  it.each(vectors.slice(1))('decodes %o back from %s', (expected, encoded) => {
    expect(base32Decode(encoded).toString('utf8')).toBe(expected);
  });

  it('round-trips arbitrary bytes', () => {
    for (let length = 1; length <= 32; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it('tolerates the spacing, padding and case that authenticator apps display', () => {
    expect(base32Decode('mzxw 6ytb oi==')).toEqual(base32Decode('MZXW6YTBOI'));
  });

  it('rejects characters outside the alphabet rather than guessing', () => {
    expect(() => base32Decode('MZXW6YTB01')).toThrow(/invalid base32/i);
  });

  it('rejects empty input', () => {
    expect(() => base32Decode('   ')).toThrow(/empty/i);
  });
});

describe('HOTP (RFC 4226 Appendix D vectors)', () => {
  const secret = Buffer.from('12345678901234567890', 'utf8');
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  it.each(expected.map((code, counter) => [counter, code]))('counter %i produces %s', (counter, code) => {
    expect(hotp(secret, counter as number)).toBe(code);
  });
});

describe('TOTP (RFC 6238 Appendix B vectors, SHA-1)', () => {
  // The RFC's ASCII seed, expressed in base32 as an authenticator app would store it.
  const secret = base32Encode(Buffer.from('12345678901234567890', 'utf8'));

  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  it.each(vectors)('at unix time %i produces %s', (seconds, code) => {
    expect(totp(secret, seconds * 1000)).toBe(code);
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  it('accepts the current code', () => {
    const result = verifyTotp(secret, totp(secret, now), { atMs: now });
    expect(result.valid).toBe(true);
    expect(result.counter).toBe(Math.floor(now / 1000 / 30));
  });

  it('accepts one step either side to absorb clock skew', () => {
    for (const shift of [-30_000, 30_000]) {
      expect(verifyTotp(secret, totp(secret, now + shift), { atMs: now }).valid).toBe(true);
    }
  });

  it('rejects codes beyond the accepted window', () => {
    for (const shift of [-90_000, 90_000]) {
      expect(verifyTotp(secret, totp(secret, now + shift), { atMs: now }).valid).toBe(false);
    }
  });

  it('rejects a code already spent, so it cannot be replayed within its window', () => {
    const code = totp(secret, now);
    const first = verifyTotp(secret, code, { atMs: now });
    expect(first.valid).toBe(true);

    const replay = verifyTotp(secret, code, { atMs: now, lastUsedCounter: first.counter });
    expect(replay.valid).toBe(false);
  });

  it('still accepts the next counter after one has been spent', () => {
    const first = verifyTotp(secret, totp(secret, now), { atMs: now });
    const later = now + 30_000;
    expect(verifyTotp(secret, totp(secret, later), { atMs: later, lastUsedCounter: first.counter }).valid).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(secret, bad, { atMs: now }).valid).toBe(false);
    }
  });

  it('ignores whitespace inside an otherwise valid code', () => {
    const code = totp(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { atMs: now }).valid).toBe(true);
  });

  it('rejects a valid code from a different secret', () => {
    const other = generateTotpSecret();
    expect(verifyTotp(secret, totp(other, now), { atMs: now }).valid).toBe(false);
  });

  it('never returns a counter when invalid', () => {
    expect(verifyTotp(secret, '000000', { atMs: now, window: 0 }).counter).toBeNull();
  });
});

describe('secret and provisioning', () => {
  it('generates 160-bit secrets', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('generates a distinct secret each time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(50);
  });

  it('builds an otpauth URI a scanner can consume', () => {
    const secret = generateTotpSecret();
    const uri = totpUri(secret, 'user@example.com');
    const url = new URL(uri);

    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe(secret);
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
    // The label must stay escaped so an address containing ':' cannot break parsing.
    expect(uri).toContain('NEXTDOO:user%40example.com');
  });
});

describe('recovery codes', () => {
  it('generates the requested number of unique codes', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('avoids glyphs that are easy to mistype off paper', () => {
    for (const code of generateRecoveryCodes(40)) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      // Glyphs that are routinely misread when a code is copied off paper.
      expect(code).not.toMatch(/[OISB01578]/);
    }
  });

  it('normalises the formatting a user is likely to type', () => {
    expect(normaliseRecoveryCode('abcde-fghij')).toBe('ABCDEFGHIJ');
    expect(normaliseRecoveryCode(' ABCDE FGHIJ ')).toBe('ABCDEFGHIJ');
  });
});
