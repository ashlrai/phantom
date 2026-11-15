/**
 * File contracts Eng Ops writes. Human steps use ashlr.human-steps/v1.
 * Weekly bottlenecks use bottlenecks.v1 and stay in file order (top 3).
 */
import { scrubSecrets } from '../util/scrub.js';
import type { BottleneckItem, HumanDecision } from './types.js';
import { BOTTLENECKS_SCHEMA, HUMAN_STEPS_SCHEMA } from './types.js';

const METRICS = new Set([
  'worktree_checkout_time',
  'worktree_checkout_count',
  'ci_minutes',
  'merge_queue_wait',
  'rebase_churn',
  'release_merge_to_installed',
  'lane_underfill',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  if (!text || text !== value.trim() || text.includes('[REDACTED]')) return null;
  return text.slice(0, max);
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface HumanStepsFile {
  source: string | null;
  stepsRemaining: number | null;
  decisions: HumanDecision[];
  reason: string | null;
}

export function parseHumanSteps(raw: unknown): HumanStepsFile {
  const body = record(raw);
  if (!body || body['schema'] !== HUMAN_STEPS_SCHEMA) {
    return { source: null, stepsRemaining: null, decisions: [], reason: 'human-steps file is missing or not ashlr.human-steps/v1' };
  }
  const steps = body['stepsRemaining'];
  if (typeof steps !== 'number' || !Number.isSafeInteger(steps) || steps < 0) {
    return { source: null, stepsRemaining: null, decisions: [], reason: 'stepsRemaining is not a measured count' };
  }
  const decisions: HumanDecision[] = [];
  for (const row of Array.isArray(body['decisions']) ? body['decisions'] : []) {
    const item = record(row);
    if (!item) continue;
    const id = clean(item['id'], 80);
    const at = iso(item['at']);
    const title = clean(item['title'], 200);
    const kind = item['kind'] === 'decision' || item['kind'] === 'approval' ? item['kind'] : null;
    const status = item['status'] === 'pending' || item['status'] === 'approved' || item['status'] === 'rejected' || item['status'] === 'recorded'
      ? item['status'] : null;
    if (!id || !at || !title || !kind || !status) continue;
    decisions.push({ id, at, kind, title, actor: clean(item['actor'], 80), status });
  }
  return { source: clean(body['source'], 80), stepsRemaining: steps, decisions, reason: null };
}

export function parseBottlenecks(raw: unknown): { source: string | null; top: BottleneckItem[]; reason: string | null } {
  const body = record(raw);
  if (!body || body['schema'] !== BOTTLENECKS_SCHEMA || !Array.isArray(body['items'])) {
    return { source: null, top: [], reason: 'bottlenecks file is missing or not bottlenecks.v1' };
  }
  const top: BottleneckItem[] = [];
  for (const row of body['items']) {
    if (top.length >= 3) break;
    const item = record(row);
    if (!item) continue;
    const id = clean(item['id'], 80);
    const metric = typeof item['metric'] === 'string' ? item['metric'] : '';
    const unit = clean(item['unit'], 40);
    const owner = clean(item['owner'], 80);
    const value = num(item['value']);
    if (!id || !METRICS.has(metric) || !unit || !owner || value === null) continue;
    top.push({
      id, metric, value, unit, owner,
      before: num(item['before']),
      after: num(item['after']),
      verifiedAt: iso(item['verifiedAt']),
    });
  }
  if (top.length === 0) return { source: clean(body['source'], 80), top: [], reason: 'No measured bottleneck rows' };
  return { source: clean(body['source'], 80), top, reason: null };
}
