import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardianReceipt, planGuardianEmptyRecovery } from '../src/core/fleet/guardian-empty-recovery.js';
import { cmdJobsRetryEmpty } from '../src/cli/jobs-retry-empty.js';

const job = 'RQ-FIX-MAIN-phantom-abc1234';
const queue = `- DONE ${job} (P0, pool=codex-personal, tier=work, repo=phantom, size<=80): Fix failing typecheck.\n`;
const launch = { event: 'launch', job, lane: 'codex-personal', repo: 'phantom', tier: 'work', ts: '2026-11-23T12:00:00Z' };
const finish = { event: 'finish', job, empty: true, exit_code: 124, failure_reason: 'launch_timeout', ts: '2026-11-23T12:05:00Z' };
const ledger = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
const initial = ledger(launch, finish);
const routing = () => ({ models: { claude: 'gpt-6.1-sol' }, admission: { admit: true },
  slots: { claude: { target: 1, hard_cap: 1, tiers: ['fast', 'mid', 'work', 'frontier'], cost_class: 'included', data_class: 'internal', capabilities: ['git'] } },
  capacity: { claude: { resetAt: null, remainingPercent: 50, observedAt: new Date().toISOString() } },
  request: { task_class: 'bug-fix', repo: 'phantom', tier_hint: 'work', lane_candidates: ['claude', 'codex-personal'],
    quota_state: { claude: 'available' }, machine_state: { admit: true, running_by_lane: { claude: 0 } } } });
const plan = (q: string, l: string, r: Set<string>) => planGuardianEmptyRecovery(q, l, r, routing());
const retry = () => plan(queue, initial, new Set()).lines[0]!;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('preserves failure references, source constraints and measured tier with one deterministic retry', () => {
  const line = retry();
  expect(line).toContain(`${job}-EMPTYRETRY-work (P0, pool=claude, tier=work, repo=phantom, size<=80)`);
  expect(line).toContain(`${job}.log`); expect(line).toContain('exit 124');
  expect(plan(queue, initial, new Set()).lines).toEqual([line]);
  expect(plan(queue.replace('tier=work', 'tier=fast'), initial, new Set()).lines[0]).toContain('tier=work');
  expect(plan(queue, ledger(launch, { ...finish, exit_code: 0 }), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, { ...finish, exit_code: null }), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, { ...finish, exit_code: 0, pool_error: 'rate_limit' }), new Set()).lines).toHaveLength(1);
});

it.each(['missing', 'quota', 'held', 'full', 'stale', 'metered', 'needs', 'data', 'ceiling', 'local', 'unknown-lane'])('defers recovery when alternate routing is %s', gate => {
  const s = routing(); let q = queue, l = initial;
  if (gate === 'quota') s.request.quota_state.claude = 'exhausted';
  if (gate === 'held') Object.assign(s.slots.claude, { held: true });
  if (gate === 'full') s.request.machine_state.running_by_lane.claude = 1;
  if (gate === 'stale') s.capacity.claude.observedAt = '2026-11-01T00:00:00Z';
  if (gate === 'metered') s.slots.claude.cost_class = 'metered';
  if (gate === 'needs') q = q.replace('size<=80', 'size<=80, needs=browser');
  if (gate === 'data') q = q.replace('size<=80', 'size<=80, data_class=restricted');
  if (gate === 'ceiling') q = q.replace('size<=80', 'size<=80, max_tier=fast');
  if (gate === 'local') q = q.replace('pool=codex-personal', 'pool=codex-local');
  if (gate === 'unknown-lane') l = ledger({ ...launch, lane: undefined }, finish);
  expect(planGuardianEmptyRecovery(q, l, new Set(), gate === 'missing' ? undefined : s).lines).toEqual([]);
});

it('excludes the measured failed lane and updates every routing hint while retaining requirements', () => {
  expect(plan(queue, ledger({ ...launch, lane: 'claude' }, finish), new Set()).lines).toEqual([]);
  const q = queue.replace('size<=80', 'size<=80, preferred_lane=codex-personal, needs=git, data_class=internal');
  expect(plan(q, initial, new Set()).lines[0]).toContain('pool=claude, tier=work, repo=phantom, size<=80, preferred_lane=claude, needs=git, data_class=internal');
});

