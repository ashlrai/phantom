/**
 * codex-session-usage.ts - RQ-CODEX-USAGE-SOURCE: automatic per-account Codex
 * subscription usage from the session logs the codex CLI already writes.
 *
 * WHY THIS EXISTS. The fleet runs two Codex accounts (`~/.codex` and
 * `~/.codex-2`; the seats named `codex-cmp` and `codex-personal` in the fleet
 * pool vocabulary). `observability/codex-source.ts` reads only the default
 * home, and the App Server probe requires live credentials. Every codex run
 * already appends its own rate-limit snapshot to its rollout file:
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 *     {"timestamp":…,"type":"event_msg","payload":{"type":"token_count",
 *       "info":{…},"rate_limits":{"limit_id":"codex","primary":{…},
 *       "secondary":{…},"credits":{…},"plan_type":"pro",…}}}
 *
 * so weekly %, credits and reset times are available locally, per account,
 * with no auth file ever opened. `auth.json` lives next to `sessions/` and is
 * never enumerated, opened, or read: this module only ever lists the
 * `sessions/` subtree and only ever opens `rollout-*.jsonl` files inside it.
 *
 * STRICT ALLOWLIST PARSER. Only the fields this module emits are copied out
 * of a rollout line:
 *   - session_meta    -> payload.originator, payload.cli_version, payload.timestamp
 *   - turn_context    -> payload.model
 *   - event_msg       -> payload.type === 'session_configured' -> payload.model
 *   - event_msg       -> payload.type === 'token_count' -> payload.rate_limits:
 *       limit_id, limit_name (bounded), normal_model_slug,
 *       primary/secondary {used_percent, window_minutes, resets_at},
 *       credits {has_credits, unlimited, balance},
 *       individual_limit {remaining_percent, resets_at},
 *       plan_type (known plan ids only),
 *       rate_limit_reached_type (known enum ids only),
 *       spend_control_reached (boolean)
 *   - row-level        -> timestamp
 * Everything else (cwd, session/thread ids, message text, token totals, and
 * anything shaped like a credential) is dropped before it can reach an
 * output document.
 *
 * OUTPUT is a `resource.v1` document: per account, used %, left %, reset
 * time, a measured burn rate and a projected exhaustion instant for each
 * rate-limit window. Burn history persists as a namespaced `codexUsage`
 * extension inside the shared fleet document (`fleet.json`; PHANTOM_FLEET_PATH
 * or PHANTOM_FLEET_FILE override, default `$ASHLR_HOME/fleet/fleet.json`),
 * written under the shared `.fleet-locks/fleet.json.lock` so sibling writers
 * keep their fields. All other top-level fleet fields survive a write.
 *
 * Never throws. Unknown usage is never reported as 0%: a window the CLI did
 * not write is null, and an account with no reading is `unavailable`.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
} from './local-store-lock.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One rate-limit window as codex reports it inside a session log. */
export interface CodexSessionWindow {
  /** Provider percent; finite, >= 0 (provider values above 100 stay unclamped). */
  usedPercent: number;
  /** Rolling window duration in minutes (300 = 5-hour, 10080 = weekly). */
  windowMinutes: number | null;
  /** Unix epoch seconds when the window resets. */
  resetsAt: number | null;
}

/** Display-only native credit metadata; identical contract to codex-credits.ts. */
export interface CodexSessionCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

/** The allowlisted session/status plus rate-limit state of one account home. */
export interface CodexSessionUsage {
  /** Fleet pool id for the credential slot: 'codex-cmp' or 'codex-personal'. */
  accountId: string;
  /** Which credential slot the reading came from. */
  slot: 'primary' | 'secondary';
  /** ISO time of the winning rate-limit record; file mtime when absent. */
  observedAt: string | null;
  /** The allowlisted plan id, or null. */
  planType: string | null;
  /** The quota bucket id the snapshot describes (validated id shape). */
  limitId: string | null;
  /** The provider's own quota label when bounded and printable. */
  limitName: string | null;
  /** Known rate-limit-reached enum id, or null. */
  rateLimitReachedType: string | null;
  /** Backend spend-control flag; null when unreported. */
  spendControlReached: boolean | null;
  /** Enterprise monthly credit cap remaining percent / reset, when reported. */
  individualLimit: { remainingPercent: number; resetsAt: number | null } | null;
  /** Active model from turn_context / session_configured / normal_model_slug. */
  model: string | null;
  /** session_meta originator, e.g. 'codex_cli_rs'. */
  originator: string | null;
  /** session_meta cli_version. */
  cliVersion: string | null;
  primary: CodexSessionWindow | null;
  secondary: CodexSessionWindow | null;
  credits: CodexSessionCredits | null;
}

