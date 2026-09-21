import { sealSecret, openSecret } from '@nextdoo/db';
import { getEnv } from './env';

export const encryptSecret = (plaintext: string, purpose = 'mfa') => sealSecret(plaintext, getEnv().AUTH_SECRET, purpose);
export const decryptSecret = (ciphertext: string, purpose = 'mfa') => openSecret(ciphertext, getEnv().AUTH_SECRET, purpose);
