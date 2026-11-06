/** Host-issued native CLI evidence. It is never an operator setting or a billing balance. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { devinCliCredentialsPath, probeDevinCli } from './cli-probe.js';
import { parseDevinModelsList } from './models.js';

const METADATA_MAX_AGE_MS = 60_000;
const RETRY_MS = 10 * 60_000;
const issued = new WeakSet<object>();
const entries = new Map<string, DevinCliExecutionBinding>();
const flights = new Map<string, Promise<readonly DevinCliExecutionBinding[]>>();
const catalogs = new Map<string, readonly DevinCliExecutionBinding[]>();
const failures = new Map<string, number>();
let selected: DevinCliExecutionBinding | null = null;

export interface DevinCliExecutionBinding {
  readonly selectedPath: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly executableEpoch: string;
  readonly credentialsPath: string;
  readonly credentialsEpoch: string;
  /** Native principal consistency only. Never interpreted as the cloud organization or billing account. */
  readonly principalDigest: string;
  readonly principalBasis: 'user-id' | 'email';
  readonly teamDigest: string | null;
  readonly originDigest: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly observedAt: number;
  readonly validUntil: number;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function epoch(path: string, executable: boolean): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n ||
    stat.size > BigInt(executable ? 512 * 1024 * 1024 : 2 * 1024 * 1024) ||
    (stat.mode & 18n) !== 0n || (!executable && typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) ||
    (executable && (stat.mode & 73n) === 0n) || realpathSync(path) !== path) throw new Error('unqualified native file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].map(String).join(':');
}

/** Parse only identity metadata from the supported plaintext native status. No raw output survives. */
export function parseDevinCliPrincipal(text: string): Pick<DevinCliExecutionBinding, 'principalDigest' | 'principalBasis' | 'teamDigest' | 'originDigest'> | null {
  const clean = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''); // eslint-disable-line no-control-regex
  if (!/logged\s+in/i.test(clean) || /not\s+logged\s+in|logged\s+out/i.test(clean)) return null;
  const fields = new Map<string, string>();
  for (const line of clean.split(/\r?\n/)) {
    const match = /^\s*(User ID|Team ID|Email|API server|Devin API):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1]!) || Buffer.byteLength(match[2]!) > 4096 || /[\u0000-\u001f\u007f]/.test(match[2]!)) return null; // eslint-disable-line no-control-regex
    fields.set(match[1]!, match[2]!);
  }
  const usable = (s: string | undefined): s is string => Boolean(s && !['none', 'null', 'n/a', '-', '(none)'].includes(s.toLowerCase()));
  const user = fields.get('User ID'); const email = fields.get('Email');
  const principal = usable(user) ? user : usable(email) && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
  if (!principal) return null;
  const origins: string[] = [];
  for (const key of ['API server', 'Devin API']) {
    const raw = fields.get(key);
    if (!usable(raw)) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !/^(?:[a-z0-9-]+\.)*(?:devin\.ai|codeium\.com)$/.test(url.hostname)) return null;
      origins.push(url.origin);
    } catch { return null; }
  }
  const team = fields.get('Team ID');
  return { principalDigest: digest(JSON.stringify(['devin-native-principal-v1', origins, usable(user) ? 'user-id' : 'email', principal])),
    principalBasis: usable(user) ? 'user-id' : 'email', teamDigest: usable(team) ? digest(team) : null,
    originDigest: digest(JSON.stringify(origins)) };
}

export interface DevinCliAdmissionOptions {
  /** Renew native metadata before a long-running role crosses its evidence TTL. */
  forceRefresh?: boolean;
  cliPath?: string;
  credentialsPath?: string;
  now?: () => number;
  signal?: AbortSignal;
  /** Existing caller-owned Stop/revision fence; never persisted. */
  admitted?: () => boolean;
  /** Hermetic subprocess seam; production uses the exact native executable. */
  runMetadata?: (executable: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

function admitted(opts: DevinCliAdmissionOptions): boolean {
  try { return !opts.signal?.aborted && (opts.admitted === undefined || opts.admitted() === true); } catch { return false; }
}
function nativeMetadata(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, [...args], {
    env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}),
  }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
}