/** A resource.v1 window: the measured reading plus computed burn facts. */
export interface CodexResourceWindow {
  id: 'primary' | 'secondary';
  kind: 'session' | 'weekly';
  usedPct: number | null;
  leftPct: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  /** Measured %/hour from stored samples in the same reset window; null when unknown. */
  burnPctPerHour: number | null;
  /** Hours until 100% at the measured burn; null when unknown. */
  runwayHours: number | null;
  /** ISO exhaustion instant, only when it precedes the window reset; else null. */
  projectedExhaustionAt: string | null;
}

export interface CodexAccountResource {
  id: string;
  provider: 'codex';
  slot: 'primary' | 'secondary';
  state: 'current' | 'stale' | 'unavailable';
  observedAt: string | null;
  plan: string | null;
  model: string | null;
  /** Quota bucket id (id-shaped) and provider label (bounded) when reported. */
  limitId: string | null;
  limitName: string | null;
  cli: { originator: string | null; version: string | null };
  /** Provider-flagged denial on either window. */
  limitReached: boolean;
  /** Backend spend-control flag; null when unreported. */
  spendControlReached: boolean | null;
  /** The weekly-class window with the highest reading, when any. */
  weekly: CodexResourceWindow | null;
  /** The session-class window, when any. */
  session: CodexResourceWindow | null;
  credits: CodexSessionCredits | null;
  /** Enterprise spend-control remaining percent, when reported. */
  individualLimitPercent: number | null;
}

/** The resource.v1 document emitted for the fleet. */
export interface CodexResourceReport {
  v: 'resource.v1';
  generatedAt: string;
  resources: CodexAccountResource[];
}

/** One persisted usage sample inside the fleet.json `codexUsage` extension. */
export interface CodexUsageSample {
  account: string;
  window: 'primary' | 'secondary';
  at: string;
  usedPct: number;
  resetsAt: string | null;
}

/** The namespaced extension this module owns inside the shared fleet document. */
export interface CodexFleetUsageExtension {
  v: 1;
  report: CodexResourceReport;
  readings: CodexUsageSample[];
}

export type CodexFleetPublishState =
  | 'published'
  | 'unchanged'
  | 'empty'
  | 'throttled'
  | 'locked'
  | 'unavailable'
  | 'refused';

export interface CodexFleetPublishResult {
  state: CodexFleetPublishState;
  /** Resolved fleet.json path (never returned to logs with content). */
  path: string;
  report: CodexResourceReport;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The shared document key this module owns. */
export const CODEX_FLEET_USAGE_KEY = 'codexUsage';

/** The resource document schema tag. */
export const CODEX_RESOURCE_SCHEMA = 'resource.v1';

/** Bounded read windows, mirroring observability/codex-source.ts. */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

/** Newest rollout files inspected per account home for rate-limit evidence. */
export const CODEX_USAGE_MAX_FILES_PER_HOME = 4;

/** Rollout discovery bound per home. */
const MAX_DISCOVERY_ENTRIES = 128;

/** Stored sample bound inside the extension. */
export const CODEX_USAGE_MAX_SAMPLES = 4_000;

/** fleet.json read/write bound. */
const MAX_FLEET_BYTES = 2 * 1024 * 1024;

/** A reading older than this is stale rather than current. */
export const CODEX_USAGE_STALE_MS = 24 * 60 * 60_000;

/** Mirrors routing/headroom.ts: a reset further out than this is not a 5-hour window. */
const SESSION_WINDOW_MAX_MS = 5 * 60 * 60_000 + 15 * 60_000;

/** Minimum interval between publish attempts from the live path. */
export const CODEX_USAGE_PUBLISH_MIN_INTERVAL_MS = 60_000;

/** Known provider plan ids; anything else is dropped (never free text). */
const PLAN_TYPES = new Set([
  'free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_usage_based',
  'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown',
]);

/** Known rate-limit-reached enum ids (codex-rs RateLimitReachedType). */
const REACHED_TYPES = new Set([
  'rate_limit_reached',
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

/** Id shape shared with the resource-probe vocabulary. */
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Decimal balance strings only (codex-credits.ts contract). */
const BALANCE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Rollout filenames the CLI writes; nothing else under sessions/ is opened. */
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;

const MAX_EPOCH_SECONDS = 253_402_300_799; // year 9999

let lastPublishAttemptMs = 0;

// ---------------------------------------------------------------------------
// Small validators (the allowlist)
// ---------------------------------------------------------------------------

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bounded printable-ASCII text. A value the canonical scrubber would redact
 * (api keys, bearer tokens, PEM bodies, long hex, JWT segments, ...) is
 * secret-shaped and dropped whole rather than carried into an output
 * document: unknown fields must never become a covert channel.
 */
function boundedText(value: unknown, max = 128): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code >= 127) return null;
  }
  return scrubSecrets(value) === value ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function windowMinutes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 525_600
    ? value : null;
}

function epochSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH_SECONDS
    ? value : null;
}

