/**
 * Runtime-dynamic fleet config (RQ-DYNCONFIG-1): layered, restart-free.
 *
 * Layers, lowest to highest precedence:
 *   pinned defaults < slots.json < budget-overrides.json < live control file < one-shot CLI
 *
 * - The live control file is `<runsDir>/queue/live-config.json`. Every write is
 *   temp+rename (never a torn file) under a lock, and appends one line to
 *   `queue/live-config-audit.jsonl` recording who/when/why, extending the
 *   `last_change_by` attribution slots.json already carries.
 * - Readers call `ConfigReader.resolve()`; each file is re-parsed only when its
 *   (mtime, size, inode) signature changes. A torn or corrupt file keeps the
 *   last good parse and reports the layer as `degraded`.
 * - Only the keys in MUTABLE_KEYS can be overridden live. Anything matching
 *   RESTART_REQUIRED is refused by the writer and ignored by the resolver even
 *   if someone hand-edits it into the file. Deny wins over allow.
 * - With no live file and no CLI overrides the effective values equal the
 *   slots.json / budget-overrides.json values, so existing readers are unchanged.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const LIVE_CONFIG_FILE = 'live-config.json';
export const LIVE_CONFIG_AUDIT_FILE = 'live-config-audit.jsonl';
export const CONFIG_AUDIT_SCHEMA = 'fleet.config.audit.v1';
export const CONFIG_LAYERS = ['default', 'slots', 'budget', 'live', 'cli'] as const;
export type ConfigLayer = (typeof CONFIG_LAYERS)[number];
export type ConfigValue = number | string | boolean;
export type LayerState = 'healthy' | 'missing' | 'degraded';

const LANE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const MAX_FILE = 256 * 1024;
const MAX_AUDIT_TAIL = 1024 * 1024;
const MAX_REASON = 200;

interface KeySpec { integer: boolean; min: number; max: number }
const INT = (max: number): KeySpec => ({ integer: true, min: 0, max });
const GB: KeySpec = { integer: false, min: 0, max: 100_000 };

/** Pinned defaults for mutable keys that have one (the lowest layer). */
export const PINNED_DEFAULTS: Readonly<Record<string, ConfigValue>> = Object.freeze({
  'compact.lanes.raise_freeze_below_gb': 60,
  'compact.lanes.halve_below_gb': 35,
  // Memory one local worker is assumed to need until real samples exist (phm local capacity).
  'local.worker_gb': 6,
});

/** Allowlist: the ONLY keys a live or one-shot override may set. */
export function mutableKeySpec(key: string): KeySpec | null {
  if (key === 'hard_cap') return INT(512);
  // Autofill kill switch: 1 stops self-tick from filling starved lanes (cap and events live in autofill-run.ts).
  if (key === 'autofill.off') return INT(1);
  // Owner digest kill switch, also used by the recovered tick helper.
  if (key === 'mason.digest.off') return INT(1);
  // Empty-family stop kill switch: 1 stops self-tick from retiring READY jobs of empty-heavy families (empty-family-apply.ts).
  if (key === 'empty_stop.off') return INT(1);
  if (key === 'local.worker_gb') return { integer: false, min: 0.5, max: 512 };
  if (key === 'compact.lanes.raise_freeze_below_gb' || key === 'compact.lanes.halve_below_gb') return GB;
  const m = /^lanes\.([^.]+)\.(target|floor|ceiling|hard_cap)$/.exec(key);
  return m && LANE_ID.test(m[1]!) ? INT(64) : null;
}
export const MUTABLE_KEY_PATTERNS: readonly string[] = [
  'hard_cap', 'autofill.off', 'mason.digest.off', 'empty_stop.off', 'lanes.<lane>.target', 'lanes.<lane>.floor', 'lanes.<lane>.ceiling', 'lanes.<lane>.hard_cap',
  'compact.lanes.raise_freeze_below_gb', 'compact.lanes.halve_below_gb', 'local.worker_gb',
];

export interface RestartRule { category: string; pattern: RegExp; why: string }
/**
 * Never runtime-mutable. Changing any of these needs an owner edit and a
 * daemon restart. Matched against every dot-separated segment of a key, so
 * nesting cannot smuggle one past the check.
 */
