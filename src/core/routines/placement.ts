/** One objective: maximize successful autonomous progress per dollar and second. */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadProposal } from '../inbox/store.js';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';

export const PROVIDERS = ['local', 'codex', 'claude', 'devin', 'grok'] as const;
export type Provider = typeof PROVIDERS[number];
export interface Resource {
  provider: Provider;
  model: string;
  costUsd: number;
  latencyMs: number;
  quality: number;
  /** Remaining free calls in this quota window; consumed receipts count against it. */
  freeQuota: number;
  /** Grok Bot uses its existing quota ledger and Phantom Secrets transport. */
  grokbot?: { budgetFile: string; secretsProject: string; dayCap: number; weekCap: number };
}
export interface Routine {
  id: string;
  goal: string;
  sourceRepo: string;
  resources: Resource[];
  budgetUsd: number;
  quotaSince: string;
  minQuality?: number;
  maxLatencyMs?: number;
  value?: number;
  /** Engineering quality counts only merges; operational work counts successful checks. */
  outcome?: 'operational' | 'merge';
}
export interface Receipt {
  id: string;
  routineId: string;
  at: string;
  provider: Provider;
  model: string;
  outcome: 'running' | 'succeeded' | 'merged' | 'failed';
  metric: 'operational' | 'merge';
  proposalId?: string;
  costUsd: number;
  latencyMs: number;
  decision: ReturnType<typeof placeRoutine>;
}
const finite = (n: number): boolean => Number.isFinite(n) && n >= 0;
export function validateRoutine(r: Routine): void {
  if (!r || typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id) || !r.goal?.trim() || !r.sourceRepo?.startsWith('/') ||
      !finite(r.budgetUsd) || typeof r.quotaSince !== 'string' || !Number.isFinite(Date.parse(r.quotaSince)) ||
      (r.minQuality !== undefined && (!finite(r.minQuality) || r.minQuality > 1)) ||
      (r.maxLatencyMs !== undefined && !finite(r.maxLatencyMs)) ||
      (r.value !== undefined && (!finite(r.value) || r.value === 0)) ||
      (r.outcome !== undefined && !['merge', 'operational'].includes(r.outcome)) ||
      !Array.isArray(r.resources) || !r.resources.some(x => x?.provider === 'local') || new Set(r.resources.map(x => x.provider)).size !== r.resources.length ||
      r.resources.some(x => !PROVIDERS.includes(x.provider) || !x.model?.trim() || !finite(x.costUsd) ||
        !finite(x.latencyMs) || !finite(x.quality) || x.quality > 1 || !Number.isSafeInteger(x.freeQuota) || x.freeQuota < 0 ||
        (x.provider === 'local' && x.costUsd !== 0))) throw new Error('Invalid routine or resource measurements.');
}
export function placeRoutine(r: Routine, ledger: readonly Receipt[], now = new Date()) {
  validateRoutine(r);
  const since = Date.parse(r.quotaSince);
  if (since > now.getTime()) throw new Error('Quota window starts in the future.');
  const window = ledger.filter(x => Date.parse(x.at) >= since);
  const spent = window.filter(x => x.routineId === r.id).reduce((n, x) => n + x.costUsd, 0);
  const metric = r.outcome ?? 'operational';
  const samples = (p: Provider, model: string) => ledger.filter(x => x.routineId === r.id && x.provider === p &&
    x.model === model && x.metric === metric && x.outcome !== 'running');
  const measurements = (resource: Resource) => {
    const history = samples(resource.provider, resource.model);
    const successes = history.filter(x => metric === 'merge' ? x.outcome === 'merged' : x.outcome !== 'failed').length;
    return {
      history,
      quality: (successes + 2 * resource.quality) / (history.length + 2),
      latencyMs: history.length ? history.reduce((n, x) => n + x.latencyMs, 0) / history.length : resource.latencyMs,
      measuredCost: history.length ? history.reduce((n, x) => n + x.costUsd, 0) / history.length : resource.costUsd,
    };
  };
  const local = r.resources.find(x => x.provider === 'local');
  const localEvidence = local ? measurements(local) : null;
  const localSamples = localEvidence?.history ?? [];
  const failureRate = localSamples.length ? localSamples.filter(x => x.outcome === 'failed').length / localSamples.length : 0;
  const repeatedFailures = localSamples.length >= 3 && failureRate >= 0.5;
  const eligibleLocal = localEvidence && !repeatedFailures && localEvidence.quality >= (r.minQuality ?? 0) &&
    localEvidence.latencyMs <= (r.maxLatencyMs ?? Infinity);
  const candidates = r.resources.map(resource => {
    const { history, quality, latencyMs, measuredCost } = measurements(resource);
    const used = window.filter(x => x.provider === resource.provider).length;
    const costUsd = resource.provider === 'local' || used < resource.freeQuota ? 0 : Math.max(resource.costUsd, measuredCost);
    let reason = 'eligible';
    if (resource.provider !== 'local' && eligibleLocal) reason = 'local default meets declared needs; no repeated failures';
    else if (resource.provider === 'local' && repeatedFailures) reason = 'repeated local failures';
    else if (quality < (r.minQuality ?? 0)) reason = 'quality below requirement';
    else if (latencyMs > (r.maxLatencyMs ?? Infinity)) reason = 'latency exceeds requirement';
    else if (spent + costUsd > r.budgetUsd) reason = 'cost exceeds remaining budget';
    return { provider: resource.provider, model: resource.model, samples: history.length, quality, latencyMs, costUsd,
      score: (r.value ?? 1) * quality / (costUsd + Math.max(0.001, latencyMs / 1000 * 0.01)), reason };
  });
  const selected = candidates.filter(x => x.reason === 'eligible').sort((a, b) => b.score - a.score)[0] ?? null;
  return { selected, candidates, spentUsd: spent, localFailureRate: failureRate,
    objective: 'expected value / (cost + latency penalty)', escalation: !selected ? 'no eligible resource' : selected.provider === 'local' ? 'none (local default)' :
      repeatedFailures ? 'repeated local failures' : 'declared quality or latency needs' };
}
function ledgerPath(): string { return join(homedir(), '.ashlr', 'routines', 'ledger.json'); }
export function readRoutineLedger(): Receipt[] {
  const file = readPrivateFileCapped(ledgerPath(), 4 * 1024 * 1024);
  if (!file) {
    try { lstatSync(ledgerPath()); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    }
    throw new Error('Routine ledger unreadable.');
  }
  if (file.truncated) throw new Error('Routine ledger exceeds size limit.');
  const rows: unknown = JSON.parse(file.text);
  if (!Array.isArray(rows) || rows.some(x => !x || typeof x.id !== 'string' || typeof x.routineId !== 'string' ||
      !PROVIDERS.includes(x.provider) || typeof x.model !== 'string' || !finite(x.costUsd) || !finite(x.latencyMs) ||
      !Number.isFinite(Date.parse(x.at)) || !['operational', 'merge'].includes(x.metric) ||
      !['running', 'succeeded', 'merged', 'failed'].includes(x.outcome))) throw new Error('Invalid routine ledger.');
  return (rows as Receipt[]).map(row => row.proposalId && authenticatedRealizedMergeOf(loadProposal(row.proposalId))
    ? { ...row, outcome: 'merged' } : row);
}
function mutate<T>(fn: (rows: Receipt[]) => T): T {
  const path = ledgerPath();
  ensurePrivateDirectory(join(homedir(), '.ashlr'));
  ensurePrivateDirectory(join(homedir(), '.ashlr', 'routines'));
  const lock = acquireLocalStoreLock(`${path}.lock`);
  if (!lock) throw new Error('Routine ledger busy.');
  try {
    const rows = readRoutineLedger();
    const result = fn(rows);
    const text = JSON.stringify(rows);
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Routine ledger full.');
    writePrivateFileAtomic(path, text);
    return result;
  } finally { releaseLocalStoreLock(lock); }
}
/** Adapter returns host-verified outcomes, never an LLM's claimed merge. Throws count as failures. */
export async function runRoutine(r: Routine, execute: (resource: Resource) => Promise<{
  outcome: 'succeeded' | 'merged' | 'failed'; costUsd: number; proposalId?: string;
}>): Promise<Receipt> {
  const receipt = mutate(rows => {
    const decision = placeRoutine(r, rows);
    if (!decision.selected) throw new Error('No eligible routine resource.');
    if (rows.some(x => x.routineId === r.id && x.outcome === 'running')) throw new Error('Routine already running; reconcile its receipt first.');
    const row: Receipt = { id: randomUUID(), routineId: r.id, at: new Date().toISOString(),
      provider: decision.selected.provider, model: decision.selected.model, outcome: 'running', metric: r.outcome ?? 'operational',
      costUsd: decision.selected.costUsd, latencyMs: 0, decision };
    rows.push(row);
    return row;
  });
  const start = Date.now();
  let outcome: Receipt['outcome'] = 'failed';
  let costUsd = receipt.costUsd;
  let proposalId: string | undefined;
  try {
    const result = await execute(r.resources.find(x => x.provider === receipt.provider)!);
    if (!finite(result.costUsd) || !['succeeded', 'merged', 'failed'].includes(result.outcome)) throw new Error('Invalid executor receipt.');
    outcome = result.outcome;
    proposalId = result.proposalId;
    costUsd = Math.max(costUsd, result.costUsd);
  } catch { /* Keep reserved cost: unknown failures are never assumed free. */ }
  return mutate(rows => {
    const row = rows.find(x => x.id === receipt.id)!;
    Object.assign(row, { outcome, costUsd, proposalId, latencyMs: Date.now() - start });
    return row;
  });
}
