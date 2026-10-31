/** Pure shared secret and generic home-path redaction for Node and browser callers. */
const REDACTED = '[REDACTED]';

function scrubLongBase64Like(match: string): string {
  // Preserve ordinary Git SHA-1 commit ids for forensic audit trails. The
  // explicit hex-64 rule above still redacts longer raw-key shapes.
  if (/^[0-9a-fA-F]{40}$/.test(match)) return match;
  // Avoid erasing obvious low-entropy test/log filler such as xxxxx...; real
  // token-like blobs still have mixed character content and are redacted below.
  const repeatedCandidate = match.replace(/^\+/, '').replace(/=+$/, '');
  if (/^(.)\1{39,}$/.test(repeatedCandidate)) return match;
  return REDACTED;
}

// ---------------------------------------------------------------------------
// 3.10 additions
// ---------------------------------------------------------------------------

/**
 * Telegram bot token: numeric bot id (8–10 digits today; 6–12 tolerated) +
 * ':' + a 33–35 char url-safe secret (35 for issued tokens; Telegram's own
 * documentation example is 34). The optional `bot` prefix covers the Bot API
 * URL form (`https://api.telegram.org/bot<id>:<secret>/sendMessage`), where a
 * plain `\b` anchor fails because `t` and the first digit are both word chars.
 * The narrow secret length plus the non-word lookarounds keep
 * `<epoch-seconds>:<uuid|hex32|sha1>` style ids (36 / 32 / 40 chars) intact —
 * several ledgers identity-check such ids.
 */
const TELEGRAM_BOT_TOKEN = /\d{6,12}:[A-Za-z0-9_-]{33,35}(?![A-Za-z0-9_-])/g;

/**
 * Left-boundary check for a Telegram candidate, done in the replacer instead of
 * a leading lookbehind: a regex that starts with `\d` lets V8 skip ahead to
 * digits, which measured ~3x cheaper on 1 MB of prose than testing a
 * lookbehind at every offset. Accept when the id starts the string, follows a
 * non-word char, or follows a `bot` that itself follows a non-word char.
 */
function redactTelegram(match: string, offset: number, whole: string): string {
  const boundary = (i: number): boolean => i < 0 || !/[A-Za-z0-9_]/.test(whole[i]!);
  if (boundary(offset - 1)) return REDACTED;
  if (whole.slice(offset - 3, offset) === 'bot' && boundary(offset - 4)) return REDACTED;
  return match;
}

/**
 * Incoming-webhook URLs are bearer credentials in their path (anyone holding
 * the URL can post). Host + fixed path prefix are kept for forensics.
 */
const WEBHOOK_URL =
  /(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks)\/)[A-Za-z0-9_/-]{8,}/gi;

/**
 * Devin (Cognition) API credentials. v3 keys and PATs are `cog_…`
 * (https://docs.devin.ai/api-reference/authentication); legacy v1/v2 keys are
 * `apk_user_…` / `apk_…`. The legacy tail is alphanumeric-only so an
 * identifier such as `apk_version_code` is not mistaken for a key.
 */
const DEVIN_API_KEY = /(?<![A-Za-z0-9_-])(?:cog_[A-Za-z0-9_-]{20,}|apk_(?:user_)?[A-Za-z0-9]{24,})/g;

/** xAI (Grok) API keys: `xai-` + ≥20 alphanumerics (80 in practice). */
const XAI_API_KEY = /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{20,}/g;

/**
 * Value shape shared by the suffix-name rules: optional quote, ≥8 chars that
 * are not whitespace/separators/quotes, optional closing quote. Mirrors rule 4.
 */
const ASSIGNED_VALUE = String.raw`[ \t]*(?::=|[=:])[ \t]*["']?[^\s,;'"]{8,}["']?`;

/**
 * SCREAMING_SNAKE env-var names ending in a secret noun. Rule 4's `\b(token|…)`
 * never fires inside `GROQ_API_KEY` / `TELEGRAM_BOT_TOKEN` because `_` is a
 * word char, so the whole `.env` idiom slipped through. Case-SENSITIVE on
 * purpose: `sort_key=…` in prose/code must not match.
 */