export const RESTART_REQUIRED: readonly RestartRule[] = [
  { category: 'security-pins', pattern: /^(security|pins?|pinned|allowlist|denylist|sandbox|ownership|owner)([_-].*)?$/i, why: 'security pins change only through the owner and a restart' },
  { category: 'paid-model-blocks', pattern: /^(paid|billing)([_-].*)?$|block(s|ed|list)?/i, why: 'paid-model blocks are a spend control; never loosened at runtime' },
  { category: 'credential-paths', pattern: /(cred|secret|token|keychain|keyfile|password|api[_-]?key)|^auth([_-].*)?$|[_-](path|file|dir)$/i, why: 'credential and file-location settings are read once at startup' },
  { category: 'gates-files', pattern: /^(.*[_-])?gates?([_-].*)?$/i, why: 'GATES files and gate definitions are owner-reviewed and restart-loaded' },
];

export type KeyVerdict =
  | { ok: true; spec: KeySpec }
  | { ok: false; code: 'restart-required'; category: string; why: string }
  | { ok: false; code: 'unknown-key' };

export function classifyKey(key: string): KeyVerdict {
  if (typeof key !== 'string' || !key || key.length > 120 || !/^[A-Za-z0-9_.-]+$/.test(key)) return { ok: false, code: 'unknown-key' };
  const segments = key.split('.');
  for (const rule of RESTART_REQUIRED) {
    if (segments.some(s => rule.pattern.test(s))) return { ok: false, code: 'restart-required', category: rule.category, why: rule.why };
  }
  const spec = mutableKeySpec(key);
  return spec ? { ok: true, spec } : { ok: false, code: 'unknown-key' };
}

export class DynConfigError extends Error {
  constructor(readonly code: 'restart-required' | 'unknown-key' | 'invalid-value' | 'invalid-reason' | 'unavailable' | 'locked', message: string) {
    super(message);
    this.name = 'DynConfigError';
  }
}

function requireMutable(key: string): KeySpec {
  const verdict = classifyKey(key);
  if (verdict.ok) return verdict.spec;
  if (verdict.code === 'restart-required') throw new DynConfigError('restart-required', `${key} is restart-required (${verdict.category}): ${verdict.why}`);
  throw new DynConfigError('unknown-key', `${key} is not a runtime-mutable key`);
}

