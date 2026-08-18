const PLACEHOLDER = '***REDACTED***';
// Redacting anything shorter than this would nuke normal log text (common
// short env var values, single characters, etc.) for no real security gain.
const MIN_SECRET_LENGTH = 4;

/**
 * Replaces every occurrence of any given secret value in a log line with a
 * placeholder. Applied at the point logs are emitted to the stream — every
 * decrypted env var value and any GitHub token used for cloning must be
 * redacted here before a line ever reaches Redis, storage, or the UI.
 */
export function redactSecrets(line: string, secrets: readonly string[]): string {
  let result = line;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    result = result.split(secret).join(PLACEHOLDER);
  }
  return result;
}
