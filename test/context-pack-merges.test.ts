/**
 * fleet context-pack merges section: `phm fleet context-pack build` must show
 * the merge evidence the fleet actually records. dispatchd writes merge
 * verdicts to metrics/jobs.jsonl (reconciler terminal rows plus the
 * merged/outcome dialects) while dispatch-events.log carries no stamped
 * outcome lines in production, so an events-log-only scan rendered the
 * section empty over a ledger full of landed work. The fold reads the same
 * bounded jobs-ledger tail the finished count uses, through the shared
 * jobs-ledger dialect; a missing ledger degrades to stamped event lines and
 * sources.metrics already reports the ledger's health.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildContextPack } from '../src/core/fleet/context-pack.js';

let root: string;
const now = 1793577600000;
const options = (merges?: number) => ({ job: 'JOB-1', lane: 'claude', root: join(root, 'bus'), runsDir: root, home: root, now: () => now, merges });
const status = () => JSON.stringify({
  last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
  lanes: { claude: { running: 1, target: 2, queued: 0, held: false, held_reason: null } },
});
const EVENTS = '2026-11-01 00:00:00 LAUNCH JOB-LEDGER-1 phantom claude work\n' +
  '2026-11-01 00:05:00 FLEET_SHED level 0->1 (mem) mode=enforce\n';
const row = (value: object): string => JSON.stringify(value);
const LEDGER = [
  // Newest merge first in the section: J-NEW merged after J-OLD.
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-OLD', prUrl: 'https://github.com/ashlrai/phantom/pull/11', outcome: 'MERGED', mergedAt: '2026-11-01T00:30:00+00:00', ts: '2026-11-01T00:31:00+00:00', repo: 'ashlrai/phantom', lane: 'devin' }),
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-NEW', prUrl: 'https://github.com/ashlrai/phantom/pull/12', outcome: 'MERGED', mergedAt: '2026-11-01T02:30:00+00:00', ts: '2026-11-01T02:31:00+00:00', repo: 'ashlrai/phantom', lane: 'claude' }),
  // Closed is a verdict but never a merge; open claims and launches are not merges either.
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-CLOSED', prUrl: 'https://github.com/ashlrai/phantom/pull/13', outcome: 'CLOSED', closedAt: '2026-11-01T03:00:00+00:00', ts: '2026-11-01T03:01:00+00:00' }),
  row({ event: 'publish', jobId: 'J-OPEN', prUrl: 'https://github.com/ashlrai/phantom/pull/14', outcome: 'OPEN', ts: '2026-11-01T03:30:00+00:00' }),
  row({ event: 'launch', job: 'J-LIVE', repo: 'ashlrai/phantom', lane: 'devin', tier: 'work', ts: '2026-11-01T04:00:00+00:00' }),
  // The other ledger dialects that resolve MERGED.
  row({ event: 'outcome', state: 'MERGED', job: 'J-DIALECT', pr: 'https://github.com/ashlrai/phantom/pull/15', ts: '2026-11-01T05:00:00+00:00' }),
  row({ merged: true, jobId: 'J-FLAG', prUrl: 'https://github.com/ashlrai/phantom/pull/16', timestamp: '2026-11-01T06:00:00+00:00' }),
  // Unattributable (no job, no PR) and unstamped verdicts stay out.
  row({ merged: true, ts: '2026-11-01T07:00:00+00:00' }),
  row({ event: 'outcome', state: 'MERGED', job: 'J-NOSTAMP' }),
  'not json at all',
].join('\n') + '\n';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxpack-merges-'));
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue', 'status.json'), status());
  await writeFile(join(root, 'queue', 'dispatch-events.log'), EVENTS);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), LEDGER);
  expect(appendBusInbox({ id: 'seed', from: 'core', to: 'claude', priority: 'P2', ttl: 60000, body: { text: 'seed' } }, options()).status).toBe('posted');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  // The standing revert ledger lives under the shared relocated ASHLR_HOME;
  // drop it so one test's keys never leak into the next pack build.
  await rm(revertLedgerPath(), { force: true });
});

interface Pack { sections: { name: string; rows: Record<string, unknown>[] }[] }
const mergesSection = async (merges?: number): Promise<Record<string, unknown>[]> => {
  const pack = JSON.parse(await buildContextPack(options(merges))) as Pack;
  return pack.sections.find(section => section.name === 'merges')!.rows;
};

it('surfaces jobs-ledger MERGED verdicts newest-first with job, PR, repo, lane and stamp', async () => {
  const rows = await mergesSection();
  expect(rows.map(row => row['job'])).toEqual(['J-FLAG', 'J-DIALECT', 'J-NEW', 'J-OLD']);
  const newest = rows[2]!;
  expect(newest['pr']).toBe('https://github.com/ashlrai/phantom/pull/12');
  expect(newest['repo']).toBe('ashlrai/phantom');
  expect(newest['lane']).toBe('claude');
  expect(newest['at']).toBe('2026-11-01T02:30:00.000Z');
  expect(newest['source']).toBe(join(root, 'metrics', 'jobs.jsonl'));
});

it('keeps one row per job when the ledger repeats a merge verdict', async () => {
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), LEDGER + row({
    event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-NEW',
    prUrl: 'https://github.com/ashlrai/phantom/pull/12', outcome: 'MERGED',
    mergedAt: '2026-11-01T02:45:00+00:00', ts: '2026-11-01T02:46:00+00:00',
  }) + '\n');
  const rows = await mergesSection();
  expect(rows.filter(entry => entry['job'] === 'J-NEW')).toHaveLength(1);
  expect(rows.map(entry => entry['job'])).toEqual(['J-FLAG', 'J-DIALECT', 'J-NEW', 'J-OLD']);
});

it('honors the merges budget across the section', async () => {
  expect((await mergesSection(2)).map(row => row['job'])).toEqual(['J-FLAG', 'J-DIALECT']);
  expect(await mergesSection(0)).toEqual([]);
});

it('still surfaces stamped event-log merge lines and degrades honestly without the ledger', async () => {
  await writeFile(join(root, 'queue', 'dispatch-events.log'),
    '2026-11-01 23:50:00 LAUNCH JOB-D phantom claude opus code\n' +
    '2026-11-02 00:00:00 OUTCOME JOB-D merged usage=0.2\n');
  await rm(join(root, 'metrics', 'jobs.jsonl'));
  const rows = await mergesSection();
  expect(rows).toHaveLength(1);
  expect(rows[0]!['source']).toBe(join(root, 'queue', 'dispatch-events.log'));
  expect(String(rows[0]!['text'])).toContain('OUTCOME JOB-D merged');
});

const mergeRow = (job: string, pr: string, mergedAt: string, ts: string) => row({
  event: 'publish', source: 'metrics-outcomes-reconciler', jobId: job, prUrl: pr,
  outcome: 'MERGED', mergedAt, ts, repo: 'ashlrai/phantom', lane: 'claude',
});
const PR = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;

// The standing revert ledger the pack's merges fold reads: the same
// {v:1, at, record} lines `phm fleet reverts --record` appends under
// $ASHLR_HOME/improve (revertOutcomesLedgerPath). Written directly so this
// suite never imports the Tier-1 ledger module.
const revertLedgerPath = (): string => join(process.env.ASHLR_HOME!, 'improve', 'revert-outcomes.jsonl');
const revertLedgerLine = (n: number): string => JSON.stringify({
  v: 1, at: '2026-11-01T04:00:00.000Z',
  record: {
    repository: 'ashlrai/phantom', number: n, pr: `ashlrai/phantom#${n}`,
    mergeSha: 'a'.repeat(40), mergedAt: '2026-11-01T02:00:00.000Z',
    revertedBy: 'b'.repeat(40), revertedAt: '2026-11-01T03:00:00.000Z',
    revertLatencyMs: 3_600_000, relandedBy: null,
  },
});
const writeRevertLedger = async (ns: number[]): Promise<void> => {
  await mkdir(join(process.env.ASHLR_HOME!, 'improve'), { recursive: true });
  await writeFile(revertLedgerPath(), ns.map(revertLedgerLine).join('\n') + '\n');
};

it('marks a merge reverted by in-ledger revert evidence stamped after the verdict', async () => {
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
    mergeRow('J-REV', PR(21), '2026-11-01T02:00:00+00:00', '2026-11-01T02:01:00+00:00'),
    mergeRow('J-HELD', PR(22), '2026-11-01T02:30:00+00:00', '2026-11-01T02:31:00+00:00'),
    // Revert evidence newer than J-REV's verdict: the merge did not hold.
    row({ event: 'reverted', job: 'J-REV', ts: '2026-11-01T03:00:00+00:00' }),
    // An explicit reverted stamp is the same evidence.
    row({ job: 'J-HELD', reverted: true, ts: '2026-11-01T01:00:00+00:00' }),
  ].join('\n') + '\n');
  const rows = await mergesSection();
  const byJob = new Map(rows.map(entry => [entry['job'], entry]));
  expect(byJob.get('J-REV')?.['reverted']).toBe(true);
  // J-HELD's revert stamp predates its verdict: an earlier merge era, so the
  // merge stays a fresh held merge and carries no flag.
  expect(byJob.get('J-HELD')).not.toHaveProperty('reverted');
});

it('marks a merge reverted by a standing revert-outcomes key on its unambiguous PR claim', async () => {
  await writeRevertLedger([31, 32]);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
    // The verdict row's own PR URL is claimed by exactly J-STAND.
    mergeRow('J-STAND', PR(31), '2026-11-01T02:00:00+00:00', '2026-11-01T02:01:00+00:00'),
    // Two jobs claim the keyed PR(32): a contested claim never resolves.
    row({ event: 'launch', job: 'J-CONTEST', pr: PR(32), ts: '2026-11-01T01:00:00+00:00' }),
    row({ event: 'launch', job: 'J-OTHER', pr: PR(32), ts: '2026-11-01T01:05:00+00:00' }),
    mergeRow('J-CONTEST', PR(32), '2026-11-01T02:30:00+00:00', '2026-11-01T02:31:00+00:00'),
    // J-FOREIGN merged a different PR than the standing keys name.
    mergeRow('J-FOREIGN', PR(33), '2026-11-01T02:45:00+00:00', '2026-11-01T02:46:00+00:00'),
  ].join('\n') + '\n');
  const rows = await mergesSection();
  const byJob = new Map(rows.map(entry => [entry['job'], entry]));
  expect(byJob.get('J-STAND')?.['reverted']).toBe(true);
  expect(byJob.get('J-CONTEST')).not.toHaveProperty('reverted');
  expect(byJob.get('J-FOREIGN')).not.toHaveProperty('reverted');
});

it('never marks a PR-only verdict or reuses a batch-session claim', async () => {
  await writeRevertLedger([41]);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
    // No job id: nothing can claim the PR, so the verdict stays unmarked.
    row({ merged: true, prUrl: PR(41), timestamp: '2026-11-01T02:30:00+00:00' }),
    // A batch session id is infrastructure and never claims the keyed PR.
    row({ event: 'launch', job: 'RQ-BATCH-9', pr: PR(41), ts: '2026-11-01T01:00:00+00:00' }),
    mergeRow('J-BATCH', PR(42), '2026-11-01T02:40:00+00:00', '2026-11-01T02:41:00+00:00'),
  ].join('\n') + '\n');
  const rows = await mergesSection();
  const byJob = new Map(rows.map(entry => [entry['job'] ?? entry['pr'], entry]));
  expect(byJob.get(PR(41))).not.toHaveProperty('reverted');
  expect(byJob.get('J-BATCH')).not.toHaveProperty('reverted');
});
