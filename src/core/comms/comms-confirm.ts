/**
 * One-click Comms confirmation (RQ-PHX-COMMSCONFIRMDESK09). Reads the limits the
 * team transports run under and, for the desktop console's owner-gated POST only,
 * flips `confirmedByMason` in `~/.ashlr/comms.toml`.
 *
 * The digest covers every limit shown to Mason: the `[team].identities` allowlist
 * in agent-network.toml and every comms.toml setting except the two confirmation
 * keys. A confirmation is refused unless the digest Mason saw still matches disk,
 * and the rewritten file must parse to the same digest, so no limit can change here.
 * There is deliberately no CLI verb or MCP tool that calls `confirmCommsLimits`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { parseTeamIdentities, type TeamIdentity } from '../agents/channel-policy.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

const MAX_BYTES = 64 * 1024;
const CONFIRM_KEYS = new Set(['confirmedByMason', 'confirmedAt']);

export type CommsConfirmState = 'confirmed' | 'unconfirmed' | 'unknown';

export interface CommsLimits {
  /** Team identities the transports may message without a per-message approval. */
  team: TeamIdentity[];
  /** Distinct channels those identities use. */
  channels: string[];
  /** Every other comms.toml setting, flattened to `key = value` text. */
  settings: Array<{ key: string; value: string }>;
}

export interface CommsLimitsView {
  state: CommsConfirmState;
  limits: CommsLimits | null;
  digest: string | null;
  confirmedAt: string | null;
}

export type CommsConfirmResult =
  | { ok: true; confirmedAt: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'digest-mismatch' | 'changed' | 'io-error' };

interface Snapshot { text: string; doc: Record<string, unknown>; view: CommsLimitsView & { limits: CommsLimits; digest: string } }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** Sorted-key JSON so the digest does not depend on key order. */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function flatten(value: unknown, prefix: string, out: Array<{ key: string; value: string }>): void {
  if (record(value)) {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.push({ key: prefix, value: JSON.stringify(canonical(value)) });
  }
}

function readText(dir: string, name: string): { text: string } | 'missing' | 'error' {
  const read = readStableRegularFile(join(dir, name), { anchorPath: dir, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (read.ok) return { text: read.text };
  // The stable reader folds ENOENT into io-error; tell "absent" apart from "unreadable".
  try { lstatSync(join(dir, name)); return 'error'; } catch { return 'missing'; }
}

function settingsOf(doc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !CONFIRM_KEYS.has(key)));
}

function settingsJson(doc: Record<string, unknown>): string {
  return JSON.stringify(canonical(settingsOf(doc)));
}

function limitsOf(doc: Record<string, unknown>, networkText: string): { limits: CommsLimits; digest: string } {
  const team = parseTeamIdentities(networkText);
  const rest = settingsOf(doc);
  const settings: CommsLimits['settings'] = [];
  flatten(rest, '', settings);
  // Prefixed so the public-JSON secret scrubber does not mistake a bare 64-hex digest for a token.
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(canonical({ comms: rest, team }))).digest('hex')}`;
  return { limits: { team, channels: [...new Set(team.map(id => id.channel))].sort(), settings }, digest };
}

function snapshot(configDir: string): Snapshot | 'missing' | 'malformed' {
  const comms = readText(configDir, 'comms.toml');
  if (comms === 'missing') return 'missing';
  if (comms === 'error') return 'malformed';
  let doc: unknown;
  try { doc = parse(comms.text, { unsafeKeyBehaviour: 'throw' }); } catch { return 'malformed'; }
  if (!record(doc) || (doc.confirmedByMason !== undefined && typeof doc.confirmedByMason !== 'boolean')) return 'malformed';
  const network = readText(configDir, 'agent-network.toml');
  const { limits, digest } = limitsOf(doc, typeof network === 'object' ? network.text : '');
  const confirmedAt = typeof doc.confirmedAt === 'string' ? doc.confirmedAt : null;
  return { text: comms.text, doc, view: { state: doc.confirmedByMason === true ? 'confirmed' : 'unconfirmed', limits, digest, confirmedAt } };
}

/** `configDir` is the `.ashlr` directory the transports read. Missing or malformed reads as `unknown`. */
export function readCommsLimits(configDir: string): CommsLimitsView {
  const read = snapshot(configDir);
  return typeof read === 'string' ? { state: 'unknown', limits: null, digest: null, confirmedAt: null } : read.view;
}

const BOOL_LINE = /^(\s*confirmedByMason\s*=\s*)(?:true|false)(\s*(?:#.*)?)$/;
const AT_LINE = /^(\s*confirmedAt\s*=\s*)(?:"[^"\n]*"|'[^'\n]*')(\s*(?:#.*)?)$/;

/** Edit only the two top-level confirmation lines; every other byte is kept. */
function withConfirmation(text: string, confirmedAt: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  const top = firstTable === -1 ? lines.length : firstTable;
  const at = `confirmedAt = ${JSON.stringify(confirmedAt)}`;
  let boolIndex = -1;
  let atIndex = -1;
  for (let i = 0; i < top; i++) {
    if (BOOL_LINE.test(lines[i]!)) { boolIndex = i; lines[i] = lines[i]!.replace(BOOL_LINE, '$1true$2'); }
    else if (AT_LINE.test(lines[i]!)) { atIndex = i; lines[i] = lines[i]!.replace(AT_LINE, `$1${JSON.stringify(confirmedAt)}$2`); }
  }
  if (boolIndex === -1) { lines.splice(0, 0, 'confirmedByMason = true'); boolIndex = 0; if (atIndex !== -1) atIndex++; }
  if (atIndex === -1) lines.splice(boolIndex + 1, 0, at);
  return lines.join(eol);
}

function writeAtomic(path: string, text: string, mode: number): void {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

/**
 * Set `confirmedByMason = true` and `confirmedAt` only while the limits on disk
 * still hash to `limitsDigest`. Never creates comms.toml and never sets a limit.
 * Only the owner-gated POST in src/core/web/comms-confirm-route.ts calls this.
 */
export function confirmCommsLimits(configDir: string, input: { limitsDigest: string; confirmedAt: string }): CommsConfirmResult {
  const before = snapshot(configDir);
  if (before === 'missing' || before === 'malformed') return { ok: false, reason: before };
  if (before.view.digest !== input.limitsDigest) return { ok: false, reason: 'digest-mismatch' };
  const next = withConfirmation(before.text, input.confirmedAt);
  let doc: unknown;
  try { doc = parse(next, { unsafeKeyBehaviour: 'throw' }); } catch { return { ok: false, reason: 'malformed' }; }
  // The rewrite must leave every limit untouched and land exactly the two keys.
  if (!record(doc) || doc.confirmedByMason !== true || doc.confirmedAt !== input.confirmedAt
      || settingsJson(doc) !== settingsJson(before.doc)) {
    return { ok: false, reason: 'malformed' };
  }
  const path = join(configDir, 'comms.toml');
  try {
    const mode = statSync(path).mode & 0o600;
    // Re-read just before the swap: a concurrent edit wins over this click.
    const again = readText(configDir, 'comms.toml');
    if (typeof again !== 'object' || again.text !== before.text) return { ok: false, reason: 'changed' };
    writeAtomic(`${path}.bak`, before.text, 0o600);
    writeAtomic(path, next, mode || 0o600);
  } catch {
    return { ok: false, reason: 'io-error' };
  }
  return { ok: true, confirmedAt: input.confirmedAt };
}
