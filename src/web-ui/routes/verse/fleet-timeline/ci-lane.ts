import type { SwimlaneItem, SwimlaneLane } from '../../../components/charts/Swimlane.js';

type CiRun = {
  runId: number; workflow: string; event: string; prNumber: number | null;
  conclusion: string | null; status: string; failureClass: 'bind-artifact' | 'code' | null;
  createdAt: string; url: string;
};
type CiFacts = {
  v: 1; available: true; total: number;
  failures: { total: number; bindArtifact: number; code: number };
  daily: { runId: number; conclusion: string | null } | null;
  recent: CiRun[];
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function run(value: unknown): value is CiRun {
  return record(value) && count(value.runId) && typeof value.workflow === 'string' && typeof value.event === 'string'
    && (value.prNumber === null || count(value.prNumber)) && (value.conclusion === null || typeof value.conclusion === 'string')
    && typeof value.status === 'string' && (value.failureClass === null || value.failureClass === 'bind-artifact' || value.failureClass === 'code')
    && typeof value.createdAt === 'string' && typeof value.url === 'string';
}

function ciFacts(value: unknown): CiFacts | null {
  if (!record(value) || value.v !== 1 || value.available !== true || !count(value.total)
    || !record(value.failures) || !count(value.failures.total) || !count(value.failures.bindArtifact) || !count(value.failures.code)
    || !(value.daily === null || (record(value.daily) && count(value.daily.runId)
      && (value.daily.conclusion === null || typeof value.daily.conclusion === 'string')))
    || !Array.isArray(value.recent) || !value.recent.every(run)) return null;
  return value as CiFacts;
}

export function ciLane(facts: unknown, from: number, to: number): { lane: SwimlaneLane | null; unplaced: number; headline: string | null } {
  const data = ciFacts(facts);
  if (!data) return { lane: null, unplaced: 0, headline: null };
  let unplaced = 0;
  const items = data.recent.flatMap((entry): SwimlaneItem[] => {
    const start = Date.parse(entry.createdAt);
    if (!Number.isFinite(start)) { unplaced++; return []; }
    if (start < from || start > to) return [];
    const nightly = data.daily?.runId === entry.runId;
    const label = `${nightly ? 'Nightly · ' : ''}CI #${entry.runId} · ${entry.workflow} · ${entry.event}`
      + (entry.prNumber === null ? '' : ` · PR #${entry.prNumber}`)
      + (entry.failureClass === null ? '' : ` · ${entry.failureClass === 'bind-artifact' ? 'bind artifact' : 'code'}`);
    return [{ id: `ci:${entry.runId}`, label, start, end: entry.status === 'completed' ? start + 60_000 : null,
      status: entry.conclusion === 'failure' ? 'failed' : entry.conclusion === 'success' ? 'done' : 'running' }];
  }).sort((a, b) => a.start - b.start);
  const nightly = data.daily?.conclusion === 'success' ? 'green' : data.daily?.conclusion === 'failure' ? 'red' : 'none';
  const headline = `${data.total} runs · ${data.failures.total} failed (${data.failures.bindArtifact} branch-behind, ${data.failures.code} code) · nightly ${nightly}`;
  return { lane: { id: 'ci', label: 'CI', items }, unplaced, headline };
}

export function ciRunUrl(facts: unknown, id: string): string | null {
  const entry = ciFacts(facts)?.recent.find((item) => `ci:${item.runId}` === id);
  if (!entry) return null;
  try {
    const url = new URL(entry.url);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}
