/**
 * Coding CLI model inventory: types and a pure parser for a caller-supplied,
 * already-recorded catalog document.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886,
 * src/core/providers/coding-cli/catalog.ts). Not recovered here: the compiled
 * defaults, the filesystem loader and the operator inventory file. See
 * BRIDGE_NOTES.md for the omitted portions.
 *
 * Evidence rules:
 * - A row's `accountStatus` is copied exactly. Parsing never promotes a row.
 * - `accepted` is the only status that may name a model flag, and only via
 *   usableModelName. `listed`, `unverified` and `rejected` stay off the argv.
 * - A listing (cacheListings) is not account proof.
 *
 * Pure: no process, network, home-directory or write side effects.
 */

import {
  CODING_CLI_BILLING_CLASSES,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  type CodingCliBillingClass,
} from './validation.js';

export type BillingClass = CodingCliBillingClass;

function isBillingClass(value: unknown): value is BillingClass {
  return typeof value === 'string' && (CODING_CLI_BILLING_CLASSES as readonly string[]).includes(value);
}

const ACCOUNT_STATUSES = ['unverified', 'listed', 'rejected', 'accepted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

const MODEL_TIERS = ['frontier', 'workhorse', 'cheap', 'local'] as const;
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
  /** Non-secret org id. The API key never lives here. */
  orgId?: string;
  installed?: boolean;
}

export interface AccountRecord {
  id: string;
  backend: string;
  /** Env var that holds the credential home, such as CODEX_HOME. Not a secret name. */
  homeEnv: string | null;
  /** When true, a missing home makes the account unusable. The primary Codex login may omit it. */
  requiresHome: boolean;
}

export interface CodingCliCatalog {
  version: 1;
  observedAt: string;
  source: string;
  meteredEnabledByDefault: boolean;
  machine: { chip: string; ramGb: number; diskUsedPercent: number; diskFreeGiB: number; note: string };
  concurrency: Readonly<Record<string, number>>;
  backends: Readonly<Record<string, BackendRecord>>;
  accounts: readonly AccountRecord[];
  tiers: Readonly<Record<ModelTierName, readonly TierCandidate[]>>;
  cacheListings: {
    codex: readonly string[];
    claudeAliases: readonly string[];
    grok: readonly string[];
    rejectedOnAccount: readonly string[];
  };
}

function fail(path: string): never {
  throw new Error(`coding CLI catalog: ${path}`);
}

/** Reference errors name the offending path and the missing id. */
function failRef(path: string, id: string): never {
  throw new Error(`coding CLI catalog: ${path} references unknown backend "${id}"`);
}

function str(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) fail(path);
  return value.trim();
}

function parseCandidate(raw: unknown, path: string): TierCandidate {
  if (!isRecord(raw)) fail(path);
  const row = raw;
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
    if (!isFiniteNumber(row['sizeGb']) || row['sizeGb'] <= 0) fail(`${path}.sizeGb`);
    out.sizeGb = row['sizeGb'];
  }
  if (row['task'] !== undefined) {
    if (row['task'] !== 'generate' && row['task'] !== 'embed') fail(`${path}.task`);
    out.task = row['task'];
  }
  return out;
}

/**
 * Parse a recorded catalog document. Throws on any shape, status, or
 * backend reference it would otherwise have to guess at.
 */
export function parseCatalog(text: string): CodingCliCatalog {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    fail('invalid JSON');
  }
  if (!isRecord(json)) fail('root');
  const root = json;
  if (root['version'] !== 1) fail('version');
  const machine = root['machine'];
  if (typeof machine !== 'object' || machine === null) fail('machine');
  const m = machine as Record<string, unknown>;
  const backendsRaw = root['backends'];
  if (!isRecord(backendsRaw)) fail('backends');
  const backends: Record<string, BackendRecord> = {};
  for (const [id, value] of Object.entries(backendsRaw)) {
    if (typeof value !== 'object' || value === null) fail(`backends.${id}`);
    const row = value as Record<string, unknown>;
    const billing = row['billing'];
    if (!isBillingClass(billing)) fail(`backends.${id}.billing`);
    const bin = row['bin'];
    if (bin !== null && typeof bin !== 'string') fail(`backends.${id}.bin`);
    if (typeof row['enabledByDefault'] !== 'boolean') fail(`backends.${id}.enabledByDefault`);
    const record: BackendRecord = { billing, bin, enabledByDefault: row['enabledByDefault'] };
    if (row['meteredReason'] !== undefined) record.meteredReason = str(row['meteredReason'], `backends.${id}.meteredReason`);
    if (row['secretName'] !== undefined) record.secretName = str(row['secretName'], `backends.${id}.secretName`);
    if (row['orgId'] !== undefined) record.orgId = str(row['orgId'], `backends.${id}.orgId`);
    if (row['installed'] !== undefined) {
      if (typeof row['installed'] !== 'boolean') fail(`backends.${id}.installed`);
      record.installed = row['installed'];
    }
    backends[id] = record;
  }
  const knownBackend = (id: string, path: string): void => {
    if (!Object.prototype.hasOwnProperty.call(backends, id)) failRef(path, id);
  };
  const tiersRaw = root['tiers'];
  if (typeof tiersRaw !== 'object' || tiersRaw === null) fail('tiers');
  const tiers = {} as Record<ModelTierName, TierCandidate[]>;
  for (const name of MODEL_TIERS) {
    const list = (tiersRaw as Record<string, unknown>)[name];
    if (!Array.isArray(list)) fail(`tiers.${name}`);
    tiers[name] = list.map((row, i) => {
      const parsed = parseCandidate(row, `tiers.${name}[${i}]`);
      knownBackend(parsed.backend, `tiers.${name}[${i}].backend`);
      return parsed;
    });
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
    knownBackend(id, `concurrency.${id}`);
    concurrency[id] = value;
  }
  const accounts: AccountRecord[] = [];
  if (root['accounts'] !== undefined) {
    if (!Array.isArray(root['accounts'])) fail('accounts');
    const seen = new Set<string>();
    for (let i = 0; i < root['accounts'].length; i += 1) {
      const raw = root['accounts'][i];
      const path = `accounts[${i}]`;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(path);
      const row = raw as Record<string, unknown>;
      const id = str(row['id'], `${path}.id`);
      if (seen.has(id)) fail(`${path}.id`);
      seen.add(id);
      const homeEnv = row['homeEnv'] === null || row['homeEnv'] === undefined ? null : str(row['homeEnv'], `${path}.homeEnv`);
      if (homeEnv !== null && (!/^[A-Z][A-Z0-9_]*$/.test(homeEnv) || /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(homeEnv))) {
        fail(`${path}.homeEnv`);
      }
      const requiresHome = row['requiresHome'] === undefined ? false : row['requiresHome'];
      if (typeof requiresHome !== 'boolean') fail(`${path}.requiresHome`);
      const backend = str(row['backend'], `${path}.backend`);
      knownBackend(backend, `${path}.backend`);
      accounts.push({ id, backend, homeEnv, requiresHome });
    }
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
    accounts,
    tiers,
    cacheListings: {
      codex: names('codex'),
      claudeAliases: names('claudeAliases'),
      grok: names('grok'),
      rejectedOnAccount: names('rejectedOnAccount'),
    },
  };
}

/** Named flags require `accepted`. Everything else, including `listed` and `unverified`, stays off the argv. */
export function usableModelName(candidate: TierCandidate | undefined): string | null {
  if (!candidate || candidate.accountStatus !== 'accepted') return null;
  return candidate.candidate;
}
