/**
 * Operator model table. Names live here, loaded from JSON, never as trusted
 * constants in the router. `accepted` is the only status a named model flag
 * may use, and only after a minimal exec probe. Cache listings and `listed`
 * or `unverified` rows are not account proof.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isBillingClass, type BillingClass } from '../../routing/billing-class.js';

export const ACCOUNT_STATUSES = ['unverified', 'listed', 'rejected', 'accepted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const MODEL_TIERS = ['frontier', 'workhorse', 'cheap', 'local'] as const;
export type ModelTierName = (typeof MODEL_TIERS)[number];

export interface TierCandidate {
  intent: string;
  backend: string;
  candidate: string;
  accountStatus: AccountStatus;
  note?: string;
  sizeGb?: number;
  task?: 'generate' | 'embed';
}

export interface BackendRecord {
  billing: BillingClass;
  bin: string | null;
  enabledByDefault: boolean;
  meteredReason?: string;
  secretName?: string;
  installed?: boolean;
}

export interface CodingCliCatalog {
  version: 1;
  observedAt: string;
  source: string;
  meteredEnabledByDefault: boolean;
  machine: { chip: string; ramGb: number; diskUsedPercent: number; diskFreeGiB: number; note: string };
  concurrency: Readonly<Record<string, number>>;
  backends: Readonly<Record<string, BackendRecord>>;
  tiers: Readonly<Record<ModelTierName, readonly TierCandidate[]>>;
  cacheListings: {
    codex: readonly string[];
    claudeAliases: readonly string[];
    grok: readonly string[];
    rejectedOnAccount: readonly string[];
  };
}

const DEFAULT_CATALOG = join(dirname(fileURLToPath(import.meta.url)), '../../../../config/coding-cli-models.json');

function fail(path: string): never {
  throw new Error(`coding CLI catalog: ${path}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path);
  return value.trim();
}

function parseCandidate(raw: unknown, path: string): TierCandidate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(path);
  const row = raw as Record<string, unknown>;
  const accountStatus = str(row['accountStatus'], `${path}.accountStatus`);
  if (!(ACCOUNT_STATUSES as readonly string[]).includes(accountStatus)) fail(`${path}.accountStatus`);
  const out: TierCandidate = {
    intent: str(row['intent'], `${path}.intent`),
    backend: str(row['backend'], `${path}.backend`),
    candidate: str(row['candidate'], `${path}.candidate`),
    accountStatus: accountStatus as AccountStatus,
  };
  if (row['note'] !== undefined) out.note = str(row['note'], `${path}.note`);
  if (row['sizeGb'] !== undefined) {
    if (typeof row['sizeGb'] !== 'number' || !Number.isFinite(row['sizeGb']) || row['sizeGb'] <= 0) fail(`${path}.sizeGb`);
    out.sizeGb = row['sizeGb'];
  }
  if (row['task'] !== undefined) {
    if (row['task'] !== 'generate' && row['task'] !== 'embed') fail(`${path}.task`);
    out.task = row['task'];
  }
  return out;
}

/** Parse a catalog document. Throws on a shape we would otherwise guess. */
export function parseCatalog(text: string): CodingCliCatalog {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    fail('invalid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail('root');
  const root = json as Record<string, unknown>;
  if (root['version'] !== 1) fail('version');
  const machine = root['machine'];
  if (typeof machine !== 'object' || machine === null) fail('machine');
  const m = machine as Record<string, unknown>;
  const backendsRaw = root['backends'];
  if (typeof backendsRaw !== 'object' || backendsRaw === null || Array.isArray(backendsRaw)) fail('backends');
  const backends: Record<string, BackendRecord> = {};
  for (const [id, value] of Object.entries(backendsRaw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) fail(`backends.${id}`);
    const row = value as Record<string, unknown>;
    const billing = row['billing'];
    if (!isBillingClass(billing)) fail(`backends.${id}.billing`);
    const bin = row['bin'];
    if (bin !== null && typeof bin !== 'string') fail(`backends.${id}.bin`);
    if (typeof row['enabledByDefault'] !== 'boolean') fail(`backends.${id}.enabledByDefault`);
    const record: BackendRecord = { billing, bin: bin === null ? null : bin, enabledByDefault: row['enabledByDefault'] };
    if (row['meteredReason'] !== undefined) record.meteredReason = str(row['meteredReason'], `backends.${id}.meteredReason`);
    if (row['secretName'] !== undefined) record.secretName = str(row['secretName'], `backends.${id}.secretName`);
    if (row['installed'] !== undefined) {
      if (typeof row['installed'] !== 'boolean') fail(`backends.${id}.installed`);
      record.installed = row['installed'];
    }
    backends[id] = record;
  }
  const tiersRaw = root['tiers'];
  if (typeof tiersRaw !== 'object' || tiersRaw === null) fail('tiers');
  const tiers = {} as Record<ModelTierName, TierCandidate[]>;
  for (const name of MODEL_TIERS) {
    const list = (tiersRaw as Record<string, unknown>)[name];
    if (!Array.isArray(list)) fail(`tiers.${name}`);
    tiers[name] = list.map((row, i) => parseCandidate(row, `tiers.${name}[${i}]`));
  }
  const cache = root['cacheListings'];
  if (typeof cache !== 'object' || cache === null) fail('cacheListings');
  const c = cache as Record<string, unknown>;
  const names = (key: string): string[] => {
    const list = c[key];
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim() === '')) fail(`cacheListings.${key}`);
    return list as string[];
  };
  const concurrencyRaw = root['concurrency'];
  if (typeof concurrencyRaw !== 'object' || concurrencyRaw === null) fail('concurrency');
  const concurrency: Record<string, number> = {};
  for (const [id, value] of Object.entries(concurrencyRaw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8) fail(`concurrency.${id}`);
    concurrency[id] = value;
  }
  if (typeof root['meteredEnabledByDefault'] !== 'boolean') fail('meteredEnabledByDefault');
  return {
    version: 1,
    observedAt: str(root['observedAt'], 'observedAt'),
    source: str(root['source'], 'source'),
    meteredEnabledByDefault: root['meteredEnabledByDefault'],
    machine: {
      chip: str(m['chip'], 'machine.chip'),
      ramGb: typeof m['ramGb'] === 'number' ? m['ramGb'] : fail('machine.ramGb'),
      diskUsedPercent: typeof m['diskUsedPercent'] === 'number' ? m['diskUsedPercent'] : fail('machine.diskUsedPercent'),
      diskFreeGiB: typeof m['diskFreeGiB'] === 'number' ? m['diskFreeGiB'] : fail('machine.diskFreeGiB'),
      note: str(m['note'], 'machine.note'),
    },
    concurrency,
    backends,
    tiers,
    cacheListings: {
      codex: names('codex'),
      claudeAliases: names('claudeAliases'),
      grok: names('grok'),
      rejectedOnAccount: names('rejectedOnAccount'),
    },
  };
}

export function loadCatalog(path = DEFAULT_CATALOG): CodingCliCatalog {
  return parseCatalog(readFileSync(path, 'utf8'));
}

/** Named flags require `accepted`. Everything else stays off the argv. */
export function usableModelName(candidate: TierCandidate | undefined): string | null {
  if (!candidate || candidate.accountStatus !== 'accepted') return null;
  return candidate.candidate;
}

/**
 * Largest installed local generator that fits in 60% of RAM. Embedding tags
 * are not coding models. A `listed` row still needs a probe before a live run.
 */
export function selectLocalCandidate(catalog: CodingCliCatalog, ramGb = catalog.machine.ramGb): TierCandidate | null {
  const budget = ramGb * 0.6;
  const rows = catalog.tiers.local.filter((row) => row.task !== 'embed' && (row.sizeGb === undefined || row.sizeGb <= budget));
  return rows.sort((a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0) || a.candidate.localeCompare(b.candidate))[0] ?? null;
}