const ENV_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_$])([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|DSN))` +
    ASSIGNED_VALUE,
  'g',
);

/** snake_case names with a secret suffix (`bot_token`, `db_password`). */
const SNAKE_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_$])([a-z][a-z0-9_]*_(?:api_key|token|secret|password|passwd|pass|pwd|credentials?|private_key|access_key|secret_key|signing_key))` +
    ASSIGNED_VALUE,
  'g',
);

/**
 * Cheap literal-led prefilters for the snake/camel rules. Those two regexes
 * start at every lowercase word, which measured ~3–4.5 ms per MB; the
 * prefilters cost <1 ms and skip them on the common text that has no
 * `…Token =` / `…_password:` assignment at all.
 */
const SNAKE_PREFILTER = /_(?:api_key|token|secret|password|passwd|pass|pwd|credentials?|private_key|access_key|secret_key|signing_key)\s*:?[=:]/;
const CAMEL_PREFILTER = /(?:Token|Secret|Password|Passwd|ApiKey|PrivateKey|AccessKey|SecretKey|SigningKey|Credentials?)\s*:?[=:]/;

/** camelCase names with a secret suffix (`githubToken`, `clientSecret`). */
const CAMEL_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_$])([a-z][A-Za-z0-9]*(?:Token|Secret|Password|Passwd|ApiKey|PrivateKey|AccessKey|SecretKey|SigningKey|Credentials?))` +
    ASSIGNED_VALUE,
  'g',
);

/**
 * Quoted keys (JSON, YAML, JS object literals), including JSON-escaped quotes
 * inside a serialized string (`\"password\":\"…\"`). The name must END in a
 * secret noun (`max_tokens`, `tokenizer`, `author` do not). Structure is kept —
 * only the value becomes `[REDACTED]` — so a scrubbed JSON line stays parseable.
 */
const QUOTED_SECRET_KEY =
  /(\\?["'])([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credentials?|private[_-]?key(?:[_-]?id)?|access[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key|auth|connection[_-]?string))\1(\s*:\s*)(\\?["'])([^"'\s\\]{8,})\4/gi;

/**
 * Values in CODE that merely reference a secret (a member chain, call, template
 * or env interpolation) rather than contain one. Scrubbed diffs are persisted
 * and applied as proposals, so turning `const GITHUB_TOKEN = process.env.GITHUB_TOKEN`
 * into `GITHUB_TOKEN=[REDACTED]` would corrupt a legitimate change. Quoted
 * literals are data, even when they look like a member chain or function call.
 */