function isoString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A rate-limit window, field by field; a non-object yields null. */
function parseWindow(value: unknown): CodexSessionWindow | null {
  if (!record(value)) return null;
  const usedPercent = finiteNumber(value['used_percent']);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 1_000_000) return null;
  return {
    usedPercent,
    windowMinutes: windowMinutes(value['window_minutes']),
    resetsAt: epochSeconds(value['resets_at']),
  };
}

/** Native credits, same strictness as normalizeCodexCredits. */
function parseCredits(value: unknown): CodexSessionCredits | null {
  if (!record(value)) return null;
  const hasCredits = value['has_credits'];
  const unlimited = value['unlimited'];
  const balance = value['balance'];
  if (typeof hasCredits !== 'boolean' || typeof unlimited !== 'boolean') return null;
  if (balance !== null && balance !== undefined) {
    if (typeof balance !== 'string' || balance.length > 64 || !BALANCE.test(balance) ||
      !Number.isFinite(Number(balance))) return null;
  }
  return { hasCredits, unlimited, balance: balance === undefined ? null : (balance as string | null) };
}

export interface CodexParsedRateLimits {
  limitId: string | null;
  limitName: string | null;
  normalModelSlug: string | null;
  primary: CodexSessionWindow | null;
  secondary: CodexSessionWindow | null;
  credits: CodexSessionCredits | null;
  individualLimit: { remainingPercent: number; resetsAt: number | null } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  spendControlReached: boolean | null;
}

/** The allowlisted leaves of one rate_limits object. Returns null when nothing usable. */
function parseRateLimits(value: unknown): CodexParsedRateLimits | null {
  if (!record(value)) return null;
  const out: CodexParsedRateLimits = {
    limitId: null, limitName: null, normalModelSlug: null,
    primary: null, secondary: null, credits: null, individualLimit: null,
    planType: null, rateLimitReachedType: null, spendControlReached: null,
  };
  const limitId = value['limit_id'];
  if (typeof limitId === 'string' && ID.test(limitId)) out.limitId = limitId;
  out.limitName = boundedText(value['limit_name']);
  out.normalModelSlug = boundedText(value['normal_model_slug']);
  out.primary = parseWindow(value['primary']);
  out.secondary = parseWindow(value['secondary']);
  out.credits = parseCredits(value['credits']);
  const individual = value['individual_limit'];
  if (record(individual)) {
    const remaining = finiteNumber(individual['remaining_percent']);
    if (remaining !== null && remaining >= 0 && remaining <= 100) {
      out.individualLimit = { remainingPercent: remaining, resetsAt: epochSeconds(individual['resets_at']) };
    }
  }
  const plan = value['plan_type'];
  if (typeof plan === 'string' && PLAN_TYPES.has(plan)) out.planType = plan;
  const reached = value['rate_limit_reached_type'];
  if (typeof reached === 'string' && REACHED_TYPES.has(reached)) out.rateLimitReachedType = reached;
  const spend = value['spend_control_reached'];
  if (typeof spend === 'boolean') out.spendControlReached = spend;
  if (!out.primary && !out.secondary && !out.credits && !out.planType &&
    !out.rateLimitReachedType && !out.individualLimit && !out.limitId) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Per-line state machine (pure; allowlist only)
// ---------------------------------------------------------------------------

/** Working state folded out of rollout lines; allowlisted fields only. */
export interface CodexSessionParseState {
  observedAt: string | null;
  limits: CodexParsedRateLimits | null;
  model: string | null;
  originator: string | null;
  cliVersion: string | null;
}

/** Extract the allowlisted fields of one rollout line into `state`. */
export function parseCodexSessionLine(line: string, state: CodexSessionParseState): void {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (!record(obj)) return;
  const rowTs = isoString(obj['timestamp']);
  const type = obj['type'];
  const payload = obj['payload'];
  if (type === 'session_meta' && record(payload)) {
    if (state.originator === null) state.originator = boundedText(payload['originator']);
    if (state.cliVersion === null) state.cliVersion = boundedText(payload['cli_version']);
    return;
  }
  if (type === 'turn_context' && record(payload)) {
    const model = boundedText(payload['model']);
    if (model) state.model = model;
    return;
  }
  if (type !== 'event_msg' || !record(payload)) return;
  const inner = payload['type'];
  if (inner === 'session_configured') {
    const model = boundedText(payload['model']);
    if (model) state.model = model;
  }
  // rate_limits rides on token_count today; accept it on any event_msg inner
  // type so older/newer CLI variants keep reporting.
  const limits = parseRateLimits(payload['rate_limits']);
  if (limits) {
    state.limits = limits;
    state.observedAt = rowTs ?? state.observedAt;
  }
}

/** Fold a batch of rollout lines into usage fields. Pure. */
export function parseCodexSessionLines(lines: readonly string[]): CodexSessionParseState {
  const state: CodexSessionParseState = {
    observedAt: null, limits: null, model: null, originator: null, cliVersion: null,
  };
  for (const line of lines) parseCodexSessionLine(line, state);
  return state;
}

// ---------------------------------------------------------------------------
// Account homes
// ---------------------------------------------------------------------------

export interface CodexAccountHome {
  accountId: string;
  slot: 'primary' | 'secondary';
  home: string;
  sessionsDir: string;
}

/**
 * The codex credential homes the fleet knows about. The primary account lives
 * in `$CODEX_HOME` (default `~/.codex`) and the secondary in `$CODEX_HOME_ALT`
 * (default `~/.codex-2`). Identical resolved paths collapse to the primary.
 */
export function codexAccountHomes(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): CodexAccountHome[] {
  const read = (key: string, fallback: string): string => {
    const value = env[key];
    return typeof value === 'string' && value.trim() !== '' ? resolve(value.trim()) : fallback;
  };
  const primary = read('CODEX_HOME', join(homeDir, '.codex'));
  const secondary = read('CODEX_HOME_ALT', join(homeDir, '.codex-2'));
  const homes: CodexAccountHome[] = [
    { accountId: 'codex-cmp', slot: 'primary', home: primary, sessionsDir: join(primary, 'sessions') },
  ];
  if (secondary !== primary) {
    homes.push({
      accountId: 'codex-personal', slot: 'secondary', home: secondary, sessionsDir: join(secondary, 'sessions'),
    });
  }
  return homes;
}

// ---------------------------------------------------------------------------
// Bounded session reader (opens only sessions/rollout-*.jsonl)
// ---------------------------------------------------------------------------

interface SessionFile {
  path: string;
  mtime: number;
  size: number;
}

/** Newest-first rollout files under `<home>/sessions/YYYY/MM/DD/`. Bounded. */
function listSessionFiles(sessionsDir: string): SessionFile[] {
  const result: SessionFile[] = [];
  let discovered = 0;
  let years: string[];
  try {
    years = readdirSync(sessionsDir);
  } catch {
    return result;
  }
  years.sort((a, b) => b.localeCompare(a));
  for (const year of years) {
    const yearPath = join(sessionsDir, year);
    let months: string[];
    try {
      months = readdirSync(yearPath);
    } catch {
      continue;
    }
    months.sort((a, b) => b.localeCompare(a));
    for (const month of months) {
      const monthPath = join(yearPath, month);
      let days: string[];
      try {
        days = readdirSync(monthPath);
      } catch {
        continue;
      }
      days.sort((a, b) => b.localeCompare(a));
      for (const day of days) {
        const dayPath = join(monthPath, day);
        let entries: string[];
        try {
          entries = readdirSync(dayPath);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (discovered >= MAX_DISCOVERY_ENTRIES) {
            result.sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
            return result;
          }
          discovered += 1;
          if (!ROLLOUT_NAME.test(name)) continue;
          const filePath = join(dayPath, name);
          try {
            const stat = statSync(filePath);
            if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) continue;
            result.push({ path: filePath, mtime: stat.mtimeMs, size: stat.size });
          } catch {
            continue;
          }
        }
      }
    }
  }
  result.sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
  return result;
}

