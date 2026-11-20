import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNightlyInputs, foldFleetJobs } from '../src/core/learn/retro/feed.js';
import { runNightlyRetro } from '../src/core/learn/retro/nightly.js';
import { learnHome, readNightlyState } from '../src/core/learn/retro/store.js';
import type { NightlyJob } from '../src/core/learn/retro/nightly-types.js';

const NOW = Date.parse('2026-10-26T02:00:00.000Z');
const ENABLED = { foundry: { selfImprove: true } };
let home: string;
let runsDir: string;

function inputPath(name = 'jobs.jsonl'): string {
  return join(learnHome(), 'retro-input', name);
}

function ledgerPath(): string {
  return join(runsDir, 'metrics', 'jobs.jsonl');
}

async function writeLedger(rows: readonly Record<string, unknown>[]): Promise<void> {
  await mkdir(join(runsDir, 'metrics'), { recursive: true, mode: 0o700 });
  await writeFile(ledgerPath(), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
}

/** A minimal valid terminal fleet row; overrides win. */
function fleetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'outcome', job: 'RQ-TEST-1', repo: 'ashlrai/phantom', lane: 'work',
    state: 'MERGED', ts: '2026-10-25T23:00:00.000Z', ...overrides,
  };
}

async function readJobsInput(): Promise<NightlyJob[]> {
  const raw = await readFile(inputPath(), 'utf8');
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as NightlyJob);
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'phantom-nightly-feed-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  runsDir = join(home, 'runs');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('foldFleetJobs', () => {
  it('emits only terminal jobs with proven repo and arm, latest observation wins', () => {
    const rows = [
      fleetRow({ event: 'enqueue', state: undefined, ts: '2026-10-25T20:00:00.000Z' }),
      fleetRow({ event: 'launch', state: undefined, lane: 'work', ts: '2026-10-25T21:00:00.000Z' }),
      fleetRow({ state: 'MERGED', ts: '2026-10-25T22:00:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-2', state: 'FAILED', failed: true, ts: '2026-10-25T22:30:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-3', state: 'CANCELLED', ts: '2026-10-25T22:40:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-4', state: 'DONE-NOOP', ts: '2026-10-25T22:50:00.000Z' }),
      fleetRow({ job: 'RQ-TEST-5', state: 'RUNNING', ts: '2026-10-25T23:10:00.000Z' }),
    ];
    const jobs = foldFleetJobs(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', NOW);
    expect(jobs).toEqual([
      { v: 1, id: 'RQ-TEST-1', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T22:00:00.000Z' },
      { v: 1, id: 'RQ-TEST-2', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'failed', updatedAt: '2026-10-25T22:30:00.000Z' },
      { v: 1, id: 'RQ-TEST-3', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'cancelled', updatedAt: '2026-10-25T22:40:00.000Z' },
    ]);
  });

  it('counts a later revert as failure and skips rows without provable attribution', () => {
    const rows = [
      fleetRow({ state: 'MERGED', ts: '2026-10-25T22:00:00.000Z' }),
      fleetRow({ state: 'REVERTED', reverted: true, ts: '2026-10-25T23:30:00.000Z' }),
      fleetRow({ job: 'RQ-NO-REPO', repo: 'phantom', lane: 'work' }),
      fleetRow({ job: 'RQ-NO-ARM', lane: undefined, model: undefined, arm: undefined }),
      fleetRow({ job: 'RQ-FUTURE', ts: '2026-10-27T00:00:00.000Z' }),
      fleetRow({ job: 'bad id!', state: 'MERGED' }),
    ];
    const jobs = foldFleetJobs(rows.map((row) => JSON.stringify(row)).join('\n'), NOW);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'RQ-TEST-1', status: 'failed', updatedAt: '2026-10-25T23:30:00.000Z' });
  });

  it('derives repo from a GitHub PR URL and arm from model when no lane exists', () => {
    const jobs = foldFleetJobs(JSON.stringify(fleetRow({
      repo: undefined, lane: undefined, model: 'swe-2',
      url: 'https://github.com/ashlrai/phantom/pull/1234',
    })) + '\n', NOW);
    expect(jobs).toEqual([
      { v: 1, id: 'RQ-TEST-1', repo: 'ashlrai/phantom', arm: 'model:swe-2', playbook: null, status: 'succeeded', updatedAt: '2026-10-25T23:00:00.000Z' },
    ]);
  });
});

describe('ensureNightlyInputs', () => {
  it('writes contract jobs.jsonl from the fleet ledger and completes the nightly run', async () => {
    await writeLedger([
      fleetRow(),
      fleetRow({ job: 'RQ-TEST-2', state: 'FAILED', failed: true, ts: '2026-10-25T23:30:00.000Z' }),
    ]);
    // An empty review file is contract-valid; the review channel stays external.
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    await writeFile(inputPath('review-blocks.jsonl'), '', { mode: 0o600 });

    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    const jobs = await readJobsInput();
    expect(jobs.map((job) => [job.id, job.status])).toEqual([['RQ-TEST-1', 'succeeded'], ['RQ-TEST-2', 'failed']]);

    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('completed');
    const state = (await readNightlyState())!;
    expect(state.completedNight).toBe('2026-10-26');
    expect(state.jobs).toHaveLength(2);
    expect(state.priors).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: 'ashlrai/phantom', arm: 'work', successes: 1, failures: 1 }),
    ]));
  });

  it('does not write jobs.jsonl when the fleet ledger is missing', async () => {
    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    await expect(readFile(inputPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps externally supplied rows and lets the newer observation win', async () => {
    const external: NightlyJob = {
      v: 1, id: 'EXTERNAL-1', repo: 'ashlrai/phantom', arm: 'external-arm',
      playbook: null, status: 'succeeded', updatedAt: '2026-10-25T10:00:00.000Z',
    };
    const staleFleet = { v: 1, id: 'EXTERNAL-1', repo: 'ashlrai/phantom', arm: 'work', playbook: null, status: 'failed' as const, updatedAt: '2026-10-25T09:00:00.000Z' };
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    await writeFile(inputPath(), `${JSON.stringify(external)}\n${JSON.stringify(staleFleet)}\n`, { mode: 0o600 });
    await writeLedger([fleetRow({ job: 'EXTERNAL-1', state: 'FAILED', failed: true, ts: '2026-10-25T12:00:00.000Z' })]);

    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    const jobs = await readJobsInput();
    const byId = new Map(jobs.map((job) => [job.id, job]));
    expect(byId.get('EXTERNAL-1')).toMatchObject({ status: 'failed', updatedAt: '2026-10-25T12:00:00.000Z', arm: 'work' });
  });

  it('leaves a corrupt jobs.jsonl untouched so the run still fails closed', async () => {
    await mkdir(join(learnHome(), 'retro-input'), { recursive: true, mode: 0o700 });
    const corrupt = '{"v":1,"id":"BROKEN"\n';
    await writeFile(inputPath(), corrupt, { mode: 0o600 });
    await writeLedger([fleetRow()]);

    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    expect(await readFile(inputPath(), 'utf8')).toBe(corrupt);
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('unavailable');
  });

  it('does not complete the night while review-blocks.jsonl is missing', async () => {
    await writeLedger([fleetRow()]);
    await ensureNightlyInputs({ runsDir, nowMs: NOW });
    expect(await readJobsInput()).toHaveLength(1);
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('unavailable');
    expect(await readNightlyState()).toBeNull();
  });
});