/** Cheap contact-time continuity. No provider request, credential contents or binary rehash. */
export function devinCliIdentityCurrent(binding: DevinCliExecutionBinding | null | undefined, model: string): binding is DevinCliExecutionBinding {
  if (!binding || !issued.has(binding) || binding.model !== model) return false;
  try { return realpathSync(binding.selectedPath) === binding.executable && epoch(binding.executable, true) === binding.executableEpoch &&
    epoch(binding.credentialsPath, false) === binding.credentialsEpoch; } catch { return false; }
}
/** Historical run settlement only. This proves launch continuity, never fresh
 * pricing, quota or permission to contact the provider again. */
export function peekDevinCliIdentityBinding(model: string): DevinCliExecutionBinding | null {
  if (selected?.credentialsPath !== devinCliCredentialsPath()) return null;
  for (const binding of entries.values()) {
    if (binding.executable === selected.executable && binding.credentialsPath === selected.credentialsPath &&
      devinCliIdentityCurrent(binding, model)) return binding;
  }
  return null;
}
export function devinCliBindingCurrent(binding: DevinCliExecutionBinding | null | undefined, model: string, now = Date.now()): binding is DevinCliExecutionBinding {
  return devinCliIdentityCurrent(binding, model) && Number.isFinite(now) && now >= binding.observedAt && now < binding.validUntil;
}
export function peekDevinCliExecutionBinding(model: string, now = Date.now()): DevinCliExecutionBinding | null {
  if (selected?.credentialsPath !== devinCliCredentialsPath()) return null;
  for (const binding of entries.values()) {
    if (binding.executable === selected.executable && binding.credentialsPath === selected.credentialsPath && devinCliBindingCurrent(binding, model, now)) return binding;
  }
  return null;
}