function isCodeReference(value: string, quotedLiteral = /^["']/.test(value)): boolean {
  const v = value.replace(/^["']|["']$/g, '');
  if (/^(?:\$\{|\$[A-Za-z_]|`|<)/.test(v)) return true; // interpolation or placeholder
  if (quotedLiteral) return false;
  return (
    /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+[)\]]*$/.test(v) || // process.env.X, opts.apiToken
    /^[A-Za-z_$][\w$.]*\(/.test(v) || // getToken(), cfg.read(
    /^[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)+(?:\(|$)/.test(v) // std::env::var(, Config::SECRET
  );
}

/** Namespaced queue/cache identifiers are public keys, not password/token values. */
function isNamespacedKey(name: string, value: string): boolean {
  return /^(?:QUEUE|CACHE|REDIS)_KEY$/i.test(name) &&
    /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_.-]*){2,}$/.test(value.replace(/^["']|["']$/g, ''));
}

/**
 * Type annotations and identifier-only right-hand sides (`refreshToken: RefreshTokenRecord`,
 * `botToken: undefined`) carry no digits; real tokens essentially always do.
 * Only the camel/snake rules use this skip (they fire inside ordinary TS code);
 * the SCREAMING env rule still redacts a letters-only `.env` password.
 */
function isIdentifierOnly(value: string): boolean {
  if (/^["']/.test(value)) return false;
  const v = value.replace(/^["']|["']$/g, '');
  return !/\d/.test(v) && /^[A-Za-z_$][A-Za-z_$.<>[\]|&?!()]*$/.test(v);
}

/** A value an earlier rule (or an earlier pass) already replaced. */
function isAlreadyRedacted(value: string): boolean {
  return value.replace(/^["']|["']$/g, '') === REDACTED;
}

/** An unquoted marker followed by code syntax, such as `call(token=[REDACTED])` or a string method. */
function isRedactedExpression(value: string): boolean {
  return /^\[REDACTED\](?:[)\]}]+$|\.[A-Za-z_$][\w$]*\()/.test(value);
}

function redactAssignment(name: string, match: string, value: string, allowIdentifiers: boolean): string {
  // Idempotence: `NAME = "[REDACTED]"` must stay byte-identical on a re-scrub.
  if (isAlreadyRedacted(value) || isRedactedExpression(value)) return match;
  if (isCodeReference(value) || isNamespacedKey(name, value) || isMask(value)) return match;
  if (allowIdentifiers && isIdentifierOnly(value)) return match;
  return `${name}=${REDACTED}`;
}

function valueOf(match: string, name: string): string {
  return match.slice(name.length).replace(/^[ \t]*(?::=|[=:])[ \t]*/, '');
}

/**
 * Recognized grammar after `Bearer` / `Token` / `Authorization` in prose.
 * Letter case alone cannot distinguish an opaque credential from a word.
 */
function isProseWord(value: string): boolean {
  return /^(?:tokens?|headers?|expires|mint|valid|is|count|with|refresh|has|Basic)$/i.test(value);
}

/** `Basic` header value: base64 of `user:password` with no control characters (UTF-8 bytes above 0x7f allowed). */
function isBasicCredential(value: string): boolean {
  try {
    const decoded = typeof atob === 'function' ? atob(value) : '';
    const colon = decoded.indexOf(':');
    // HTTP Basic permits an empty username, password, or both.
    if (colon < 0) return false;
    for (let i = 0; i < decoded.length; i++) {
      const code = decoded.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Random-looking key material: no separator-delimited piece is a word, and upper case, lower case and digits all occur at least three times. */
function isRandomKeyMaterial(value: string): boolean {
  const pieces = value.replace(/=+$/, '').split(/[/+_-]+/).filter(Boolean);
  if (pieces.some(piece => /^(?:[a-z]{4,}|[A-Z][a-z]{3,}|[A-Z]{4,})$/.test(piece))) return false;
  const count = (pattern: RegExp): number => (value.match(pattern) ?? []).length;
  return count(/[A-Z]/g) >= 3 && count(/[a-z]/g) >= 3 && count(/\d/g) >= 3;
}

/** Provider tokens with a fixed prefix (Stripe, SendGrid, Mailgun, Docker Hub, Resend, Discord bot tokens). */
const PROVIDER_TOKEN =
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|key-[0-9a-f]{32}|dckr_pat_[A-Za-z0-9_-]{16,}|re_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}|[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40})\b/g;

/** Words that mark nearby text as a credential context (`dbPassword`, `webhook_secret`, `AUTH_KEY`, `login(`). */
const CREDENTIAL_HINT = /pass|pwd|secret|token|key|auth|cred|login|signing/i;

/** Upper, lower, digit, symbol: how often adjacent characters change class. Random strings change often; words and camelCase rarely. */
function classChangeRatio(value: string): number {
  const cls = (c: string): number => (/[A-Z]/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : /\d/.test(c) ? 2 : 3);
  let changes = 0;
  for (let i = 1; i < value.length; i++) if (cls(value[i]!) !== cls(value[i - 1]!)) changes++;
  return changes / Math.max(1, value.length - 1);
}

/** A literal that reads like a generated password or key, not a path, URL, email, identifier or placeholder. */
function isRandomLiteral(value: string): boolean {
  if (value.includes(REDACTED) || /[/\\]|:\/\/|\$\{|\{\{|^[<%$]|\[[^\]]*\]|\{\d+(?:,\d*)?\}/.test(value) || /^[^@\s]+@[\w-]+(?:\.[\w-]+)+$/.test(value)) return false;
  const count = (pattern: RegExp): number => (value.match(pattern) ?? []).length;
  if (count(/[A-Z]/g) < 2 || count(/[a-z]/g) < 2 || count(/\d/g) < 2) return false;
  if ((value.match(/[A-Z][a-z]{3,}/g) ?? []).length >= 2 || /[a-z]{6,}/.test(value)) return false;
  return classChangeRatio(value) >= 0.45;
}

/**
 * A credential noun in prose, then the rest of the line. Lower case, Capitalized or UPPER case only, and never inside a
 * lower-case word, so `PGPASSWORD` counts but `bypass`, `tokenizer` and the verb "pass" do not.
 */
const PROSE_CREDENTIAL_NOUN =
  /((?<![a-z])(?:[Pp]ass(?:word|wd|phrase)s?|PASS(?:WORD|WD|PHRASE)S?|[Pp]wd|PWD|[Ss]ecrets?|SECRETS?|[Tt]okens?|TOKENS?|[Cc]red(?:ential)?s?|CRED(?:ENTIAL)?S?)(?![a-z]))([^\n]{0,80})/g;

/**
 * An unquoted token after a credential word in prose that reads like a password: upper case, lower case and digits,
 * plus a symbol or a random-looking mix. Code (`${…}`, calls, regexes), paths, emails and word-built identifiers are not.
 */
function isProseCredential(value: string): boolean {
  if (value.length < 8 || value.includes(REDACTED) || /[/\\(){}[\]|<>;$`]|^[^@\s]+@[\w-]+(?:\.[\w-]+)+$/.test(value)) return false;
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value)) return false;
  if (value.split(/[-_.:]+/).some(piece => /^(?:[a-z]{3,}|[A-Z][a-z]{2,}|[A-Z]{2,}[a-z]*)$/.test(piece))) return false;
  if (/[~^*%@#!&+]/.test(value)) return true;
  if (/=./.test(value) || /^[a-z]{3,}[A-Z\d]|[A-Z][a-z]{5,}/.test(value)) return false; // key=value, camelCase identifiers
  const count = (pattern: RegExp): number => (value.match(pattern) ?? []).length;
  return count(/[A-Z]/g) >= 2 && count(/[a-z]/g) >= 2 && count(/\d/g) >= 2 && count(/[A-Z][a-z]{3,}/g) < 2 && classChangeRatio(value) >= 0.45;
}

function redactProseCredential(span: string): string {
  return span.replace(/([\s(:"'`])([^\s()"'`]{8,})/g, (m: string, lead: string, raw: string) => {
    const value = raw.replace(/[.,;:!?]+$/, '');
    return isProseCredential(value) ? `${lead}${REDACTED}${raw.slice(value.length)}` : m;
  });
}

/** Recognized masks (`********`, `xxxxxxxx`); repeated digits/other letters can be real passwords. */
function isMask(value: string): boolean {
  return /^(?:\*+|x+|X+)$/.test(value.replace(/^["']|["']$/g, ''));
}

/** Public digests and keys that look like secrets: content digests (`sha256:…`, SRI `sha512-…`, go.sum `h1:…`) and SSH public keys (`ssh-ed25519 AAAA…`). */
const PUBLIC_DIGEST_PREFIX = /(?:\bsha(?:256|384|512)-|\bsha256:|\bh1:|\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) )$/;

/**
 * Scrub recognised secret patterns from `text`.
 * Returns the scrubbed string with secrets replaced by `[REDACTED]`.
 * Never throws. Idempotent: `scrubSecrets(scrubSecrets(x)) === scrubSecrets(x)`.
 */
export function scrubSecrets(text: string): string {
  try {
    let out = text
      // 0. PEM/private-key blocks. Run before generic/base64 redaction so
      // BEGIN/END markers do not survive with only the body removed.
      .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, REDACTED)
      .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[^\n]*/g, REDACTED)
      // 11. Telegram bot tokens — before rule 4 so a `botToken: <id>:<secret>`
      // value is removed whole even when its key name is not recognised.
      .replace(TELEGRAM_BOT_TOKEN, redactTelegram)
      // 15. Slack / Discord incoming-webhook URLs (credential in the path).
      .replace(WEBHOOK_URL, '$1[REDACTED]')
      // 12. xAI keys — before rule 10 so the `xai-` prefix does not survive
      // next to a base64-redacted tail.
      .replace(XAI_API_KEY, REDACTED)
      // 16. Devin keys — before rule 10 for the same reason.
      .replace(DEVIN_API_KEY, REDACTED)
      // 1. sk- API keys (Anthropic, OpenAI, etc.)
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED)
      // 2. GitHub tokens (including long, dotted stateless installation
      // tokens); consume the entire value so no JWT segment survives.
      .replace(/\bgh[poursa]_[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*/g, REDACTED)
      .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, REDACTED)
      // 3a. HTTP Basic credentials: base64 of `user:password`. Only a value that decodes to printable `x:y` text counts,
      // so "Basic usage" or "Basic AbcDefGh" prose is left alone.
      .replace(/\b(Basic)\s+([A-Za-z0-9+/]{2,}={0,2})(?![A-Za-z0-9+/=])/gi, (m: string, word: string, value: string) => (isBasicCredential(value) ? `${word} ${REDACTED}` : m))
      // 3. Bearer / Token / Authorization header values
      .replace(/(?:(?<![\w-])|(?<=--))(Bearer|Token|Authorization)\s+[A-Za-z0-9\-._~+/]+=*/gi, (m: string, word: string, offset: number, whole: string) => {
        // Explicit HTTP authorization values are credentials even when they are dictionary words.
        const inHeader = /\b(?:proxy-)?authorization(?:\\?["'])?[ \t]*[=:][ \t]*(?:\\?["'])?$/i.test(whole.slice(Math.max(0, offset - 40), offset));
        const inFlag = whole.slice(Math.max(0, offset - 2), offset) === '--';
        return !inHeader && !inFlag && isProseWord(m.slice(word.length).trim().replace(/[.]+$/, '')) ? m : `${word} ${REDACTED}`;
      })
      // 4. Generic key=value secret patterns. ASHLR_* env vars are only
      // redacted when they look like assignments, not plain audit metadata
      // such as "keys=query".
      .replace(
        /\b(api[_-]?key|api[_-]?token|secret|secret[_-]?key|token|password|passwd|pwd|auth|credential|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|connection[_-]?string|conn[_-]?str|_?auth[_-]?token|signing[_-]?key|encryption[_-]?key|master[_-]?key|hmac[_-]?(?:key|secret)|webhook[_-]?secret|app[_-]?key|ASHLR_[A-Z_]+)[ \t]*(?::=|[=:])[ \t]*["']?[^\s,;'"]{8,}["']?/gi,
        (m: string, name: string) => {
          const value = valueOf(m, name);
          // An earlier rule already redacted the value (`api_key="[REDACTED]"`): keep it, so a second pass is a no-op.
          return isAlreadyRedacted(value) || isRedactedExpression(value) || isCodeReference(value) || isNamespacedKey(name, value) || isMask(value) ? m : `${name}=${REDACTED}`;
        },
      )
      // 4b. A credential stated in prose: "the staging admin password is NDN5KYKdVgt6LN". The value must mix letters and
      // digits and must not read as a file, path or word ("the token is rotated", "the secret is in vault2.yaml").
      .replace(/\b(password|passwd|passphrase|pwd|secret|token)\s+(?:is|was)\s*:?\s+["'`]?([A-Za-z0-9!@#$%^&*_+=-]{8,})["'`]?(?=[\s.,;)]|$)/gi,
        (m: string, word: string, value: string) => (/[A-Za-z]/.test(value) && /\d/.test(value) && !value.startsWith(REDACTED) ? `${word} ${REDACTED}` : m))
      // 5. Slack tokens
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, REDACTED)
      // 6. AWS access key IDs
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
      // 7. JWTs (eyJ header.payload.sig)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
      // 8. Bare hex-64 strings (SHA-256 / hex API keys)
      .replace(/\b[0-9a-fA-F]{64,}\b/g, (m: string, offset: number, whole: string) => (m.length === 64 && /\bsha256:$/i.test(whole.slice(Math.max(0, offset - 8), offset)) ? m : REDACTED))
      // 9. Other common provider token prefixes.
      .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED)
      .replace(/\bhf_[A-Za-z0-9]{16,}\b/g, REDACTED)
      .replace(/\bnpm_[A-Za-z0-9]{16,}\b/g, REDACTED)
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED)
      .replace(PROVIDER_TOKEN, REDACTED)
      // 9b. .netrc entries: the value after `password` on a `machine … login …` line.
      .replace(/(\bmachine\s+\S+\s+(?:login\s+\S+\s+)?password)\s+(\S+)/g, (m: string, head: string, value: string) => (value === REDACTED ? m : `${head} ${REDACTED}`))
      // 10. URL passwords and long base64-ish blobs.
      .replace(/(:\/\/[^:\s/@]*:)[^@\s]+(@)/g, '$1[REDACTED]$2')
      .replace(/(?<![/\w])[A-Za-z0-9+]{40,}={0,2}(?![/\w])/g, (m: string, offset: number, whole: string) => (PUBLIC_DIGEST_PREFIX.test(whole.slice(Math.max(0, offset - 40), offset)) ? m : scrubLongBase64Like(m)))
      // 10b. Keys in base64 with `/`, `+`, `-` or `_` inside (AWS secret access keys, Azure AccountKey, Fernet keys).
      // Paths and kebab identifiers are left alone: each piece between separators must not be a word, and the whole
      // must mix upper case, lower case and digits like random key material.
      .replace(/(?<![\w/+.-])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w/+=.-])/g, (m: string, offset: number, whole: string) =>
        (/[/+_-]/.test(m) && !/^sha(?:256|384|512)-/.test(m) && !PUBLIC_DIGEST_PREFIX.test(whole.slice(Math.max(0, offset - 40), offset)) && isRandomKeyMaterial(m) ? REDACTED : m))
      // 10c. A random-looking quoted literal shortly after a credential word (`dbPassword := "…"`,
      // `String::from("…")` after `webhook_secret`, a k8s `value:` under `MYSQL_ROOT_PASSWORD`).
      .replace(/"([^\s"]{12,200})"|'([^\s']{12,200})'/g, (m: string, dq: string | undefined, sq: string | undefined, offset: number, whole: string) =>
        (isRandomLiteral(dq ?? sq ?? '') && CREDENTIAL_HINT.test(whole.slice(Math.max(0, offset - 100), offset)) ? m.replace(dq ?? sq ?? '', REDACTED) : m))
      // 10d. A credential disclosed in prose: "the Redis password on prod-cache-02 is Y6kQ…", "reset it to 5aHJ…".
      .replace(PROSE_CREDENTIAL_NOUN, (_m: string, noun: string, rest: string) => noun + redactProseCredential(rest))
      // 13. Suffix-named assignments rule 4's `\b` anchor cannot see. LAST, so
      // every token-shape rule above has already turned a JWT/AKIA/hex value
      // into [REDACTED]; that marker is left untouched below. Running these
      // earlier broke idempotence: a dotted JWT reads like a member chain
      // (skipped as a code reference), then pass 2 rewrote `NAME = "[REDACTED]"`.
      .replace(ENV_SECRET_ASSIGNMENT, (m: string, name: string) => redactAssignment(name, m, valueOf(m, name), false));
    if (SNAKE_PREFILTER.test(out)) {
      out = out.replace(SNAKE_SECRET_ASSIGNMENT, (m: string, name: string) => redactAssignment(name, m, valueOf(m, name), true));
    }
    if (CAMEL_PREFILTER.test(out)) {
      out = out.replace(CAMEL_SECRET_ASSIGNMENT, (m: string, name: string) => redactAssignment(name, m, valueOf(m, name), true));
    }
    // 14. Quoted keys: keep the JSON/YAML structure, replace the value only.
    return out.replace(
      QUOTED_SECRET_KEY,
      (m: string, q: string, name: string, sep: string, vq: string, value: string) =>
        isAlreadyRedacted(value) || isCodeReference(value, true) ? m : `${q}${name}${q}${sep}${vq}${REDACTED}${vq}`,
    );
  } catch {
    // Never throws — return original text on unexpected error.
    return text;
  }
}


const GENERIC_HOME_ROOT =
  /(?<![\w.-])(?:\/(?:Users|home)\/(?!Shared(?![\w.-]))[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)(?![\w.-])/g;

export function redactGenericHomePaths(text: string): string {
  return text.replace(GENERIC_HOME_ROOT, '~');
}
