/**
 * Measured outcomes for self-improvement proposals.
 *
 * A proposal earns credit only from a declared, deterministic metric measured
 * at two exact commits: the PR's merge base and its head. Self-reported
 * success, code volume and model opinions never enter the score. A metric that
 * was not measured, failed to run, or disagreed with itself on the same commit
 * is `unknown`, never zero.
 *
 * Credit is compared across proposer sources: the deterministic rules in
 * `gatherProposals` are the baseline every model-driven proposer must beat,
 * and each exact engine/model pair is its own fixed-model group.
 *
 * Storage: an append-only, digest-chained JSONL ledger at
 * `$ASHLR_HOME/improve/outcomes.jsonl`. It holds public proposal fields only;
 * private `local` detail from `gatherProposals` is never written here.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';

export type MetricDirection = 'increase' | 'decrease';
/**
 * How a metric is produced inside a checkout of the measured commit. The
 * command must print, as its last stdout line, `{"metric": <name>, "value": <number>}`.
 */
export type MetricRunner =
  | { kind: 'npm'; script: string }
  | { kind: 'node'; path: string };
export interface MetricSpec { name: string; direction: MetricDirection; runner: MetricRunner }
/** Who produced the proposal. `deterministic` is the baseline proposer. */
export type ProposerSource =
  | { kind: 'deterministic'; rule: string }
  | { kind: 'model'; engine: string; model: string };

export type MeasurementPhase = 'base' | 'head';
export type LedgerEvent =
  | { type: 'registered'; proposalId: string; title: string; proposalKind: string; source: ProposerSource; metric: MetricSpec; predictedDelta: number | null }
  | { type: 'pr'; proposalId: string; repository: string; number: number }
  | { type: 'measured'; proposalId: string; phase: MeasurementPhase; sha: string; value: number | null; reason: string | null }
  | { type: 'promotion'; proposalId: string; headSha: string; decision: 'merge-queued' | 'refused'; reasons: string[] };
export type LedgerRecord = LedgerEvent & { v: 1; at: string; prev: string; digest: string };

export const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const ZERO = '0'.repeat(64);
const SHA = /^[0-9a-f]{40}$/;
const PROPOSAL_ID = /^[a-f0-9]{10}$/;
const NAME = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function outcomesLedgerPath(): string { return join(ashlrHome(), 'improve', 'outcomes.jsonl'); }

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const digestOf = (body: unknown) => createHash('sha256').update(canonical(body)).digest('hex');

export function validateMetricSpec(m: unknown): MetricSpec {
  const spec = m as MetricSpec;
  if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string' || !NAME.test(spec.name)) throw new Error('Invalid metric name.');
  if (spec.direction !== 'increase' && spec.direction !== 'decrease') throw new Error('Metric direction must be increase or decrease.');
  const r = spec.runner;
  if (!r || typeof r !== 'object') throw new Error('Metric runner is required.');
  if (r.kind === 'npm') {
    if (typeof r.script !== 'string' || !NAME.test(r.script)) throw new Error('Invalid npm script name.');
    return { name: spec.name, direction: spec.direction, runner: { kind: 'npm', script: r.script } };
  }
  if (r.kind === 'node') {
    // Repository-relative script only: no absolute paths, parent segments or option-looking names.
    if (typeof r.path !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}\.(mjs|cjs|js)$/.test(r.path) ||
        r.path.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error('Invalid node metric path.');
    return { name: spec.name, direction: spec.direction, runner: { kind: 'node', path: r.path } };
  }
  throw new Error('Metric runner must be npm or node.');
}

export function validateSource(s: unknown): ProposerSource {
  const src = s as ProposerSource;
  if (src?.kind === 'deterministic' && typeof src.rule === 'string' && NAME.test(src.rule)) return { kind: 'deterministic', rule: src.rule };
  if (src?.kind === 'model' && typeof src.engine === 'string' && IDENT.test(src.engine) && typeof src.model === 'string' && IDENT.test(src.model)) {
    // Exact model identity only; an alias like "auto" or "default" is not a fixed model.
    if (/^(auto|default|unknown|latest)$/i.test(src.model)) throw new Error('A model source needs an exact model identity.');
    return { kind: 'model', engine: src.engine, model: src.model };
  }
  throw new Error('Invalid proposer source.');
}

