import { stripAnsi } from '../chat/ansi.js';
import { scrubReplayTokens } from './replay-token-patterns.js';

export const MAX_RECORDING_BYTES = 2_000_000;
const MAX_FIELD = 32_000;
const REDACTED = '[REDACTED]';
const SENSITIVE = /token|secret|password|passwd|pwd|credential|auth|cookie|capabilit|(?:api|private|access|signing)[_-]?key|connection[_-]?string|conn[_-]?str|dsn|ASHLR_[A-Z_]+/i;
const ENVIRONMENT = /^(?:env|environment)$/i;
const ASSIGNMENT = /(\b[\w-]{0,256}(?:token|secret|password|passwd|pwd|credential|auth|cookie|capabilit\w{0,32}|(?:api|private|access|signing)[_-]?key|connection[_-]?string|conn[_-]?str|dsn|ASHLR_[A-Z_]{1,128})[\w-]{0,256}["']?(?:\s*[=:]\s*|\s+)(?![=:]))("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&"']+)/gi;
const HEADER = /(\b(?:cookie|set-cookie|authorization)\s*[:=])([^\r\n]*)/gi;
const NESTED_ASSIGNMENT = /\b[\w-]{0,256}(?:token|secret|password|credential|auth|capabilit\w{0,32}|api[_-]?key)[\w-]{0,256}["']?\s*[=:]\s*[[{]/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new Error('Invalid recording'); }

/** Collect across the bounded source before selecting a turn or deriving UI facts. */
export function createReplaySanitizer(raw: unknown, supplied: unknown) {
  const secrets = new Set<string>();
  let nodes = 0;
  let bytes = 0;
  const remember = (value: string) => {
    const plain = stripAnsi(value);
    if (plain && plain !== REDACTED) secrets.add(plain);
    if (secrets.size > 128) invalid();
  };
  const collect = (value: unknown, sensitive = false, depth = 0): void => {
    if (++nodes > 60_000 || depth > 20) invalid();
    if (typeof value === 'string') {
      bytes += new TextEncoder().encode(value).length;
      if (value.length > MAX_FIELD || bytes > MAX_RECORDING_BYTES) invalid();
      const plain = stripAnsi(value);
      if (sensitive) remember(plain);
      // Also inspect prefixed JSON (e.g. `response: {"auth":{"value":"…"}}`).
      // Scan each span once; retrying every opening brace would be quadratic.
      for (let cursor = 0; cursor < plain.length;) {
        const relativeStart = plain.slice(cursor).search(/[[{]/);
        if (relativeStart < 0) break;
        const start = cursor + relativeStart;
        let nesting = 0;
        let quoted = false;
        let end = start;
        for (; end < plain.length; end++) {
          const char = plain[end];
          if (quoted && char === '\\') { end++; continue; }
          if (char === '"') { quoted = !quoted; continue; }
          if (quoted) continue;
          if (char === '{' || char === '[') nesting++;
          if ((char === '}' || char === ']') && --nesting === 0) break;
        }
        const candidate = plain.slice(start, end + 1);
        if (candidate === REDACTED) { cursor = end + 1; continue; }
        const nestedSensitive = sensitive || NESTED_ASSIGNMENT.test(plain.slice(cursor, start + 1));
        let embedded: unknown;
        try { embedded = JSON.parse(candidate); }
        catch {
          // Ambiguous credential objects must not supply unredacted echoes.
          if (nestedSensitive || NESTED_ASSIGNMENT.test(candidate)) invalid();
        }
        if (record(embedded) || Array.isArray(embedded)) collect(embedded, nestedSensitive, depth + 1);
        cursor = end + 1;
      }
      for (const match of plain.matchAll(ASSIGNMENT)) {
        const quoted = match[2]!;
        if (/^[[{]/.test(quoted)) continue;
        let credential = quoted;
        if (quoted.startsWith('"')) {
          try { credential = JSON.parse(quoted) as string; }
          catch { credential = quoted.slice(1, -1); }
        } else if (quoted.startsWith("'")) credential = quoted.slice(1, -1);
        remember(credential);
        // Prose often terminates an unquoted assignment with punctuation;
        // retain both readings so its bare echo is still removed.
        if (!/^["']/.test(quoted)) remember(credential.replace(/[.!?)]*$/, ''));
      }
      for (const match of plain.matchAll(HEADER)) {
        remember(match[2]!.trim());
        const bearer = match[2]!.match(/^\s*(?:Bearer|Token)\s+([^\s"']+)/i);
        if (bearer) remember(bearer[1]!);
        for (const cookie of match[2]!.matchAll(/(?:^|;)\s*[^=;]+=(?:"([^"]*)"|([^;\s"']+))/g)) remember(cookie[1] ?? cookie[2]!);
      }
    } else if (sensitive && (typeof value === 'number' || typeof value === 'boolean')) {
      remember(String(value));
    } else if (Array.isArray(value)) value.forEach((v) => collect(v, sensitive, depth + 1));
    else if (record(value)) Object.entries(value).forEach(([key, child]) => {
      if (key.length > 256) invalid();
      if (key === 'events' && Array.isArray(child)) {
        // A credential may straddle stream frames. Collect from each turn's
        // ordered stream as well, while rendering only the original frames.
        const streams = new Map<string, string>();
        const deltas = child.filter((event) => record(event) && event.type === 'text-delta' && typeof event.turnId === 'string' && typeof event.text === 'string' && Number.isSafeInteger(event.seq))
          .sort((a, b) => a.seq - b.seq);
        for (const delta of deltas) {
          const combined = (streams.get(delta.turnId) ?? '') + delta.text;
          if (combined.length > MAX_FIELD) invalid();
          streams.set(delta.turnId, combined);
        }
        for (const stream of streams.values()) collect(stream, false, depth + 1);
      }
      collect(child, sensitive || ENVIRONMENT.test(key) || SENSITIVE.test(key), depth + 1);
    });
  };
  collect(raw);
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || supplied.length > 128 || supplied.some((v) => typeof v !== 'string')) invalid();
    collect(supplied, true);
  }
  // A stable single pass makes overlapping credentials independent of arrival order.
  const known = [...new Set([...secrets].flatMap((s) => [s, encodeURIComponent(s)]))]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const knownPattern = known.length ? new RegExp(known.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const text = (value: string): string => {
    let out = stripAnsi(value);
    // Free-form nested credential objects have no safe textual boundary.
    if (NESTED_ASSIGNMENT.test(out.split(REDACTED).join(''))) return REDACTED;
    out = out.replace(ASSIGNMENT, '$1[REDACTED]').replace(HEADER, '$1[REDACTED]');
    // One replacement pass keeps overlapping values independent of input order.
    // Protect placeholders when a known credential is just one character.
    return out.split(REDACTED).map((part) => scrubReplayTokens(knownPattern ? part.replace(knownPattern, REDACTED) : part)).join(REDACTED);
  };
  const clean = (value: unknown, key = ''): unknown => {
    if (ENVIRONMENT.test(key) || SENSITIVE.test(key)) return REDACTED;
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((v) => clean(v));
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), clean(v, k)]));
    return value;
  };
  return { text, clean };
}