function readWindow(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    let n: number;
    try {
      n = readSync(fd, buffer, total, Math.min(READ_CHUNK, length - total), position + total);
    } catch {
      break;
    }
    if (n <= 0) break;
    total += n;
  }
  return buffer.subarray(0, total);
}

function completeLines(buffer: Buffer, skipLeadingPartial: boolean, skipTrailingPartial: boolean): string[] {
  let start = 0;
  let end = buffer.length;
  if (skipLeadingPartial) {
    const first = buffer.indexOf(0x0a);
    if (first === -1) return [];
    start = first + 1;
  }
  if (skipTrailingPartial) {
    const last = buffer.lastIndexOf(0x0a);
    if (last < start) return [];
    end = last;
  }
  if (start >= end) return [];
  return buffer.subarray(start, end).toString('utf8').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Read the allowlisted usage state of one rollout file. The head window feeds
 * session_meta; the tail window feeds the last rate-limit and status records.
 * Returns null when the file cannot be opened or changed under us.
 */
function readRolloutUsage(file: SessionFile): CodexSessionParseState | null {
  const state: CodexSessionParseState = {
    observedAt: null, limits: null, model: null, originator: null, cliVersion: null,
  };
  let fd: number;
  try {
    fd = openSync(file.path, fsConstants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    let size: number;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size !== file.size) {
        return null;
      }
      size = stat.size;
    } catch {
      return null;
    }
    const headLength = Math.min(size, HEAD_BYTES);
    for (const line of completeLines(readWindow(fd, 0, headLength), false, size > headLength)) {
      parseCodexSessionLine(line, state);
    }
    const tailLength = Math.min(size, TAIL_BYTES);
    const tailStart = size - tailLength;
    if (tailStart >= headLength) {
      const tail = readWindow(fd, tailStart, tailLength);
      const preceding = tailStart > 0 ? readWindow(fd, tailStart - 1, 1) : null;
      const startsMidLine = preceding !== null && preceding[0] !== 0x0a;
      for (const line of completeLines(tail, startsMidLine, false)) {
        parseCodexSessionLine(line, state);
      }
    }
    if (state.observedAt === null) state.observedAt = new Date(file.mtime).toISOString();
    return state;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function usageFromState(account: CodexAccountHome, state: CodexSessionParseState): CodexSessionUsage {
  const limits = state.limits;
  return {
    accountId: account.accountId,
    slot: account.slot,
    observedAt: state.observedAt,
    planType: limits?.planType ?? null,
    limitId: limits?.limitId ?? null,
    limitName: limits?.limitName ?? null,
    rateLimitReachedType: limits?.rateLimitReachedType ?? null,
    spendControlReached: limits?.spendControlReached ?? null,
    individualLimit: limits?.individualLimit ?? null,
    model: state.model ?? limits?.normalModelSlug ?? null,
    originator: state.originator,
    cliVersion: state.cliVersion,
    primary: limits?.primary ?? null,
    secondary: limits?.secondary ?? null,
    credits: limits?.credits ?? null,
  };
}

/**
 * Read each account home's newest sessions for the last rate-limit snapshot.
 * Emits one usage per existing credential home; a home whose sessions carry
 * no rate-limit evidence still yields an entry with null windows (unknown is
 * never zero). Never throws; never opens anything outside `<home>/sessions/`.
 */
export function collectCodexSessionUsages(opts?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): CodexSessionUsage[] {
  const usages: CodexSessionUsage[] = [];
  try {
    for (const account of codexAccountHomes(opts?.env, opts?.homeDir)) {
      let isDirectory = false;
      try {
        isDirectory = lstatSync(account.home).isDirectory();
      } catch {
        continue; // no credential home means no account
      }
      if (!isDirectory) continue;
      const empty: CodexSessionUsage = {
        accountId: account.accountId,
        slot: account.slot,
        observedAt: null,
        planType: null,
        limitId: null,
        limitName: null,
        rateLimitReachedType: null,
        spendControlReached: null,
        individualLimit: null,
        model: null,
        originator: null,
        cliVersion: null,
        primary: null,
        secondary: null,
        credits: null,
      };
      for (const file of listSessionFiles(account.sessionsDir).slice(0, CODEX_USAGE_MAX_FILES_PER_HOME)) {
        const state = readRolloutUsage(file);
        if (!state) continue;
        const usage = usageFromState(account, state);
        if (usage.primary || usage.secondary || usage.credits || usage.planType || usage.rateLimitReachedType) {
          usages.push(usage);
          break;
        }
        if (!empty.observedAt) {
          empty.observedAt = state.observedAt;
          empty.model = usage.model;
          empty.originator = usage.originator;
          empty.cliVersion = usage.cliVersion;
        }
      }
      if (usages.every((u) => u.accountId !== account.accountId)) usages.push(empty);
    }
  } catch {
    // never-throws
  }
  return usages;
}

// ---------------------------------------------------------------------------
// resource.v1 report
// ---------------------------------------------------------------------------

/** Re-validate a stored camelCase window (hand-built usage input). */
function validStoredWindow(value: unknown): CodexSessionWindow | null {
  if (!record(value)) return null;
  const usedPercent = finiteNumber(value['usedPercent']);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 1_000_000) return null;
  return {
    usedPercent,
    windowMinutes: windowMinutes(value['windowMinutes']),
    resetsAt: epochSeconds(value['resetsAt']),
  };
}

/** Re-validate a stored camelCase credits object. */
function validStoredCredits(value: unknown): CodexSessionCredits | null {
  if (!record(value)) return null;
  const hasCredits = value['hasCredits'];
  const unlimited = value['unlimited'];
  const balance = value['balance'];
  if (typeof hasCredits !== 'boolean' || typeof unlimited !== 'boolean') return null;
  if (balance !== null &&
    (typeof balance !== 'string' || balance.length > 64 || !BALANCE.test(balance) ||
      !Number.isFinite(Number(balance)))) return null;
  return { hasCredits, unlimited, balance: typeof balance === 'string' ? balance : null };
}

/** Re-validate the stored individual-limit percent. */
function validRemainingPercent(value: unknown): number | null {
  if (!record(value)) return null;
  const percent = value['remainingPercent'];
  return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100
    ? percent : null;
}

function windowKind(window: CodexSessionWindow, id: 'primary' | 'secondary', observedMs: number | null): 'session' | 'weekly' {
  if (id === 'secondary') return 'weekly';
  const distance = window.resetsAt !== null && observedMs !== null ? window.resetsAt * 1000 - observedMs : null;
  if (distance !== null) return distance > SESSION_WINDOW_MAX_MS ? 'weekly' : 'session';
  return (window.windowMinutes ?? 0) > 315 ? 'weekly' : 'session';
}

function validSample(value: unknown): value is CodexUsageSample {
  if (!record(value)) return false;
  const account = value['account'];
  const window = value['window'];
  const at = value['at'];
  const usedPct = value['usedPct'];
  const resetsAt = value['resetsAt'];
  return typeof account === 'string' && ID.test(account) &&
    (window === 'primary' || window === 'secondary') &&
    typeof at === 'string' && Number.isFinite(Date.parse(at)) &&
    typeof usedPct === 'number' && Number.isFinite(usedPct) && usedPct >= 0 && usedPct <= 1_000_000 &&
    (resetsAt === null || typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt)));
}

