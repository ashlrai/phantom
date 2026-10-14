/**
 * src/core/util/scrub.ts — THE shared secret-scrub utility (single source of truth).
 *
 * Extracted from judge-trace.ts (stripSecrets) and extended to cover all
 * patterns previously missing from handlers.ts (scrubDiffSecrets). Since 3.10
 * the two historical duplicates delegate here instead of drifting:
 *   - src/core/generative/invent.ts   re-exports `scrubSecrets` verbatim.
 *   - src/core/knowledge/index.ts     runs this scrub FIRST, then its own
 *     stricter corpus patterns (32-hex, `/`-bearing base64, Stripe) that
 *     `ashlr verify-safety` pins by array length. Knowledge chunks are never
 *     identity-checked, so the stricter pass is safe there and must not leak
 *     into this default (see "IDENTITY CALLERS" below).
 *
 * Patterns covered by `scrubSecrets`:
 *   0. PEM/private-key blocks
 *   1. sk-  API keys (Anthropic, OpenAI, etc.)
 *   2. GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, gha_, github_pat_ (classic
 *      and fine-grained `github_pat_<22>_<59>`)
 *   3. Bearer / Token / Authorization header values
 *   4. Generic key=value secrets: api_key, secret, token, password, passwd,
 *      auth, credential, client_secret, private_key, refresh_token,
 *      access_token, connection_string (including ASHLR_* env vars)
 *   5. Slack tokens: xox[baprs]-…
 *   6. AWS access key IDs: AKIA…
 *   7. JWTs: eyJ….<sig>
 *   8. Bare hex-64 (SHA-256 / API key hex form)
 *   9. GitLab/HuggingFace/npm/Google token prefixes
 *  10. URL authority passwords and long base64 blobs
 *  11. (3.10) Telegram bot tokens `<bot id>:<33–35 chars>` — bare, in
 *      `api.telegram.org/bot<token>/…` URLs, and under any key name
 *  12. (3.10) xAI API keys `xai-…`
 *  13. (3.10) Suffix-named assignments the generic rule's `\b` anchor misses:
 *      SCREAMING env vars (`GROQ_API_KEY=…`, `DB_PASSWORD=…`), snake_case
 *      (`bot_token: …`) and camelCase (`githubToken: …`) names
 *  14. (3.10) Quoted JSON/YAML keys (`"password": "…"`, `\"botToken\":\"…\"`),
 *      which rule 4 never matched because the closing quote sits between the
 *      name and the colon
 *  15. (3.10) Slack / Discord incoming-webhook URL paths
 *  16. (3.15) Devin API credentials: `cog_…` (v3 service-user keys and
 *      personal access tokens) and legacy `apk_…` / `apk_user_…` keys
 *
 * `scrubPrivateText` layers two PRIVACY redactions on top for free text that
 * is persisted or exported (reasoning store, session export, logs):
 *   - home-directory paths → `~` (on by default)
 *   - email addresses → `[REDACTED]` (opt-in)
 *
 * IDENTITY CALLERS (why home paths/emails are NOT in `scrubSecrets`): many
 * ledgers validate values with `scrubSecrets(v) === v` (dispatch manifests,
 * worked/dispatch-production ledgers, best-of-n, generated-repair) and several
 * of those values are absolute repo paths or git author identities. Rewriting
 * `/Users/<me>/repo` → `~/repo` in the default scrub would make every such
 * record look "secret-bearing" and be rejected, and would corrupt functional
 * paths. Privacy redaction is therefore an explicit, separate call.
 *
 * IDEMPOTENCE is load-bearing: records persisted after scrubbing are later
 * re-validated with `scrubSecrets(v) === v`, and `canonicalizeProposalDiff`
 * iterates to a fixed point. Every rule's output is a fixed point of every
 * rule (pinned by test/scrub-310.test.ts).
 *
 * PURITY: no I/O, no side-effects. `scrubPrivateText` reads the home directory
 * from the environment (no filesystem access) unless `homes` is supplied.
 */

import { homedir } from 'node:os';
import { scrubSecrets, redactGenericHomePaths } from './scrub-secrets.js';
export { scrubSecrets } from './scrub-secrets.js';

const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Privacy redaction for persisted / exported free text
// ---------------------------------------------------------------------------

