/** Evidence-only lane fit. Missing outcomes and dimensions are never inferred. */
export interface LaneFitKind {
  repo: string | null;
  tier: string | null;
  verb: string | null;
  jobs: number;
  prs: number;
  unknownOutcomes: number;
  prRate: number | null;
  recommendation: 'send' | 'avoid' | 'unknown';
}
export interface LaneFitReport {
  schema: 'lanes.fit.v1';
  lane: string;
  known: boolean;
  kinds: LaneFitKind[];
}

type Row = Record<string, unknown>;
const field = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Pure function suitable for router callers; null text denotes an unreadable ledger. */
export function computeLaneFit(text: string | null, lane: string): LaneFitReport {
  const report: LaneFitReport = { schema: 'lanes.fit.v1', lane, known: text !== null, kinds: [] };
  if (text === null) return report;
  const jobs = new Map<string, { launches: Row[]; rows: Row[] }>();
  for (const line of text.split('\n')) {
    let row: Row;
    try { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) continue; row = value as Row; } catch { continue; }
    const id = field(row.job);
    if (!id) continue;
    const job = jobs.get(id) ?? { launches: [], rows: [] };
    if (row.event === 'launch') job.launches.push(row);
    job.rows.push(row); jobs.set(id, job);
  }
  const groups = new Map<string, LaneFitKind>();
  for (const job of jobs.values()) {
    // Reused job IDs cannot safely associate later outcomes with an attempt.
    if (job.launches.length !== 1 || job.launches[0]!.lane !== lane) continue;
    const launch = job.launches[0]!;
    const repo = field(launch.repo), tier = field(launch.tier);
    const verb = field(launch.task_verb) ?? field(launch.taskVerb) ?? field(launch.verb);
    const key = JSON.stringify([repo, tier, verb]);
    const group = groups.get(key) ?? { repo, tier, verb, jobs: 0, prs: 0, unknownOutcomes: 0, prRate: null, recommendation: 'unknown' };
    group.jobs++;
    const published = job.rows.some(row => (row.event === 'publish' && field(row.url) !== null) ||
      (row.event === 'outcome' && (row.state === 'MERGED' || row.outcome === 'MERGED')) ||
      (row.outcome === 'PUBLISHED' && (field(row.prUrl) !== null || field(row.pr) !== null)));
    if (published) group.prs++;
    else if (!job.rows.some(row => row.event === 'finish' && row.empty === true)) group.unknownOutcomes++;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const measured = group.jobs - group.unknownOutcomes;
    group.prRate = measured ? group.prs / measured : null;
    if (group.repo && group.tier && group.verb && measured >= 3 && group.prRate !== null) {
      group.recommendation = group.prRate < 0.3 ? 'avoid' : 'send';
    }
    report.kinds.push(group);
  }
  report.kinds.sort ( (a, b) => JSON.stringify([a.repo, a.tier, a.verb]).localeCompare(JSON.stringify([b.repo, b.tier, b.verb])) );
  return report;
}