function validateEvent(e: LedgerEvent): LedgerEvent {
  if (!e || typeof e.proposalId !== 'string' || !PROPOSAL_ID.test(e.proposalId)) throw new Error('Invalid proposal id.');
  switch (e.type) {
    case 'registered':
      if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > 200) throw new Error('Invalid title.');
      if (typeof e.proposalKind !== 'string' || !NAME.test(e.proposalKind)) throw new Error('Invalid proposal kind.');
      if (e.predictedDelta !== null && !Number.isFinite(e.predictedDelta)) throw new Error('Invalid predicted delta.');
      return { type: e.type, proposalId: e.proposalId, title: e.title, proposalKind: e.proposalKind,
        source: validateSource(e.source), metric: validateMetricSpec(e.metric), predictedDelta: e.predictedDelta };
    case 'pr':
      if (typeof e.repository !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(e.repository)) throw new Error('Invalid repository.');
      if (!Number.isSafeInteger(e.number) || e.number <= 0) throw new Error('Invalid PR number.');
      return { type: e.type, proposalId: e.proposalId, repository: e.repository, number: e.number };
    case 'measured':
      if (e.phase !== 'base' && e.phase !== 'head') throw new Error('Invalid phase.');
      if (typeof e.sha !== 'string' || !SHA.test(e.sha)) throw new Error('Measurements need an exact 40-hex commit.');
      if (e.value !== null && !Number.isFinite(e.value)) throw new Error('Invalid measurement value.');
      if (e.value === null && (typeof e.reason !== 'string' || !e.reason)) throw new Error('An unknown measurement needs a reason.');
      return { type: e.type, proposalId: e.proposalId, phase: e.phase, sha: e.sha, value: e.value, reason: e.value === null ? String(e.reason).slice(0, 300) : null };
    case 'promotion':
      if (typeof e.headSha !== 'string' || !SHA.test(e.headSha)) throw new Error('Invalid head SHA.');
      if (e.decision !== 'merge-queued' && e.decision !== 'refused') throw new Error('Invalid decision.');
      return { type: e.type, proposalId: e.proposalId, headSha: e.headSha, decision: e.decision, reasons: e.reasons.map((r) => String(r).slice(0, 300)).slice(0, 20) };
    default: throw new Error('Unknown ledger event.');
  }
}

export interface LedgerRead { records: LedgerRecord[]; intact: boolean; reasons: string[] }

/** Read and verify the chain. A broken chain keeps the verified prefix only. */
export function readLedger(path = outcomesLedgerPath()): LedgerRead {
  if (!existsSync(path)) return { records: [], intact: true, reasons: [] };
  const raw = readFileSync(path, 'utf8');
  if (raw.length > MAX_LEDGER_BYTES) return { records: [], intact: false, reasons: ['ledger-too-large'] };
  const records: LedgerRecord[] = [];
  let prev = ZERO;
  for (const [i, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as LedgerRecord;
      const { digest, ...body } = rec;
      if (rec.v !== 1 || rec.prev !== prev || digestOf(body) !== digest) return { records, intact: false, reasons: [`chain-broken-at-line-${i + 1}`] };
      validateEvent(rec);
      records.push(rec);
      prev = digest;
    } catch { return { records, intact: false, reasons: [`unreadable-line-${i + 1}`] }; }
  }
  return { records, intact: true, reasons: [] };
}

