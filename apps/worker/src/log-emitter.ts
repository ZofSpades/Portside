import { LOG_STREAM_FIELD, LOG_STREAM_MAXLEN, logStreamKey, redactSecrets } from '@portside/core';
import type { Redis } from 'ioredis';

/**
 * Writes redacted log lines to a deployment's Redis Stream as they happen,
 * and keeps the full (redacted) text in memory to flush to storage once the
 * deployment finishes. Every line — build output and pipeline stage
 * markers alike — passes through the same redaction before anything is
 * written, so there's exactly one place secrets could leak from.
 */
export class LogEmitter {
  private readonly lines: string[] = [];
  private readonly key: string;

  constructor(
    private readonly redis: Redis,
    deploymentId: string,
    private readonly secrets: readonly string[],
  ) {
    this.key = logStreamKey(deploymentId);
  }

  async emit(line: string): Promise<void> {
    const redacted = redactSecrets(line, this.secrets);
    this.lines.push(redacted);
    await this.redis.xadd(
      this.key,
      'MAXLEN',
      '~',
      String(LOG_STREAM_MAXLEN),
      '*',
      LOG_STREAM_FIELD,
      redacted,
    );
  }

  fullLog(): string {
    return this.lines.join('\n');
  }
}
