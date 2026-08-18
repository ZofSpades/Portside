import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { encrypt } from '@portside/core';
import { getPrismaClient } from '@portside/db';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

function webAppUrl(): string {
  const protocol = process.env.PORTSIDE_APP_PROTOCOL ?? 'http';
  const domain = process.env.PORTSIDE_BASE_DOMAIN ?? 'localhost';
  return `${protocol}://app.${domain}`;
}

function requireEncryptionKey(): string {
  const key = process.env.PORTSIDE_ENCRYPTION_KEY;
  if (!key) throw new Error('PORTSIDE_ENCRYPTION_KEY is not set');
  return key;
}

/** Fastify preHandler hook — rejects the request with 401 if there's no logged-in user. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userId = req.session.get('userId');
  if (!userId) {
    reply.code(401).send({ error: 'Not authenticated' });
  }
}

export function currentUserId(req: FastifyRequest): string {
  const userId = req.session.get('userId');
  if (!userId) throw new Error('currentUserId() called without an authenticated session');
  return userId;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/github', async (req, reply) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const callbackUrl = process.env.GITHUB_CALLBACK_URL;
    if (!clientId || !callbackUrl) {
      return reply.code(500).send({ error: 'GitHub OAuth is not configured' });
    }

    const state = randomBytes(16).toString('hex');
    req.session.set('oauthState', state);

    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);

    reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/github/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      const expectedState = req.session.get('oauthState');
      req.session.set('oauthState', undefined);

      if (error) {
        return reply.code(400).send({ error: `GitHub denied the request: ${error}` });
      }
      if (!code || !state || !expectedState || state !== expectedState) {
        return reply.code(400).send({ error: 'Invalid or missing OAuth state' });
      }

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.code(500).send({ error: 'GitHub OAuth is not configured' });
      }

      const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: process.env.GITHUB_CALLBACK_URL,
        }),
      });
      const tokenBody = (await tokenResponse.json()) as {
        access_token?: string;
        error_description?: string;
      };
      if (!tokenBody.access_token) {
        req.log.error({ tokenBody }, 'GitHub token exchange failed');
        return reply
          .code(502)
          .send({ error: tokenBody.error_description ?? 'Token exchange failed' });
      }

      const userResponse = await fetch(GITHUB_USER_URL, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: 'application/vnd.github+json',
        },
      });
      if (!userResponse.ok) {
        return reply.code(502).send({ error: 'Failed to fetch GitHub profile' });
      }
      const profile = (await userResponse.json()) as {
        id: number;
        login: string;
        avatar_url?: string;
      };

      const { ciphertext, iv, authTag } = encrypt(tokenBody.access_token, requireEncryptionKey());
      // Prisma's Bytes fields want a plain Uint8Array<ArrayBuffer>; Node's
      // Buffer type is technically backed by ArrayBufferLike (which could be
      // a SharedArrayBuffer), so TS rejects passing it directly.
      const tokenCiphertext = Uint8Array.from(ciphertext);
      const tokenIv = Uint8Array.from(iv);
      const tokenAuthTag = Uint8Array.from(authTag);

      const prisma = getPrismaClient();
      const user = await prisma.user.upsert({
        where: { githubId: String(profile.id) },
        create: {
          githubId: String(profile.id),
          login: profile.login,
          avatarUrl: profile.avatar_url,
          tokenCiphertext,
          tokenIv,
          tokenAuthTag,
        },
        update: {
          login: profile.login,
          avatarUrl: profile.avatar_url,
          tokenCiphertext,
          tokenIv,
          tokenAuthTag,
        },
      });

      req.session.set('userId', user.id);
      reply.redirect(webAppUrl());
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    req.session.delete();
    reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const prisma = getPrismaClient();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: currentUserId(req) } });
    return { id: user.id, login: user.login, avatarUrl: user.avatarUrl };
  });
}