/**
 * Measured burn for one window: the trailing run of samples in the same reset
 * window whose used percent never decreases. A reset boundary, a reversed
 * counter, or fewer than two samples leaves the rate unknown.
 */
export function burnRate(
  samples: readonly CodexUsageSample[],
  account: string,
  windowId: 'primary' | 'secondary',
): number | null {
  const rows = samples
    .filter((s) => s.account === account && s.window === windowId && s.resetsAt !== null)
    .map((s) => ({ atMs: Date.parse(s.at), usedPct: s.usedPct, resetsAt: s.resetsAt! }))
    .filter((s) => Number.isFinite(s.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1]!;
  let start = rows.length - 1;
  while (start > 0 &&
    rows[start - 1]!.resetsAt === last.resetsAt &&
    rows[start - 1]!.usedPct <= rows[start]!.usedPct) {
    start -= 1;
  }
  const first = rows[start]!;
  const hours = (last.atMs - first.atMs) / 3_600_000;
  if (hours <= 0 || first === last) return null;
  const rate = (last.usedPct - first.usedPct) / hours;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function resourceWindow(
  id: 'primary' | 'secondary',
  window: CodexSessionWindow,
  kind: 'session' | 'weekly',
  observedMs: number | null,
  burn: number | null,
): CodexResourceWindow {
  const usedPct = Math.min(100, Math.max(0, window.usedPercent));
  const leftPct = Math.max(0, 100 - usedPct);
  const resetsMs = window.resetsAt !== null ? window.resetsAt * 1000 : null;
  let runwayHours: number | null = null;
  let projectedExhaustionAt: string | null = null;
  if (burn !== null && burn > 0 && leftPct > 0 && observedMs !== null) {
    runwayHours = leftPct / burn;
    const exhaustMs = observedMs + runwayHours * 3_600_000;
    if (resetsMs === null || exhaustMs < resetsMs) {
      projectedExhaustionAt = new Date(exhaustMs).toISOString();
    }
  }
  return {
    id,
    kind,
    usedPct,
    leftPct,
    windowMinutes: window.windowMinutes,
    resetsAt: resetsMs !== null ? new Date(resetsMs).toISOString() : null,
    burnPctPerHour: burn,
    runwayHours,
    projectedExhaustionAt,
  };
}

/**
 * Fold collected per-account usages plus stored samples into the resource.v1
 * document: used %, left %, reset time, measured burn rate and projected
 * exhaustion per window. Pure.
 */
export function buildCodexResourceReport(
  usages: readonly CodexSessionUsage[],
  samples: readonly CodexUsageSample[],
  nowMs: number,
): CodexResourceReport {
  const resources: CodexAccountResource[] = usages.map((usage) => {
    // Re-validate every emitted field: callers can hand-build a usage object,
    // so the allowlist rules run again at the output boundary.
    const accountId = typeof usage.accountId === 'string' && ID.test(usage.accountId)
      ? usage.accountId : 'codex-unknown';
    const observedAt = isoString(usage.observedAt);
    const observed = observedAt !== null ? Date.parse(observedAt) : null;
    const windows: CodexResourceWindow[] = [];
    for (const [id, window] of [['primary', usage.primary], ['secondary', usage.secondary]] as const) {
      const parsed = validStoredWindow(window);
      if (!parsed) continue;
      windows.push(resourceWindow(id, parsed, windowKind(parsed, id, observed), observed,
        burnRate(samples, accountId, id)));
    }
    const weekly = windows.filter((w) => w.kind === 'weekly')
      .sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1))[0] ?? null;
    const session = windows.filter((w) => w.kind === 'session')
      .sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1))[0] ?? null;
    const hasReading = windows.length > 0;
    const stale = observed === null || nowMs - observed > CODEX_USAGE_STALE_MS;
    return {
      id: accountId,
      provider: 'codex',
      slot: usage.slot === 'secondary' ? 'secondary' : 'primary',
      state: !hasReading ? 'unavailable' : stale ? 'stale' : 'current',
      observedAt,
      plan: typeof usage.planType === 'string' && PLAN_TYPES.has(usage.planType) ? usage.planType : null,
      model: boundedText(usage.model),
      limitId: typeof usage.limitId === 'string' && ID.test(usage.limitId) ? usage.limitId : null,
      limitName: boundedText(usage.limitName),
      cli: { originator: boundedText(usage.originator), version: boundedText(usage.cliVersion) },
      limitReached: typeof usage.rateLimitReachedType === 'string' &&
        REACHED_TYPES.has(usage.rateLimitReachedType),
      spendControlReached: typeof usage.spendControlReached === 'boolean' ? usage.spendControlReached : null,
      weekly,
      session,
      credits: validStoredCredits(usage.credits),
      individualLimitPercent: validRemainingPercent(usage.individualLimit),
    };
  });
  return { v: CODEX_RESOURCE_SCHEMA, generatedAt: new Date(nowMs).toISOString(), resources };
}

