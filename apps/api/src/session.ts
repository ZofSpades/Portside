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
      // The dashboard (app.<domain>) and the API (api.<domain>) are
      // different hosts, and critically different *sites* by the browser's
      // own reckoning — "localhost" isn't on the public suffix list, so
      // "app.localhost" and "api.localhost" are each their own eTLD+1, not
      // subdomains of a shared site. A `lax` cookie is therefore withheld
      // from every cross-origin fetch the dashboard makes to the API (it
      // still gets set on login, it just never gets sent back), so this has
      // to be `none`. That requires `Secure`, which still works over plain
      // `http://*.localhost` in every modern browser — they special-case
      // localhost as a secure context precisely for this kind of local dev
      // setup — and is exactly what a real deployment needs anyway once
      // it's behind real TLS (see docs/RUNBOOK.md).
      sameSite: 'none',
      secure: true,
      maxAge: 60 * 60 * 24 * 30, // 30 days
    },
  });
}
