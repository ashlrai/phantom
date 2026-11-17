import { join } from 'node:path';
import { QueueStore } from '../queue/store.js';
import type { QueueJob } from '../queue/schema.js';
import { VerseError } from '../verse/session-engine.js';
import { countQueuedDropJobPrompts, DROP_JOB_QUEUE_LIMIT, dropJobExists, DropJobExistsError,
  resolveDropJobRoot, validateDropJob, writeDropJob } from '../fleet/drop-job-writer.js';
import { readDropJobFates } from '../fleet/drop-job-fate.js';
import { mergedJobsFromJsonl, readSource } from '../fleet/runs-parked-queue.js';
import type { OwnerAssistHandoff, OwnerAssistHandoffReceipt } from './types.js';

/** Private receipt metadata carried on the stored queue row; never dispatched on it. */
type StoredReceipt = QueueJob & { sessionId?: string; sourceTitle?: string; submittedAt?: string };

const fleetId = (id: string) => `RQ-PHX-OWNER${id.slice('RQ-OWNER-'.length).replaceAll('-', '').toUpperCase()}`;
const invalid = (message: string): never => { throw new VerseError('VERSE_INVALID', message); };
const prUrl = (value: unknown): string | undefined => typeof value === 'string'
  && /^https:\/\/github\.com\/ashlrai\/phantom\/pull\/\d+$/.test(value) ? value : undefined;

/** Receipts are private; the existing drop writer is the only fleet mutation. */
export class OwnerAssistHandoffs {
  private submitting = false;
  private readonly receipts: QueueStore;
  private readonly runs: string;
  constructor(root: string, runsRoot?: string) {
    this.receipts = new QueueStore(join(root, 'owner-assist.handoffs'));
    this.runs = resolveDropJobRoot(runsRoot);
  }
  async submit(request: OwnerAssistHandoff, source?: { sessionId: string; title: string }): Promise<OwnerAssistHandoffReceipt> {
    if (this.submitting) return invalid('Another handoff is being submitted. Retry shortly.');
    this.submitting = true;
    try {
      // The installed drop-ingest contract currently accepts Phantom only.
      if (request.repo !== 'ashlrai/phantom') return invalid('Fleet intake currently supports ashlrai/phantom. Other projects can run in your personal session.');
      const id = fleetId(request.id);
      const input = { id: id.slice('RQ-PHX-'.length), lane: 'codex-personal', tier: request.tier,
        body: `# Owner Assist handoff\n\n${request.scope}\n\nAcceptance criteria:\n${request.acceptance}` };
      const valid = validateDropJob(input);
      if (!valid.ok) return invalid(`Fleet intake refused this task: ${valid.reasons.join(', ')}.`);
      const previous = (await this.receipts.read()).jobs.find(j => j.id === request.id) as StoredReceipt | undefined;
      if (previous && (['repo', 'scope', 'acceptance', 'tier', 'sessionId'] as const).some(k => previous[k] !== request[k])) return invalid('Handoff id already belongs to a different task.');
      const observed = (await this.list()).find(j => j.id === request.id);
      if (observed) return observed;
      if (previous) return invalid('This earlier handoff has no recent evidence. Review its fleet job before submitting a new task.');
      if (await dropJobExists(this.runs, input.id)) return invalid('This fleet job id is already in use.');
      if (await countQueuedDropJobPrompts(this.runs) >= DROP_JOB_QUEUE_LIMIT) return invalid('Fleet intake is full. Retry later.');
      const submittedAt = new Date().toISOString();
      const record: StoredReceipt = { ...request, status: 'PROPOSED', priority: 'P1', min_tier: request.tier,
        max_cost_class: 'included', needs: ['code'], deps: [], claims: [], submittedAt,
        ...(source ? { sessionId: source.sessionId, sourceTitle: source.title.slice(0, 200) } : {}) };
      await this.receipts.add(record);
      try { await writeDropJob(this.runs, input); }
      catch (e) { if (!(e instanceof DropJobExistsError)) throw e; }
      return { ...request, fleetJobId: id, status: 'SUBMITTED', submittedAt, ...(source ? { sourceTitle: source.title.slice(0, 200) } : {}) };
    } finally { this.submitting = false; }
  }
  async list(): Promise<OwnerAssistHandoffReceipt[]> {
    const jobs = (await this.receipts.read()).jobs.slice(-30).reverse();
    if (!jobs.length) return [];
    const [fates, metrics] = await Promise.all([
      readDropJobFates({ runsRoot: this.runs, limit: 50 }),
      readSource(join(this.runs, 'metrics/jobs.jsonl'), 1024 * 1024, true),
    ]);
    const merged = mergedJobsFromJsonl(metrics.text);
    const observed = new Map<string, { status: OwnerAssistHandoffReceipt['status']; prUrl?: string }>();
    for (const line of metrics.text.split('\n')) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const id = row.job ?? row.job_id ?? row.jobId;
        if (typeof id !== 'string') continue;
        const url = prUrl(row.url ?? row.prUrl ?? row.pr_url);
        if (url) observed.set(id, { status: 'PR-OPEN', prUrl: url });
        else if (!observed.get(id)?.prUrl && row.event === 'launch') observed.set(id, { status: 'RUNNING' });
        else if (!observed.get(id)?.prUrl && row.event === 'outcome') observed.set(id, { status: 'FINISHED' });
      } catch { /* malformed or truncated evidence never invents success */ }
    }
    return Promise.all(jobs.map(async job => {
      const stored = job as StoredReceipt;
      const id = fleetId(job.id);
      const fate = fates.fates.find(f => f.id === id.slice('RQ-PHX-'.length));
      const publish = await readSource(join(this.runs, `${id}.publish`), 65536, false);
      const url = prUrl(publish.text.match(/^RESULT\s+PR\s+(\S+)/m)?.[1]) ?? observed.get(id)?.prUrl;
      const status = merged.has(id) ? 'MERGED' : url ? 'PR-OPEN' : observed.get(id)?.status
        ?? (fate?.fate === 'rejected' ? 'REJECTED' : fate?.fate === 'ingested' ? 'QUEUED'
          : await dropJobExists(this.runs, id.slice('RQ-PHX-'.length)) ? 'SUBMITTED' : 'UNOBSERVED');
      return { id: job.id, fleetJobId: id, repo: job.repo, scope: job.scope, acceptance: job.acceptance,
        tier: job.tier as OwnerAssistHandoff['tier'], status, ...(url ? { prUrl: url } : {}),
        ...(typeof stored.sessionId === 'string' ? { sessionId: stored.sessionId } : {}),
        ...(typeof stored.sourceTitle === 'string' ? { sourceTitle: stored.sourceTitle.slice(0, 200) } : {}),
        ...(typeof stored.submittedAt === 'string' ? { submittedAt: stored.submittedAt } : {}) };
    }));
  }
}
