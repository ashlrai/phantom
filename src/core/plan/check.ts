/**
 * Typed pre-queue check for a leader plan file (`phm plan check`).
 * A plan is Markdown with READY bet lines: `- READY <id> (P1, pool=<lane>, repo=<repo>, size<=200): task Acceptance: ...`.
 * The line grammar is the restock lint's (`parseReadyLine`); this module only adds plan-level rules.
 */
import { parseReadyLine } from '../portfolio/restock-lint.js';

export const PLAN_CHECK_SCHEMA = 'plan.check.v1';
export const DEFAULT_MIN_BETS = 3;

export type PlanProblemKind = 'too-few-bets' | 'malformed-ready-line' | 'missing-acceptance' | 'duplicate-id' | 'pool-drained';
export interface PlanBet { id: string; pool: string; repo: string; size: number | null; has_acceptance: boolean }
/** line is 1-based; 0 means the whole file (too-few-bets). */
export interface PlanProblem { line: number; kind: PlanProblemKind; detail: string }
export interface PlanCheckReport { schema: typeof PLAN_CHECK_SCHEMA; ok: boolean; minBets: number; bets: PlanBet[]; problems: PlanProblem[] }
export interface PlanCheckOptions { minBets?: number; drained?: readonly string[] }

const attr = (attrs: string, key: string): string => new RegExp(`(?:^|[\\s,])${key}=([^\\s,]+)`).exec(attrs)?.[1] ?? '';
const SIZE = /(?:^|[\s,])size(?:<=|=)(\d+)/;
const ACCEPTANCE = /\bAcceptance:\s*\S/;
const READY_START = /^(?:- )?READY\b/;

export function checkPlan(text: string, opts: PlanCheckOptions = {}): PlanCheckReport {
  const minBets = opts.minBets ?? DEFAULT_MIN_BETS;
  const drained = new Set((opts.drained ?? []).map(l => l.trim()).filter(Boolean));
  const bets: PlanBet[] = [];
  const problems: PlanProblem[] = [];
  const seen = new Map<string, number>();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    if (!READY_START.test(raw)) continue;
    const line = index + 1;
    const parsed = parseReadyLine(raw.startsWith('READY') ? `- ${raw}` : raw);
    if (!parsed) { problems.push({ line, kind: 'malformed-ready-line', detail: 'Expected "- READY <id> (<attributes>): <task>".' }); continue; }
    const pool = attr(parsed.attrs, 'pool'), repo = attr(parsed.attrs, 'repo');
    const missing = [pool ? '' : 'pool=', repo ? '' : 'repo='].filter(Boolean);
    if (missing.length) { problems.push({ line, kind: 'malformed-ready-line', detail: `${parsed.jobId} has no ${missing.join(' or ')} attribute.` }); continue; }
    const size = SIZE.exec(parsed.attrs)?.[1];
    const hasAcceptance = ACCEPTANCE.test(parsed.task);
    const first = seen.get(parsed.jobId);
    if (first !== undefined) problems.push({ line, kind: 'duplicate-id', detail: `${parsed.jobId} already appears on line ${first}.` });
    else seen.set(parsed.jobId, line);
    if (!hasAcceptance) problems.push({ line, kind: 'missing-acceptance', detail: `${parsed.jobId} has no "Acceptance:" text.` });
    if (drained.has(pool)) problems.push({ line, kind: 'pool-drained', detail: `${parsed.jobId} is on ${pool}, which has no usage left.` });
    bets.push({ id: parsed.jobId, pool, repo, size: size === undefined ? null : Number(size), has_acceptance: hasAcceptance });
  }
  if (bets.length < minBets) problems.push({ line: 0, kind: 'too-few-bets', detail: `Found ${bets.length} valid bet${bets.length === 1 ? '' : 's'}, need at least ${minBets}.` });
  problems.sort((a, b) => a.line - b.line);
  return { schema: PLAN_CHECK_SCHEMA, ok: problems.length === 0, minBets, bets, problems };
}

export const planProblemLine = (p: PlanProblem): string => `${p.line > 0 ? `line ${p.line}` : 'plan'}: ${p.kind}: ${p.detail}`;