it('deduplicates queued and live jobs, duplicate finishes, pending PRs and torn evidence', () => {
  expect(plan(queue, ledger(launch, finish, finish), new Set()).lines).toEqual([retry()]);
  const child = `${job}-EMPTYRETRY-work`;
  for (const state of ['READY', 'CLAIMED codex-personal now']) {
    expect(plan(queue + retry().replace('- READY', `- ${state}`), initial, new Set()).lines).toEqual([]);
  }
  for (const extra of [{ ...launch, job: child }, { event: 'publish', job, ts: finish.ts, url: 'https://github.com/ashlrai/phantom/pull/42' }]) {
    expect(plan(queue, ledger(launch, finish, extra), new Set()).lines).toEqual([]);
  }
  for (const extra of [{ event: 'publish', job, ts: finish.ts, url: 'https://github.com/ashlrai/phantom/pull/42' },
    { event: 'outcome', job, ts: finish.ts, state: 'MERGED' }, { id: job, ts: finish.ts, status: 'MERGED' },
    { ...finish, conclusion: 'CLOSED' }]) {
    expect(plan(queue, ledger(launch, finish, extra, finish), new Set()).lines).toEqual([]);
  }
  expect(plan(queue, initial + '\n{', new Set()).lines).toEqual([]);
  expect(plan(queue + queue, initial, new Set()).lines).toEqual([]);
  expect(plan(queue.replace('- DONE', '- READY'), initial, new Set()).lines).toEqual([]);
  const newer = { ...launch, ts: '2026-11-23T12:10:00Z' };
  expect(plan(queue, ledger(launch, newer, finish), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, newer, { event: 'other' }, finish), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, { ...newer, ts: finish.ts }, finish), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, finish, { ...newer, job: 'RQ-FIX-MAIN-other', repo: 'phantom' }), new Set()).lines).toEqual([]);
  expect(plan(queue, ledger(launch, finish, { ...newer, job: 'RQ-FIX-MAIN-other', repo: 'locus' }), new Set()).lines).toHaveLength(1);
  expect(plan(queue, ledger(launch, finish, { ...newer, ts: 'unknown' }), new Set()).lines).toEqual([]);
});

it('exhausts one retry per tier without retry chains and retains the failed child context', () => {
  const child = `${job}-EMPTYRETRY-work`, receipt = new Set([guardianReceipt(job, 'work')]);
  const pending = queue + retry();
  expect(plan(pending, initial, receipt)).toEqual({ lines: [], escalations: [] });
  const done = ledger(launch, finish, { ...launch, job: child }, { ...finish, job: child, exit_code: 2 });
  const exhausted = plan(pending, done, receipt);
  expect(exhausted.lines).toEqual([]);
  expect(exhausted.escalations).toEqual([{ job: child, root: job, tier: 'work', exitCode: 2, reason: 'The run failed without a publishable change.' }]);
  expect(plan(pending, done + '\n' + JSON.stringify({ ...finish, job: child, exit_code: 2 }), receipt)).toEqual(exhausted);
  expect(plan(queue, initial, receipt).lines).toEqual([]); // Receipt survives queue removal.
  expect(plan(queue.replace('tier=work', 'tier=mid'), ledger({ ...launch, tier: 'mid' }, finish), receipt).lines).toHaveLength(1);
});

it('CLI previews then applies once, preserving the original ledger, log and queue bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-empty-'));
  try {
    vi.stubEnv('ASHLR_RUNS_DIR', dir); vi.stubEnv('ASHLR_WT_DIR', join(dir, 'wt'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
    const s = routing();
    for (const [path, data] of Object.entries({ 'models.json': s.models, 'queue/slots.json': s.slots, 'queue/admission.json': s.admission,
      'queue/route-capacity.json': s.capacity, 'queue/route-request.json': s.request })) await writeFile(join(dir, path), JSON.stringify(data));
    const file = join(dir, 'queue/router-queue.md'), jobs = join(dir, 'metrics/jobs.jsonl'), log = join(dir, `${job}.log`);
    await writeFile(file, queue); await writeFile(jobs, initial); await writeFile(log, 'worker failed');
    expect(await cmdJobsRetryEmpty(['--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toEqual([retry()]);
    expect(await readFile(file, 'utf8')).toBe(queue);
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(queue + retry() + '\n');
    expect(await readdir(join(dir, 'queue/empty-retry-receipts'))).toEqual([guardianReceipt(job, 'work')]);
    expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).lines).toEqual([]);
    expect(await readFile(jobs, 'utf8')).toBe(initial); expect(await readFile(log, 'utf8')).toBe('worker failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