/** Samples harvested from one collection pass, for persistence. */
export function codexUsageSamples(usages: readonly CodexSessionUsage[]): CodexUsageSample[] {
  const samples: CodexUsageSample[] = [];
  for (const usage of usages) {
    const accountId = typeof usage.accountId === 'string' && ID.test(usage.accountId)
      ? usage.accountId : 'codex-unknown';
    const observedAt = isoString(usage.observedAt);
    if (!observedAt) continue;
    for (const [id, window] of [['primary', usage.primary], ['secondary', usage.secondary]] as const) {
      const parsed = validStoredWindow(window);
      if (!parsed) continue;
      samples.push({
        account: accountId,
        window: id,
        at: observedAt,
        usedPct: Math.min(100, Math.max(0, parsed.usedPercent)),
        resetsAt: parsed.resetsAt !== null ? new Date(parsed.resetsAt * 1000).toISOString() : null,
      });
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// fleet.json extension
// ---------------------------------------------------------------------------

/**
 * The shared fleet document path: PHANTOM_FLEET_PATH first, then the older
 * PHANTOM_FLEET_FILE, then `$ASHLR_HOME/fleet/fleet.json`.
 */
export function codexFleetUsagePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['PHANTOM_FLEET_PATH'] ?? env['PHANTOM_FLEET_FILE'];
  if (typeof explicit === 'string' && explicit.trim() !== '' && isAbsolute(explicit.trim())) {
    return resolve(explicit.trim());
  }
  const root = env['ASHLR_HOME'];
  const base = typeof root === 'string' && root.trim() !== '' && isAbsolute(root.trim())
    ? root.trim()
    : join(homedir(), '.ashlr');
  return join(base, 'fleet', 'fleet.json');
}

function checkedFleetPath(file: string): string {
  if (!isAbsolute(file) || basename(file) !== 'fleet.json') {
    throw new Error('Expected an absolute fleet.json path');
  }
  return resolve(file);
}

/** Read the codexUsage extension out of an existing fleet document. */
function parseFleetDocument(text: string): { document: Record<string, unknown>; readings: CodexUsageSample[] } {
  const doc: unknown = JSON.parse(text);
  if (!record(doc)) throw new Error('Invalid fleet document');
  if (!Object.hasOwn(doc, CODEX_FLEET_USAGE_KEY)) return { document: doc, readings: [] };
  const extension = doc[CODEX_FLEET_USAGE_KEY];
  if (!record(extension) || extension['v'] !== 1 || !Array.isArray(extension['readings']) ||
    extension['readings'].length > CODEX_USAGE_MAX_SAMPLES ||
    !extension['readings'].every(validSample)) {
    throw new Error('Invalid codex usage history');
  }
  return { document: doc, readings: extension['readings'] as CodexUsageSample[] };
}

function parentDirectoryReady(parent: string): boolean {
  try {
    let existing = parent;
    for (;;) {
      try {
        const stat = lstatSync(existing);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(existing) !== existing) return false;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        existing = dirname(existing);
      }
    }
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = lstatSync(parent);
    return realpathSync(parent) === parent && stat.isDirectory() && !stat.isSymbolicLink() &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
      (process.platform === 'win32' || (stat.mode & 0o022) === 0);
  } catch {
    return false;
  }
}

/**
 * Collect the per-account readings, merge their samples into the fleet
 * document's `codexUsage` extension, and publish the resource.v1 report.
 * Other top-level fleet fields survive. Never throws.
 */
export function publishCodexFleetUsage(opts?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fleetPath?: string;
  nowMs?: number;
  minIntervalMs?: number;
  /** Pre-collected usages (the live path collects once and reuses). */
  usages?: readonly CodexSessionUsage[];
}): CodexFleetPublishResult {
  const env = opts?.env ?? process.env;
  const nowMs = opts?.nowMs ?? Date.now();
  const minInterval = opts?.minIntervalMs ?? CODEX_USAGE_PUBLISH_MIN_INTERVAL_MS;
  let file = '';
  const report = (usages: readonly CodexSessionUsage[], samples: readonly CodexUsageSample[]) =>
    buildCodexResourceReport(usages, samples, nowMs);
  try {
    file = checkedFleetPath(opts?.fleetPath ?? codexFleetUsagePath(env));
  } catch {
    return { state: 'unavailable', path: file, report: report([], []) };
  }
  if (minInterval > 0 && nowMs - lastPublishAttemptMs < minInterval) {
    return { state: 'throttled', path: file, report: report([], []) };
  }
  try {
    const usages = opts?.usages ?? collectCodexSessionUsages({ env, homeDir: opts?.homeDir });
    const hasReading = usages.some((u) => u.primary || u.secondary || u.credits || u.rateLimitReachedType);
    const parent = dirname(file);
    if (!parentDirectoryReady(parent)) {
      return { state: 'unavailable', path: file, report: report(usages, []) };
    }
    const lock = acquireLocalStoreLock(join(parent, '.fleet-locks', 'fleet.json.lock'), 250, { anchorPath: parent });
    if (!lock) return { state: 'locked', path: file, report: report(usages, []) };
    try {
      let document: Record<string, unknown> = {};
      let stored: CodexUsageSample[] = [];
      let exists = true;
      try {
        lstatSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else {
          lastPublishAttemptMs = nowMs;
          return { state: 'refused', path: file, report: report(usages, []) };
        }
      }
      if (exists) {
        const read = readStableRegularFile(file, {
          anchorPath: parent, maxFileBytes: MAX_FLEET_BYTES, remainingBytes: MAX_FLEET_BYTES,
        });
        if (!read.ok) {
          lastPublishAttemptMs = nowMs;
          return { state: 'refused', path: file, report: report(usages, []) };
        }
        try {
          ({ document, readings: stored } = parseFleetDocument(read.text));
        } catch {
          lastPublishAttemptMs = nowMs;
          return { state: 'refused', path: file, report: report(usages, []) };
        }
      }
      // No reading and nothing previously published: nothing to say. When an
      // extension already exists the write still happens so the resources
      // flip to 'unavailable' rather than masquerading as fresh.
      if (!hasReading && !exists) {
        lastPublishAttemptMs = nowMs;
        return { state: 'empty', path: file, report: report(usages, []) };
      }
      if (!hasReading && !Object.hasOwn(document, CODEX_FLEET_USAGE_KEY)) {
        lastPublishAttemptMs = nowMs;
        return { state: 'empty', path: file, report: report(usages, []) };
      }
      const seen = new Set(stored.map((s) => `${s.account} ${s.window} ${s.at} ${s.usedPct} ${s.resetsAt}`));
      const merged = [...stored];
      for (const sample of codexUsageSamples(usages)) {
        const key = `${sample.account} ${sample.window} ${sample.at} ${sample.usedPct} ${sample.resetsAt}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(sample);
        }
      }
      const readings = merged.slice(-CODEX_USAGE_MAX_SAMPLES);
      const next: CodexFleetUsageExtension = { v: 1, report: report(usages, readings), readings };
      const previous = document[CODEX_FLEET_USAGE_KEY];
      if (merged.length === stored.length && record(previous) &&
        JSON.stringify(previous.report) === JSON.stringify(next.report)) {
        lastPublishAttemptMs = nowMs;
        return { state: 'unchanged', path: file, report: next.report };
      }
      const text = JSON.stringify({ ...document, [CODEX_FLEET_USAGE_KEY]: next }, null, 2) + '\n';
      if (Buffer.byteLength(text) > MAX_FLEET_BYTES || !ownsLocalStoreLock(lock)) {
        lastPublishAttemptMs = nowMs;
        return { state: 'unavailable', path: file, report: next.report };
      }
      writePrivateFileAtomically(
        join(parent, `.fleet-${randomUUID()}.tmp`), file, text,
        { anchorPath: parent, label: 'Fleet codex usage' },
      );
      lastPublishAttemptMs = nowMs;
      return { state: 'published', path: file, report: next.report };
    } finally {
      releaseLocalStoreLock(lock);
    }
  } catch {
    return { state: 'unavailable', path: file, report: report([], []) };
  }
}

/**
 * Read back the `codexUsage` extension for status surfaces and tests.
 * Bounded and stable; returns null when absent, unsafe, or invalid.
 */
export function readCodexFleetUsage(filePath?: string): CodexFleetUsageExtension | null {
  try {
    const file = checkedFleetPath(filePath ?? codexFleetUsagePath());
    const read = readStableRegularFile(file, {
      anchorPath: dirname(file), maxFileBytes: MAX_FLEET_BYTES, remainingBytes: MAX_FLEET_BYTES,
    });
    if (!read.ok) return null;
    const doc = JSON.parse(read.text) as Record<string, unknown>;
    const extension = doc[CODEX_FLEET_USAGE_KEY];
    if (!record(extension) || extension['v'] !== 1 || !record(extension['report']) ||
      extension['report']['v'] !== CODEX_RESOURCE_SCHEMA ||
      !Array.isArray(extension['readings']) || !extension['readings'].every(validSample)) return null;
    return extension as unknown as CodexFleetUsageExtension;
  } catch {
    return null;
  }
}

/** Test hook: reset the in-memory publish throttle. */
export function resetCodexUsagePublishThrottle(): void {
  lastPublishAttemptMs = 0;
}
