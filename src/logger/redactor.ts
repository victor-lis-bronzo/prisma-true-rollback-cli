/**
 * Credential Redactor for the Prisma True Rollback CLI.
 *
 * The Redactor is the single mechanism that scrubs sensitive connection
 * information from any text before it is written to stdout/stderr. The Logger
 * (Task 3.2) routes every message through {@link Redactor.redact} so redaction
 * cannot be bypassed by a caller.
 *
 * It removes, for arbitrary carrier text:
 *   - full DATABASE_URL connection strings (postgresql://, mysql://, file:/sqlite),
 *   - the username, password, host, and port embedded in such URLs,
 *   - credentials that appear inline (e.g. `user:pass@host:port` fragments),
 *   - credentials passed via query parameters (`?user=...&password=...`).
 *
 * Every removed value is replaced with a single, fixed placeholder so callers
 * (and the property test in Task 3.3) can assert both that raw values are gone
 * and that the placeholder is present.
 *
 * Design reference: design.md §10 "Logger / Redactor", Correctness Property 4
 * ("Credentials never appear in output"). Requirements 8.4, 8.5.
 */

/**
 * The single, fixed redaction placeholder substituted for every sensitive
 * value. Exported so tests and the Logger can reference it directly.
 */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * The Redactor interface (mirrors design.md §10). Replaces the DATABASE_URL
 * value, username, password, host, and port with {@link REDACTION_PLACEHOLDER}.
 */
export interface Redactor {
  /**
   * Returns `text` with every recognized credential/connection value replaced
   * by {@link REDACTION_PLACEHOLDER}.
   */
  redact(text: string): string;
}

/**
 * Connection-URL schemes the CLI supports, per the resolved `DbEngine` set
 * (postgresql, mysql, sqlite). `postgres` is accepted as an alias Prisma also
 * emits for PostgreSQL.
 */
const NETWORK_URL_SCHEMES = ['postgresql', 'postgres', 'mysql'] as const;
const FILE_URL_SCHEMES = ['file', 'sqlite'] as const;

/**
 * Matches a full network connection URL for a supported engine, e.g.
 *   postgresql://user:pass@host:5432/db?schema=public&connection_limit=5
 *   mysql://root@localhost/app
 * The whole URL (scheme through the end of the authority/path/query, up to the
 * first whitespace) is replaced wholesale so no credential fragment survives.
 */
const NETWORK_URL_RE = new RegExp(
  `\\b(?:${NETWORK_URL_SCHEMES.join('|')})://\\S+`,
  'gi',
);

/**
 * Matches a SQLite / file connection URL, e.g. `file:./dev.db` or
 * `sqlite:/var/data/app.sqlite`. These carry no credentials but are the
 * DATABASE_URL value and are redacted per Requirement 8.5.
 */
const FILE_URL_RE = new RegExp(
  `\\b(?:${FILE_URL_SCHEMES.join('|')}):(?://)?\\S+`,
  'gi',
);

/**
 * Matches inline `user:password@host` (optionally `:port`) credential
 * fragments that appear WITHOUT a URL scheme in front of them, e.g. a log line
 * that prints just `admin:s3cret@db.internal:5432`. Requires an `@` so we do
 * not clobber ordinary `key:value` text. The leading boundary avoids eating a
 * scheme that was already handled by {@link NETWORK_URL_RE}.
 */
const INLINE_CREDENTIALS_RE =
  /(?<![A-Za-z0-9+.-]:\/\/)\b[A-Za-z0-9._%+-]+:[^\s:@/]+@[A-Za-z0-9._-]+(?::\d+)?/g;

/**
 * Matches credential-bearing query parameters that may leak on their own, e.g.
 * `?user=root&password=hunter2` — the value portion of user/password/host/port
 * (and common aliases) is replaced while the key is preserved for readability.
 */
const QUERY_PARAM_CREDENTIAL_RE =
  /\b(user|username|password|pwd|host|hostname|port)=([^\s&"'#]+)/gi;

/**
 * Default {@link Redactor} implementation. Stateless and reusable; a single
 * shared instance is exported as {@link redactor}.
 */
export class DefaultRedactor implements Redactor {
  redact(text: string): string {
    if (!text) {
      return text;
    }

    let out = text;

    // 1. Full network connection URLs (scheme://user:pass@host:port/db?...).
    //    Replaced wholesale so username, password, host, and port all vanish.
    out = out.replace(NETWORK_URL_RE, REDACTION_PLACEHOLDER);

    // 2. Full file/sqlite connection URLs (the DATABASE_URL value itself).
    out = out.replace(FILE_URL_RE, REDACTION_PLACEHOLDER);

    // 3. Inline user:pass@host[:port] fragments without a scheme prefix.
    out = out.replace(INLINE_CREDENTIALS_RE, REDACTION_PLACEHOLDER);

    // 4. Credential-bearing query params emitted in isolation.
    out = out.replace(
      QUERY_PARAM_CREDENTIAL_RE,
      (_match, key: string) => `${key}=${REDACTION_PLACEHOLDER}`,
    );

    return out;
  }
}

/**
 * Shared, ready-to-use redactor instance for the Logger and other callers.
 */
export const redactor: Redactor = new DefaultRedactor();

/**
 * Convenience free function equivalent to `redactor.redact(text)`.
 */
export function redact(text: string): string {
  return redactor.redact(text);
}
