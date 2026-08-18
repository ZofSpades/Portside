import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function loadKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `PORTSIDE_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes, got ${key.length}`,
    );
  }
  return key;
}

/** Encrypts a UTF-8 string with AES-256-GCM using a fresh random IV per call. */
export function encrypt(plaintext: string, base64Key: string): EncryptedPayload {
  const key = loadKey(base64Key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/** Decrypts a payload produced by encrypt(). Throws if the auth tag doesn't verify. */
export function decrypt(payload: EncryptedPayload, base64Key: string): string {
  const key = loadKey(base64Key);
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Generates a fresh base64-encoded 32-byte key, suitable for PORTSIDE_ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('base64');
}