export interface PrivateScrubOptions {
  /** Rewrite home-directory paths to `~`. Default: true. */
  readonly homePaths?: boolean;
  /** Replace email addresses with `[REDACTED]`. Default: false (opt-in). */
  readonly emails?: boolean;
  /**
   * Home directories to collapse. Default: `os.homedir()`, `$HOME`,
   * `$USERPROFILE`. Supplied explicitly by callers that already resolved them
   * (and by tests).
   */
  readonly homes?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultHomes(): string[] {
  const out: string[] = [];
  try {
    out.push(homedir());
  } catch {
    // homedir() can throw when no home is resolvable; env fallbacks below.
  }
  if (typeof process === 'undefined') return out;
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    const v = process.env[key];
    if (v) out.push(v);
  }
  return out;
}

/**
 * Case-insensitive filesystems (macOS APFS default, Windows) name one home many
 * ways. A function, not a module-level constant: the Verse web UI imports
 * `scrubSecrets` from this module (routes/verse/cloud/cloud-model.ts), and a
 * top-level `process.platform` read throws `ReferenceError: process is not
 * defined` in the browser — which took down every lazy section that pulls the
 * cloud model in (Command, Fleet). Nothing here may touch `process` at load.
 */
function caseInsensitiveFs(): boolean {
  if (typeof process === 'undefined') return false;
  return process.platform === 'darwin' || process.platform === 'win32';
}

/**
 * Other users' home roots (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`):
 * the username is the PII, so the whole root collapses to `~` too. macOS's
 * `/Users/Shared` is a system directory, not a person.
 */


/**
 * Collapse home-directory paths to `~`. A home only matches as a whole path
 * prefix on segment boundaries: `/Users/me/x` → `~/x`; `/opt/Users/me` is left
 * alone, and `/Users/meagan` is never split into `~agan` (it is another
 * person's home, collapsed whole by the generic rule). Never throws.
 */
export function redactHomePaths(text: string, homes: readonly string[] = defaultHomes()): string {
  try {
    let out = text;
    const unique = Array.from(
      new Set(
        homes
          .map((h) => h.replace(/[\\/]+$/, ''))
          // A bare root ("/", "C:") would collapse every absolute path.
          .filter((h) => h.length > 1 && !/^[A-Za-z]:$/.test(h)),
      ),
    ).sort((a, b) => b.length - a.length);
    for (const home of unique) {
      const re = new RegExp(`(?<![\\w.-])${escapeRegExp(home)}(?![\\w.-])`, caseInsensitiveFs() ? 'gi' : 'g');
      out = out.replace(re, '~');
    }
    return redactGenericHomePaths(out);
  } catch {
    return text;
  }
}

/**
 * Email addresses in free text. `git@host:org/repo` SSH remotes are not
 * personal addresses and stay intact; `pkg@1.2.3` version pins never match
 * because the final label must be alphabetic.
 */
const EMAIL = /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;

/** Replace email addresses with `[REDACTED]`. Never throws. */
export function redactEmails(text: string): string {
  try {
    return text.replace(EMAIL, (m: string, local: string) => (local === 'git' ? m : REDACTED));
  } catch {
    return text;
  }
}

/**
 * Secrets + privacy scrub for free text that is persisted or exported
 * (reasoning steps, session exports, crash logs). Runs `scrubSecrets`, then
 * collapses home paths (default on) and, when asked, emails. Home paths are
 * collapsed on both sides of the secret scrub so a secret rule can never split
 * a home prefix into an unrecognisable remainder (same idiom as
 * `sanitizePublicJson`). Never throws. Idempotent.
 */
export function scrubPrivateText(text: string, options: PrivateScrubOptions = {}): string {
  const homePaths = options.homePaths !== false;
  const homes = homePaths ? (options.homes ?? defaultHomes()) : [];
  let out = homePaths ? redactHomePaths(text, homes) : text;
  out = scrubSecrets(out);
  if (homePaths) out = redactHomePaths(out, homes);
  if (options.emails === true) out = redactEmails(out);
  return out;
}

/** Stable bytes for proposal persistence, hashing, and provenance signing. */
export function canonicalizeProposalDiff(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = scrubSecrets(current)
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9_]{16,}\b/g, REDACTED)
      .replace(/\b(?:AKIA|ASIA|AROA)[0-9A-Z]{16}\b/g, REDACTED)
      .replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTED);
    if (next === current) return current;
    current = next;
  }
  throw new Error('proposal diff canonicalization did not converge');
}
