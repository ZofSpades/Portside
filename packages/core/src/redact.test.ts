import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts a single known secret', () => {
    expect(redactSecrets('token=ghp_abc123xyz here', ['ghp_abc123xyz'])).toBe(
      'token=***REDACTED*** here',
    );
  });

  it('redacts multiple different secrets in one line', () => {
    const result = redactSecrets('DB_PASS=hunter2pass API_KEY=sk-live-9988', [
      'hunter2pass',
      'sk-live-9988',
    ]);
    expect(result).toBe('DB_PASS=***REDACTED*** API_KEY=***REDACTED***');
  });

  it('redacts every occurrence of the same secret', () => {
    expect(redactSecrets('secretvalue appears secretvalue twice', ['secretvalue'])).toBe(
      '***REDACTED*** appears ***REDACTED*** twice',
    );
  });

  it('leaves the line untouched when no secret matches', () => {
    expect(redactSecrets('npm install completed', ['some-other-secret'])).toBe(
      'npm install completed',
    );
  });

  it('skips empty-string secrets instead of corrupting every character boundary', () => {
    expect(redactSecrets('normal log line', ['', 'abc'])).toBe('normal log line');
  });

  it('skips secrets shorter than the minimum length to avoid over-redacting common text', () => {
    // A 3-character "secret" like a short PORT value would otherwise nuke
    // unrelated log text containing the same 3 characters.
    expect(redactSecrets('listening on port 8080, abc completed', ['abc'])).toBe(
      'listening on port 8080, abc completed',
    );
  });

  it('handles an empty secrets list', () => {
    expect(redactSecrets('untouched line', [])).toBe('untouched line');
  });

  it('handles secrets containing regex-special characters safely', () => {
    expect(redactSecrets('key=a.b*c(d)e', ['a.b*c(d)e'])).toBe('key=***REDACTED***');
  });
});
