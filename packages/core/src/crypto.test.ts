import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateEncryptionKey } from './crypto.js';

const key = generateEncryptionKey();

describe('encrypt/decrypt', () => {
  it('round-trips a plaintext string', () => {
    const payload = encrypt('super-secret-token', key);
    expect(decrypt(payload, key)).toBe('super-secret-token');
  });

  it('round-trips an empty string', () => {
    const payload = encrypt('', key);
    expect(decrypt(payload, key)).toBe('');
  });

  it('round-trips unicode content', () => {
    const payload = encrypt('héllo wörld 🚀', key);
    expect(decrypt(payload, key)).toBe('héllo wörld 🚀');
  });

  it('produces a different ciphertext and IV on each call (random IV)', () => {
    const a = encrypt('same plaintext', key);
    const b = encrypt('same plaintext', key);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const payload = encrypt('secret', key);
    payload.ciphertext[0] = payload.ciphertext[0]! ^ 0xff;
    expect(() => decrypt(payload, key)).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const payload = encrypt('secret', key);
    payload.authTag[0] = payload.authTag[0]! ^ 0xff;
    expect(() => decrypt(payload, key)).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const payload = encrypt('secret', key);
    expect(() => decrypt(payload, generateEncryptionKey())).toThrow();
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    expect(() => encrypt('secret', Buffer.from('too-short').toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});

describe('generateEncryptionKey', () => {
  it('generates a 32-byte key encoded as base64', () => {
    const generated = generateEncryptionKey();
    expect(Buffer.from(generated, 'base64')).toHaveLength(32);
  });

  it('generates a different key each time', () => {
    expect(generateEncryptionKey()).not.toBe(generateEncryptionKey());
  });
});
