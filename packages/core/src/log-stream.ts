/**
 * Naming and framing shared between the worker (writer) and the API (SSE
 * reader) for a deployment's Redis Stream log. Kept dependency-free (no
 * ioredis here) so both sides import the same constants without either
 * pulling in a Redis client transitively.
 */

export function logStreamKey(deploymentId: string): string {
  return `portside:logs:${deploymentId}`;
}

/** Approximate cap on stream length — trims old entries once a deploy's build log gets huge. */
export const LOG_STREAM_MAXLEN = 10_000;

/** How long a finished deployment's stream survives before Redis reclaims it. */
export const LOG_STREAM_TTL_SECONDS = 60 * 60 * 24;

/** The single field name each stream entry stores its log line under. */
export const LOG_STREAM_FIELD = 'line';