/** One same-tuple native auth/catalog refresh. Failed/unknown/fallback evidence cannot admit a spawn. */
async function refreshBindings(model: string | null, opts: DevinCliAdmissionOptions): Promise<readonly DevinCliExecutionBinding[]> {
  const now = opts.now ?? Date.now;
  // Tests must supply a hermetic metadata transport; never probe the operator's native account.
  if (!admitted(opts) || (process.env['VITEST'] && !opts.runMetadata)) return [];
  try {
    const selectedPath = opts.cliPath ?? (await probeDevinCli()).cliPath;
    if (!selectedPath) return [];
    const executable = realpathSync(selectedPath);
    const credentialsPath = opts.credentialsPath ?? devinCliCredentialsPath();
    if (basename(credentialsPath) !== 'credentials.toml' || basename(dirname(credentialsPath)) !== 'devin') return [];
    const executableEpoch = epoch(executable, true); const credentialsEpoch = epoch(credentialsPath, false);
    const tuple = [selectedPath, executable, executableEpoch, credentialsPath, credentialsEpoch];
    const key = JSON.stringify([...tuple, model]);
    const tupleKey = JSON.stringify(tuple);
    const cached = model === null ? catalogs.get(tupleKey) : entries.has(key) ? [entries.get(key)!] : undefined;
    if (!opts.forceRefresh && cached?.length && cached.every(binding => devinCliBindingCurrent(binding, binding.model, now())) && admitted(opts)) { selected = cached[0]!; return cached; }
    const failed = failures.get(key) ?? failures.get(tupleKey);
    if (failed !== undefined && now() >= failed && now() - failed < RETRY_MS) return [];
    if (!flights.has(tupleKey)) {
      // Catalog discovery and selected-model renewal share the SAME tuple flight.
      // A later denial cannot race an older independent Free result.
      const flight = (async () => {
        const startedAt = now();
        const env: NodeJS.ProcessEnv = {};
        for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'WINDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
        env['XDG_DATA_HOME'] = dirname(dirname(credentialsPath)); env['NO_COLOR'] = '1';
        const run = opts.runMetadata ?? ((bin, args, e) => nativeMetadata(bin, args, e, opts.signal));
        if (!admitted(opts)) return [];
        const principal = parseDevinCliPrincipal(await run(executable, ['auth', 'status'], env));
        if (!principal || !admitted(opts) || epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch) return [];
        // UI parsing normally de-duplicates IDs. Admission must retain contradictions.
        const catalog = parseDevinModelsList(await run(executable, ['models', 'list'], env), { retainDuplicateIds:true });
        if (catalog.declaredFamilyCount === null || catalog.declaredFamilyCount !== catalog.families.length) return [];
        const allRows = catalog.families.flatMap(f => f.models);
        const counts = new Map<string, number>();
        for (const row of allRows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
        const rows = allRows.filter(row => counts.get(row.id) === 1);
        if (!admitted(opts) || epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch) return [];
        const afterPrincipal = parseDevinCliPrincipal(await run(executable, ['auth', 'status'], env));
        if (!afterPrincipal || JSON.stringify(afterPrincipal) !== JSON.stringify(principal)) return [];
        const observedAt = now();
        if (!admitted(opts) || !Number.isFinite(observedAt) || observedAt < startedAt ||
          epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch || realpathSync(selectedPath) !== executable) return [];
        const validUntil = observedAt + METADATA_MAX_AGE_MS;
        if (!Number.isFinite(validUntil) || observedAt >= validUntil) return [];
        const eligible = rows.filter(row => row.pricing.free &&
          [row.pricing.inPerM, row.pricing.outPerM, row.pricing.cachedPerM].every(n => n === null || n === 0) &&
          row.contextTokens !== null && Number.isSafeInteger(row.contextTokens) && row.contextTokens > 0);
        if (!eligible.length) return [];
        const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
        if (!admitted(opts) || epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch) return [];
        const bindings = eligible.map(row => {
          const binding: DevinCliExecutionBinding = Object.freeze({ selectedPath, executable, executableSha256, executableEpoch,
            credentialsPath, credentialsEpoch, ...principal, model: row.id, contextTokens: row.contextTokens!, observedAt, validUntil });
          issued.add(binding);
          entries.set(JSON.stringify([selectedPath, executable, executableEpoch, credentialsPath, credentialsEpoch, row.id]), binding);
          return binding;
        });
        return bindings;
      })().catch(() => [] as readonly DevinCliExecutionBinding[]).then(bindings => {
        // A fresh denial or changed catalog must not leave older evidence
        // selectable from this same native tuple, even inside its old TTL.
        catalogs.delete(tupleKey);
        const retained = new Set(bindings.map(binding => binding.model));
        for (const [entryKey, binding] of entries) {
          if (entryKey === JSON.stringify([...tuple, binding.model]) && !retained.has(binding.model)) entries.delete(entryKey);
        }
        if (bindings.length) catalogs.set(tupleKey, Object.freeze(bindings));
        else if (admitted(opts)) failures.set(tupleKey, now());
        return bindings;
      }).finally(() => { flights.delete(tupleKey); });
      flights.set(tupleKey, flight);
    }
    const observed = await flights.get(tupleKey)!;
    const bindings = model === null ? observed : observed.filter(binding => binding.model === model);
    if (!bindings.length && admitted(opts)) failures.set(key, now());
    if (!bindings.length || !admitted(opts) || !bindings.every(binding => devinCliBindingCurrent(binding, binding.model, now()))) return [];
    selected = bindings[0]!; return bindings;
  } catch { return []; }
}

/** Renew one selected model through the same native account/catalog checks. */
export async function refreshDevinCliExecutionBinding(model: string, opts: DevinCliAdmissionOptions = {}): Promise<DevinCliExecutionBinding | null> {
  return (await refreshBindings(model, opts))[0] ?? null;
}

/** Discover native included models using ONE auth → catalog → auth tuple.
 * Cloud/chat discovery and cached fallback catalogs never enter this path. */
export async function refreshDevinCliExecutionBindings(opts: DevinCliAdmissionOptions = {}): Promise<readonly DevinCliExecutionBinding[]> {
  return refreshBindings(null, opts);
}

export function resetDevinCliAdmissionForTest(): void { entries.clear(); catalogs.clear(); flights.clear(); failures.clear(); selected = null; }
