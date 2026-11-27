/** Pure operation contract and shared autonomy validation helpers. No transport, config writes or merge authority. */
import type { AshlrConfig, ProtectedPrObservedBypass, ProtectedRemoteRepositoryExpectation } from '../types.js';

export const PROTECTED_PR_HANDOFF_OPERATION = 'protected-pr-handoff-v1' as const;
const MAX_ENTRIES = 100;

export const AUTONOMY_RISK_ORDER: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function configuredAutoMergeMaxRisk(cfg: AshlrConfig): 'low' | 'medium' | 'high' {
  const value = cfg.foundry?.autoMerge?.maxRisk;
  return value === 'medium' || value === 'high' ? value : 'low';
}

export function strictPlainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (!Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[] | ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  if (expected instanceof Set) {
    return keys.length === expected.size && keys.every((key) => expected.has(key));
  }
  const expectedList = expected as readonly string[];
  return keys.length === expectedList.length && expectedList.every((key) => Object.hasOwn(value, key));
}

export function isCanonicalIsoTimestamp(value: unknown, maxLength?: number): value is string {
  if (typeof value !== 'string') return false;
  if (maxLength !== undefined && value.length > maxLength) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function finiteNumberOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function list(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ENTRIES) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.every((key) => {
    if (key === 'length') return true;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  })) return null;
  return value;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

/** Exact canonical metadata; unknown actor types/modes and conflicts remain held. */
export function normalizeProtectedPrObservedBypass(value: unknown): ProtectedPrObservedBypass[] | null {
  const rows = list(value);
  if (!rows) return null;
  const seen = new Set<string>();
  const output: ProtectedPrObservedBypass[] = [];
  for (const item of rows) {
    const actor = strictPlainRecord(item);
    if (!actor || !hasExactKeys(actor, ['rulesetId', 'sourceType', 'source', 'actorType', 'actorId', 'bypassMode']) ||
      !id(actor['rulesetId']) || !text(actor['source'], 512) || !id(actor['actorId']) ||
      (actor['sourceType'] !== 'Repository' && actor['sourceType'] !== 'Organization' && actor['sourceType'] !== 'Enterprise') ||
      actor['actorType'] !== 'RepositoryRole' ||
      (actor['bypassMode'] !== 'always' && actor['bypassMode'] !== 'pull_request')) return null;
    const row: ProtectedPrObservedBypass = { rulesetId: actor['rulesetId'], sourceType: actor['sourceType'] as ProtectedPrObservedBypass['sourceType'],
      source: actor['source'], actorType: 'RepositoryRole', actorId: actor['actorId'], bypassMode: actor['bypassMode'] };
    const key = JSON.stringify([row.sourceType, row.source, row.rulesetId, row.actorType, row.actorId]);
    if (seen.has(key)) return null;
    seen.add(key); output.push(row);
  }
  return output.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Registry shape only: the existing exact check/App parser validates selected checks. */
export function normalizeProtectedRemoteRegistry(value: unknown): ProtectedRemoteRepositoryExpectation[] | null {
  const rows = list(value);
  if (!rows || rows.length === 0) return null;
  const names = new Set<string>(); const identities = new Set<string>();
  const output: ProtectedRemoteRepositoryExpectation[] = [];
  for (const item of rows) {
    const entry = strictPlainRecord(item);
    if (!entry || !hasExactKeys(entry, ['nameWithOwner', 'repositoryId', 'defaultBranch', 'operation', 'branchProtection', 'requiredChecks', 'observedRulesetBypassActors']) ||
      !text(entry['nameWithOwner'], 512) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry['nameWithOwner']) ||
      !text(entry['repositoryId'], 256) || !text(entry['defaultBranch'], 256) ||
      entry['operation'] !== PROTECTED_PR_HANDOFF_OPERATION || typeof entry['branchProtection'] !== 'boolean' ||
      !list(entry['requiredChecks'])) return null;
    // Preserve only scalar check metadata; the existing selected-check parser
    // still decides exact authority. Do not retain arbitrary nested config data.
    const checks: ProtectedRemoteRepositoryExpectation['requiredChecks'] = [];
    for (const value of list(entry['requiredChecks'])!) {
      const check = strictPlainRecord(value);
      if (!check || !hasExactKeys(check, ['context', 'appId']) || !text(check['context'], 256) ||
          !(id(check['appId']) || typeof check['appId'] === 'number' && Number.isSafeInteger(check['appId']) && check['appId'] > 0)) return null;
      checks.push({ context: check['context'], appId: String(check['appId']) });
    }
    const actors = normalizeProtectedPrObservedBypass(entry['observedRulesetBypassActors']);
    if (!actors) return null;
    const name = entry['nameWithOwner'].toLowerCase();
    if (names.has(name) || identities.has(entry['repositoryId'])) return null;
    names.add(name); identities.add(entry['repositoryId']);
    output.push({ nameWithOwner: name, repositoryId: entry['repositoryId'], defaultBranch: entry['defaultBranch'],
      operation: PROTECTED_PR_HANDOFF_OPERATION, branchProtection: entry['branchProtection'],
      requiredChecks: checks, observedRulesetBypassActors: actors });
  }
  return output;
}

/** Both fields are paired: malformed/new operation data cannot become legacy authority. */
export function protectedPrOperationShape(value: unknown): 'legacy' | 'handoff' | 'invalid' {
  const evidence = strictPlainRecord(value);
  if (!evidence) return 'invalid';
  const operation = Object.hasOwn(evidence, 'operation');
  const actors = Object.hasOwn(evidence, 'observedRulesetBypassActors');
  if (!operation && !actors) return 'legacy';
  return operation && actors && evidence['operation'] === PROTECTED_PR_HANDOFF_OPERATION &&
    normalizeProtectedPrObservedBypass(evidence['observedRulesetBypassActors']) !== null ? 'handoff' : 'invalid';
}


/** Read-only summary compatibility with CURRENT configured PR routing. */
export function protectedPrEvidenceMatchesRegistry(value: unknown, configured: unknown): boolean {
  const evidence = strictPlainRecord(value);
  const registry = normalizeProtectedRemoteRegistry(configured);
  if (!evidence || !registry || protectedPrOperationShape(evidence) !== 'handoff' ||
      typeof evidence['nameWithOwner'] !== 'string') return false;
  const selected = registry.find((entry) => entry.nameWithOwner === (evidence['nameWithOwner'] as string).toLowerCase());
  if (!selected || selected.branchProtection !== true || selected.repositoryId !== evidence['repositoryId'] ||
      selected.defaultBranch !== evidence['branch'] || JSON.stringify(selected.observedRulesetBypassActors) !==
      JSON.stringify(normalizeProtectedPrObservedBypass(evidence['observedRulesetBypassActors'])) ||
      !list(evidence['requiredCheckBindings'])) return false;
  const observed: string[] = [];
  for (const item of list(evidence['requiredCheckBindings'])!) {
    const check = strictPlainRecord(item);
    if (!check || !hasExactKeys(check, ['context', 'appId']) || !text(check['context'], 256) || !id(check['appId'])) return false;
    observed.push(`${check['context']}\0${check['appId']}`);
  }
  if (observed.length > MAX_ENTRIES) return false;
  const contexts = selected.requiredChecks.map((check) => typeof check === 'string' ? '' : check.context);
  if (new Set(contexts).size !== contexts.length) return false;
  const expected = selected.requiredChecks.map((check) => typeof check === 'string' ? '' : `${check.context}\0${check.appId}`);
  return expected.length > 0 && new Set(expected).size === expected.length &&
    JSON.stringify(expected.sort()) === JSON.stringify(observed.sort());
}
