import { randomUUID } from 'node:crypto';
import type { QueueDocument, QueueJob } from './schema.js';

export interface ReplayOptions {
  since?: string;
  query?: string;
  mode?: 'replay_failed' | 'replay_failed_and_dependents';
  dryRun?: boolean;
}
/** Plan against a locked snapshot when writing. Original attempts remain immutable. */
export function planReplay(doc: QueueDocument, options: ReplayOptions): QueueJob[] {
  const mode = options.mode ?? 'replay_failed';
  if (!['replay_failed', 'replay_failed_and_dependents'].includes(mode)) throw new Error('Invalid replay mode');
  if (options.since !== undefined && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(options.since) || !Number.isFinite(Date.parse(options.since)))) throw new Error('Invalid --since ISO timestamp with timezone');
  const query = options.query?.toLowerCase() ?? '';
  const selected = new Set(doc.jobs.filter(job => job.status === 'BLOCKED' && job.claims.at(-1)?.finishedAt &&
    (!options.since || Date.parse(job.claims.at(-1)!.finishedAt!) >= Date.parse(options.since)) &&
    [job.id, job.repo, job.scope, job.acceptance, job.blockedReason ?? ''].join(' ').toLowerCase().includes(query)).map(job => job.id));
  if (mode === 'replay_failed_and_dependents') {
    let previous = -1;
    while (previous !== selected.size) {
      previous = selected.size;
      for (const job of doc.jobs) if (!job.replayOf && job.deps.some(dep => selected.has(dep))) selected.add(job.id);
    }
  }
  const active = (job: QueueJob) => ['READY', 'CLAIMED', 'PR-OPEN'].includes(job.status);
  const mapped = new Map<string, string>();
  for (const id of selected) {
    const original = doc.jobs.find(job => job.id === id)!;
    if (active(original)) throw new Error(`Active dependent must finish before replay: ${id}`);
    const existing = doc.jobs.find(job => job.replayOf === id && active(job));
    mapped.set(id, existing?.id ?? `${id}.replay.${randomUUID()}`);
  }
  const planned: QueueJob[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Replay dependency cycle');
    visiting.add(id);
    const job = doc.jobs.find(row => row.id === id)!;
    for (const dep of job.deps) if (selected.has(dep)) visit(dep);
    visiting.delete(id); visited.add(id);
    if (doc.jobs.some(row => row.id === mapped.get(id))) return;
    const { prUrl: _pr, blockedReason: _reason, ...original } = job;
    planned.push({ ...original, id: mapped.get(id)!, status: 'READY', claims: [],
      deps: job.deps.map(dep => mapped.get(dep) ?? dep), replayOf: id, replayedAt: new Date().toISOString() });
  };
  for (const id of selected) visit(id);
  return planned;
}
