import { scryptSync } from 'node:crypto';
import secureSession from '@fastify/secure-session';
import type { FastifyInstance } from 'fastify';

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string;
    oauthState?: string;
  }
}

/**
 * Derives a stable 32-byte session-signing key from SESSION_SECRET so
 * sessions survive API restarts without storing the raw key anywhere.
 */
function deriveSessionKey(secret: string): Buffer {
  return scryptSync(secret, 'portside-session-salt', 32);
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('SESSION_SECRET must be set to a string of at least 16 characters');
  }

  await app.register(secureSession, {
    key: deriveSessionKey(secret),
    cookieName: 'portside_session',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    },
  });
}