/** Validate a candidate value for a mutable key; throws DynConfigError. */
export function validateOverride(key: string, value: unknown): ConfigValue {
  const { integer, min, max } = requireMutable(key);
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) {
    throw new DynConfigError('invalid-value', `${key} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return value;
}

export interface LiveEntry { value: ConfigValue; by: string; at: string; reason: string }
export interface LiveConfigFile { v: 1; last_change_by: string; overrides: Record<string, LiveEntry> }
export interface Provenance { layer: ConfigLayer; by?: string; at?: string; reason?: string }
export interface ResolvedConfig {
  values: Record<string, ConfigValue>;
  provenance: Record<string, Provenance>;
  layers: Record<ConfigLayer, LayerState>;
  /** Live/CLI entries ignored because the key is restart-required, unknown or out of range. */
  rejected: { layer: 'live' | 'cli'; key: string; reason: string }[];
}
export interface ConfigOptions { runsDir?: string; now?: () => Date }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, ' ').trim(); // eslint-disable-line no-control-regex
const isPrimitive = (v: unknown): v is ConfigValue => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' || typeof v === 'boolean';

export function runsDirOf(opts: ConfigOptions = {}): string {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(root)) throw new DynConfigError('unavailable', 'runs dir must be absolute');
  return root;
}
const queueDir = (opts: ConfigOptions): string => join(runsDirOf(opts), 'queue');

/** Flatten slots.json (direct or `lanes`-wrapped lane map) into dot keys. */
function flattenSlots(raw: unknown): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  if (!isObject(raw)) return out;
  if (typeof raw.hard_cap === 'number' && Number.isFinite(raw.hard_cap)) out.hard_cap = raw.hard_cap;
  const lanes = Object.hasOwn(raw, 'lanes') && isObject(raw.lanes) ? raw.lanes : raw;
  for (const [lane, row] of Object.entries(lanes)) {
    if (!LANE_ID.test(lane) || !isObject(row)) continue;
    for (const field of ['target', 'floor', 'ceiling', 'hard_cap']) {
      const v = row[field];
      if (typeof v === 'number' && Number.isFinite(v)) out[`lanes.${lane}.${field}`] = v;
    }
  }
  return out;
}
/** Flatten nested primitives of budget-overrides.json into dot keys (bounded depth). */
function flattenBudget(raw: unknown): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  const walk = (node: unknown, prefix: string, depth: number): void => {
    if (!isObject(node) || depth > 6) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '__proto__' || !/^[A-Za-z0-9_-]+$/.test(k)) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (isPrimitive(v)) out[key] = v; else walk(v, key, depth + 1);
    }
  };
  walk(raw, '', 0);
  return out;
}
function parseLive(raw: unknown): LiveConfigFile | null {
  if (!isObject(raw) || raw.v !== 1 || !isObject(raw.overrides)) return null;
  const overrides: Record<string, LiveEntry> = {};
  for (const [key, e] of Object.entries(raw.overrides)) {
    if (!isObject(e) || !isPrimitive(e.value)) return null;
    overrides[key] = { value: e.value, by: typeof e.by === 'string' ? e.by : '', at: typeof e.at === 'string' ? e.at : '', reason: typeof e.reason === 'string' ? e.reason : '' };
  }
  return { v: 1, last_change_by: typeof raw.last_change_by === 'string' ? raw.last_change_by : '', overrides };
}

type Cached = { sig: string; value: unknown; state: LayerState };
/** Read + JSON.parse a bounded regular file. 'missing' on ENOENT; throws on anything unsafe or torn. */
async function readJsonFile(path: string): Promise<{ sig: string; value: unknown } | 'missing'> {
  let st;
  try { st = await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw e; }
  if (!st.isFile() || st.size > MAX_FILE) throw new DynConfigError('unavailable', 'not a bounded regular file');
  const sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
  return { sig, value: JSON.parse(await readFile(path, 'utf8')) };
}

export interface ConfigReader {
  resolve(cli?: Record<string, unknown>): Promise<ResolvedConfig>;
  /** Number of actual file parses so far (tests and diagnostics). */
  readonly parses: number;
}

/** mtime-triggered reader: re-parses a layer file only when its signature changes. */
export function createConfigReader(opts: ConfigOptions & { defaults?: Record<string, ConfigValue> } = {}): ConfigReader {
  const queue = queueDir(opts);
  const cache = new Map<string, Cached>();
  let parses = 0;
  const load = async (name: string): Promise<Cached> => {
    const path = join(queue, name);
    const prev = cache.get(name);
    try {
      const st = await lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
      if (!st) { const c: Cached = { sig: 'missing', value: undefined, state: 'missing' }; cache.set(name, c); return c; }
      if (prev && prev.state === 'healthy' && prev.sig === `${st.mtimeMs}:${st.size}:${st.ino}`) return prev;
      const got = await readJsonFile(path);
      parses++;
      if (got === 'missing') { const c: Cached = { sig: 'missing', value: undefined, state: 'missing' }; cache.set(name, c); return c; }
      const c: Cached = { sig: got.sig, value: got.value, state: 'healthy' };
      cache.set(name, c);
      return c;
    } catch {
      // Keep the last good value so a torn write never blanks live config.
      const c: Cached = { sig: prev?.sig ?? 'degraded', value: prev?.value, state: 'degraded' };
      cache.set(name, c);
      return c;
    }
  };
  return {
    get parses() { return parses; },
    async resolve(cli = {}) {
      const [slots, budget, live] = await Promise.all([load('slots.json'), load('budget-overrides.json'), load(LIVE_CONFIG_FILE)]);
      const values: Record<string, ConfigValue> = {};
      const provenance: Record<string, Provenance> = {};
      const rejected: ResolvedConfig['rejected'] = [];
      const put = (layer: ConfigLayer, src: Record<string, ConfigValue>, who?: (k: string) => Partial<Provenance>): void => {
        for (const [k, v] of Object.entries(src)) { values[k] = v; provenance[k] = { layer, ...(who?.(k) ?? {}) }; }
      };
      put('default', { ...PINNED_DEFAULTS, ...(opts.defaults ?? {}) });
      put('slots', flattenSlots(slots.value));
      put('budget', flattenBudget(budget.value));
      const liveFile = live.state === 'missing' ? null : parseLive(live.value);
      const liveState: LayerState = live.state === 'healthy' && !liveFile ? 'degraded' : live.state;
      const accepted: Record<string, ConfigValue> = {};
      for (const [key, e] of Object.entries(liveFile?.overrides ?? {})) {
        try { accepted[key] = validateOverride(key, e.value); } catch (err) { rejected.push({ layer: 'live', key, reason: (err as Error).message }); }
      }
      put('live', accepted, k => ({ by: liveFile!.overrides[k]!.by, at: liveFile!.overrides[k]!.at, reason: liveFile!.overrides[k]!.reason }));
      const cliOk: Record<string, ConfigValue> = {};
      for (const [key, v] of Object.entries(cli)) {
        try { cliOk[key] = validateOverride(key, v); } catch (err) { rejected.push({ layer: 'cli', key, reason: (err as Error).message }); }
      }
      put('cli', cliOk);
      return { values, provenance, rejected, layers: { default: 'healthy', slots: slots.state, budget: budget.state, live: liveState, cli: 'healthy' } };
    },
  };
}

const sharedReaders = new Map<string, ConfigReader>();
/** Process-wide reader per runs dir so long-lived callers get the mtime cache for free. */
export function sharedConfigReader(opts: ConfigOptions = {}): ConfigReader {
  const dir = runsDirOf(opts);
  let r = sharedReaders.get(dir);
  if (!r) { r = createConfigReader({ runsDir: dir }); sharedReaders.set(dir, r); }
  return r;
}

/** Live override for one key, or undefined. Never throws; used by existing readers to overlay. */
export async function liveOverride(key: string, opts: ConfigOptions = {}): Promise<number | undefined> {
  try {
    const r = await sharedConfigReader(opts).resolve();
    const v = r.values[key];
    return r.provenance[key]?.layer === 'live' && typeof v === 'number' ? v : undefined;
  } catch { return undefined; }
}

// ---- writes ---------------------------------------------------------------

async function withLock<T>(queue: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(queue, '.live-config.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      const h = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new DynConfigError('unavailable', 'cannot take config lock');
      const age = await lstat(lock).then(s => Date.now() - s.mtimeMs, () => 0);
      if (age > 10_000) { await unlink(lock).catch(() => {}); continue; } // stale lock from a crashed writer
      if (attempt >= 100) throw new DynConfigError('locked', 'live config is being written by another process');
      await new Promise(r => setTimeout(r, 20));
    }
  }
  try { return await fn(); } finally { await unlink(lock).catch(() => {}); }
}

export interface ChangeRequest { key: string; value?: unknown; by: string; reason: string }
export interface AuditEntry { v: 1; at: string; op: 'set' | 'unset'; key: string; from: ConfigValue | null; to: ConfigValue | null; by: string; reason: string }

async function readLiveForWrite(path: string): Promise<LiveConfigFile> {
  let got;
  try { got = await readJsonFile(path); } catch { throw new DynConfigError('unavailable', 'live-config.json is unreadable; refusing to overwrite it'); }
  if (got === 'missing') return { v: 1, last_change_by: '', overrides: {} };
  const parsed = parseLive(got.value);
  if (!parsed) throw new DynConfigError('unavailable', 'live-config.json is malformed; refusing to overwrite it');
  return parsed;
}

async function change(op: 'set' | 'unset', req: ChangeRequest, opts: ConfigOptions): Promise<AuditEntry> {
  const by = clean(req.by);
  const reason = clean(req.reason ?? '');
  if (!by) throw new DynConfigError('invalid-reason', 'a change needs a non-empty actor (by)');
  if (!reason || reason.length > MAX_REASON) throw new DynConfigError('invalid-reason', `a change needs a reason of 1 to ${MAX_REASON} characters`);
  // Classification runs first so a restart-required key is refused with its category even for unset.
  const value = op === 'set' ? validateOverride(req.key, req.value) : (requireMutable(req.key), null);
  const queue = queueDir(opts);
  await mkdir(queue, { recursive: true, mode: 0o700 });
  return withLock(queue, async () => {
    const path = join(queue, LIVE_CONFIG_FILE);
    const file = await readLiveForWrite(path);
    const iso = (opts.now ?? (() => new Date()))().toISOString();
    const from = file.overrides[req.key]?.value ?? null;
    if (op === 'set') {
      // Keep lane bounds coherent against the effective sibling values.
      const m = /^lanes\.([^.]+)\.(target|floor|ceiling)$/.exec(req.key);
      if (m) {
        const eff = (await createConfigReader({ ...opts, runsDir: runsDirOf(opts) }).resolve()).values;
        const get = (f: string): number | undefined => (f === m[2] ? (value as number) : (eff[`lanes.${m[1]}.${f}`] as number | undefined));
        const [t, lo, hi] = [get('target'), get('floor'), get('ceiling')];
        if (lo !== undefined && hi !== undefined && lo > hi) throw new DynConfigError('invalid-value', `floor ${lo} would exceed ceiling ${hi}`);
        if (t !== undefined && lo !== undefined && hi !== undefined && (t < lo || t > hi)) throw new DynConfigError('invalid-value', `target ${t} would fall outside ${lo}..${hi}`);
      }
      file.overrides[req.key] = { value: value as ConfigValue, by, at: iso, reason };
    } else {
      if (!(req.key in file.overrides)) throw new DynConfigError('unknown-key', `${req.key} has no live override to remove`);
      delete file.overrides[req.key];
    }
    file.last_change_by = `${by} ${iso}`;
    const text = `${JSON.stringify(file, null, 1)}\n`;
    if (Buffer.byteLength(text) > MAX_FILE) throw new DynConfigError('unavailable', 'live config too large');
    const entry: AuditEntry = { v: 1, at: iso, op, key: req.key, from, to: value, by, reason };
    // Open the audit sink before committing; refuse symlinks (O_NOFOLLOW), never block on FIFOs.
    const log = await open(join(queue, LIVE_CONFIG_AUDIT_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
      .catch(() => { throw new DynConfigError('unavailable', 'audit log is not writable; change refused'); });
    let temp: string | undefined;
    try {
      const st = await log.stat();
      if (!st.isFile() || st.nlink !== 1) throw new DynConfigError('unavailable', 'audit log is not a plain file; change refused');
      temp = join(queue, `.live-config-${randomUUID()}.tmp`);
      const h = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await h.writeFile(text); await h.sync(); } finally { await h.close(); }
      await rename(temp, path); // atomic: readers see the old or the new file, never a mix
      temp = undefined;
      await log.writeFile(`${JSON.stringify(entry)}\n`);
    } finally {
      await log.close();
      if (temp) await unlink(temp).catch(() => {});
    }
    return entry;
  });
}

export const setLiveOverride = (req: ChangeRequest, opts: ConfigOptions = {}): Promise<AuditEntry> => change('set', req, opts);
export const clearLiveOverride = (req: ChangeRequest, opts: ConfigOptions = {}): Promise<AuditEntry> => change('unset', req, opts);

export interface ConfigAuditReport {
  schema: typeof CONFIG_AUDIT_SCHEMA;
  state: LayerState;
  last_change_by: string | null;
  /** Active overrides with who/when/why. */
  active: ({ key: string } & LiveEntry)[];
  /** Newest last, capped to `limit`. */
  entries: AuditEntry[];
  malformedLines: number;
}

export async function readConfigAudit(opts: ConfigOptions & { limit?: number } = {}): Promise<ConfigAuditReport> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
  const report: ConfigAuditReport = { schema: CONFIG_AUDIT_SCHEMA, state: 'healthy', last_change_by: null, active: [], entries: [], malformedLines: 0 };
  const queue = queueDir(opts);
  try {
    const got = await readJsonFile(join(queue, LIVE_CONFIG_FILE));
    if (got !== 'missing') {
      const live = parseLive(got.value);
      if (!live) report.state = 'degraded';
      else {
        report.last_change_by = live.last_change_by || null;
        report.active = Object.entries(live.overrides).sort(([a], [b]) => a.localeCompare(b)).map(([key, e]) => ({ key, ...e }));
      }
    }
  } catch { report.state = 'degraded'; }
  try {
    const path = join(queue, LIVE_CONFIG_AUDIT_FILE);
    const st = await lstat(path);
    if (!st.isFile()) throw new Error('not a file');
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const len = Math.min(st.size, MAX_AUDIT_TAIL);
      const buf = Buffer.alloc(len);
      await h.read(buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n');
      if (st.size > len) lines.shift(); // first line of a tail window may be cut
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as AuditEntry;
          if (e?.v === 1 && (e.op === 'set' || e.op === 'unset') && typeof e.key === 'string' && typeof e.at === 'string') report.entries.push(e); else report.malformedLines++;
        } catch { report.malformedLines++; }
      }
    } finally { await h.close(); }
    report.entries = report.entries.slice(-limit);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') report.state = 'degraded';
    else if (report.state === 'healthy' && report.active.length === 0 && report.last_change_by === null) report.state = 'missing';
  }
  return report;
}