export function appendLedger(event: LedgerEvent, opts: { path?: string; now?: Date } = {}): LedgerRecord {
  const path = opts.path ?? outcomesLedgerPath();
  const clean = validateEvent(event);
  const read = readLedger(path);
  if (!read.intact) throw new Error(`Outcome ledger is not intact (${read.reasons.join(', ')}); refusing to append.`);
  const body = { ...clean, v: 1 as const, at: (opts.now ?? new Date()).toISOString(), prev: read.records.at(-1)?.digest ?? ZERO };
  const rec = { ...body, digest: digestOf(body) } as LedgerRecord;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  return rec;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type OutcomeStatus = 'improved' | 'unchanged' | 'regressed' | 'unknown';
export interface ProposalOutcome {
  proposalId: string;
  title: string;
  proposalKind: string;
  source: ProposerSource;
  metric: MetricSpec;
  predictedDelta: number | null;
  pr: { repository: string; number: number } | null;
  base: { sha: string; value: number } | null;
  head: { sha: string; value: number } | null;
  /** Signed so that positive is always better, whatever the metric direction. */
  effect: number | null;
  relativeEffect: number | null;
  status: OutcomeStatus;
  reasons: string[];
  promotion: { headSha: string; decision: 'merge-queued' | 'refused' } | null;
}

/** Repeated measurements of one commit must agree exactly, otherwise the metric is not deterministic. */
function phaseValue(ms: Extract<LedgerEvent, { type: 'measured' }>[], reasons: string[], phase: MeasurementPhase): { sha: string; value: number } | null {
  if (!ms.length) { reasons.push(`${phase}-not-measured`); return null; }
  const latestSha = ms.at(-1)!.sha;
  const same = ms.filter((m) => m.sha === latestSha);
  const unknown = same.find((m) => m.value === null);
  if (unknown) { reasons.push(`${phase}-unknown: ${unknown.reason}`); return null; }
  const values = new Set(same.map((m) => m.value));
  if (values.size > 1) { reasons.push(`${phase}-nondeterministic`); return null; }
  return { sha: latestSha, value: same[0]!.value! };
}

export function scoreOutcomes(records: readonly LedgerRecord[]): ProposalOutcome[] {
  const byId = new Map<string, LedgerRecord[]>();
  for (const r of records) byId.set(r.proposalId, [...(byId.get(r.proposalId) ?? []), r]);
  const out: ProposalOutcome[] = [];
  for (const [proposalId, rs] of byId) {
    const reg = rs.filter((r): r is LedgerRecord & { type: 'registered' } => r.type === 'registered').at(-1);
    if (!reg) continue; // Measurements without a registered hypothesis earn nothing.
    const reasons: string[] = [];
    const after = rs.slice(rs.indexOf(reg));
    const measured = after.filter((r): r is LedgerRecord & { type: 'measured' } => r.type === 'measured');
    const base = phaseValue(measured.filter((m) => m.phase === 'base'), reasons, 'base');
    const head = phaseValue(measured.filter((m) => m.phase === 'head'), reasons, 'head');
    let effect: number | null = null;
    let relativeEffect: number | null = null;
    let status: OutcomeStatus = 'unknown';
    if (base && head) {
      if (base.sha === head.sha) reasons.push('base-and-head-are-the-same-commit');
      else {
        const sign = reg.metric.direction === 'increase' ? 1 : -1;
        effect = sign * (head.value - base.value);
        relativeEffect = base.value !== 0 ? effect / Math.abs(base.value) : null;
        status = effect > 0 ? 'improved' : effect < 0 ? 'regressed' : 'unchanged';
      }
    }
    const pr = after.filter((r): r is LedgerRecord & { type: 'pr' } => r.type === 'pr').at(-1);
    const promo = after.filter((r): r is LedgerRecord & { type: 'promotion' } => r.type === 'promotion').at(-1);
    out.push({ proposalId, title: reg.title, proposalKind: reg.proposalKind, source: reg.source, metric: reg.metric,
      predictedDelta: reg.predictedDelta, pr: pr ? { repository: pr.repository, number: pr.number } : null,
      base, head, effect, relativeEffect, status, reasons,
      promotion: promo ? { headSha: promo.headSha, decision: promo.decision } : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline comparison and leverage ranking
// ---------------------------------------------------------------------------

export const MIN_GROUP_SAMPLES = 3;
export const sourceKey = (s: ProposerSource) => s.kind === 'deterministic' ? 'deterministic' : `model:${s.engine}/${s.model}`;

export interface SourceSummary {
  key: string;
  measured: number;
  unknown: number;
  improved: number;
  regressed: number;
  /** Share of measured proposals that improved their metric; null below MIN_GROUP_SAMPLES. */
  improvementRate: number | null;
  /** Difference from the deterministic baseline's rate; null when either side is too small. */
  versusDeterministic: number | null;
}

export function summarizeBySource(outcomes: readonly ProposalOutcome[]): SourceSummary[] {
  const groups = new Map<string, ProposalOutcome[]>();
  for (const o of outcomes) groups.set(sourceKey(o.source), [...(groups.get(sourceKey(o.source)) ?? []), o]);
  const rows = [...groups].map(([key, os]) => {
    const measured = os.filter((o) => o.status !== 'unknown');
    const improved = measured.filter((o) => o.status === 'improved').length;
    return { key, measured: measured.length, unknown: os.length - measured.length, improved,
      regressed: measured.filter((o) => o.status === 'regressed').length,
      improvementRate: measured.length >= MIN_GROUP_SAMPLES ? improved / measured.length : null, versusDeterministic: null as number | null };
  });
  const det = rows.find((r) => r.key === 'deterministic')?.improvementRate ?? null;
  for (const r of rows) {
    if (r.key !== 'deterministic' && det !== null && r.improvementRate !== null) r.versusDeterministic = r.improvementRate - det;
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Realized leverage per proposal kind: (improved - regressed) / (measured + 1).
 * The +1 shrinks single lucky results toward zero. Kinds with no measured
 * outcome are unknown (null), not zero.
 */
export function kindLeverage(outcomes: readonly ProposalOutcome[]): Map<string, number | null> {
  const acc = new Map<string, { n: number; net: number }>();
  for (const o of outcomes) {
    const a = acc.get(o.proposalKind) ?? { n: 0, net: 0 };
    if (o.status !== 'unknown') { a.n++; a.net += o.status === 'improved' ? 1 : o.status === 'regressed' ? -1 : 0; }
    acc.set(o.proposalKind, a);
  }
  return new Map([...acc].map(([k, a]) => [k, a.n ? a.net / (a.n + 1) : null]));
}

/**
 * Order proposals by realized leverage of their kind: proven-positive kinds
 * first, then unmeasured kinds (worth exploring, in their original order),
 * then kinds whose measured record is zero or negative. Stable otherwise.
 */
export function rankByLeverage<T extends { kind?: string }>(proposals: readonly T[], outcomes: readonly ProposalOutcome[]): T[] {
  const lev = kindLeverage(outcomes);
  const tier = (p: T) => {
    const v = p.kind ? lev.get(p.kind) ?? null : null;
    return v === null ? { t: 1, v: 0 } : v > 0 ? { t: 0, v } : { t: 2, v };
  };
  return proposals.map((p, i) => ({ p, i, ...tier(p) }))
    .sort((a, b) => a.t - b.t || b.v - a.v || a.i - b.i)
    .map((x) => x.p);
}
