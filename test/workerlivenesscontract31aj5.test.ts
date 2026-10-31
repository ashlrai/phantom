/**
 * Worker liveness contract (RQ-PHX-WORKERLIVENESSCONTRACT31AJ5).
 *
 * Day-one agent workflow: a worker artifact on disk under ~/.ashlr-runs
 * (<job>.prompt / <job>.notes.md) is NOT evidence of life. `phm fleet workers`
 * may only report a job as a live worker when a matching `bin/launch.sh`
 * process is present in the host process table; leader passes
 * (`bin/orch-pass.sh`) stay in their own count, and stray agent children
 * (`codex exec`) never resurrect an artifact into a worker row.
 *
 * Only two boundaries are mocked: the process-table read (`runPs` inside the
 * real listLiveWorkers, via the module wrapper below — nothing is spawned)
 * and the host directory location (HOME -> per-test tmp dir, so homedir()
 * resolves ~/.ashlr-runs under it). Canonical parsing/projection
 * (parsePsTable/listLiveWorkers), artifact reads (getFleetJobText) and the
 * public CLI path (cmdFleet -> cmdFleetWorkers) run for real. Every value is
 * fake; the tmp home and env are restored after each case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdFleet } from '../src/cli/fleet.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

const FIXED_NOW_ISO = '2026-10-31T23:45:00.000Z';

const fake = vi.hoisted(() => ({ table: '', reads: 0 }));
vi.mock('../src/core/fleet/runs-live-workers.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/runs-live-workers.js')>();
  return {
    ...actual,
    listLiveWorkers: () => actual.listLiveWorkers({
      now: () => Date.parse('2026-10-31T23:45:00.000Z'),
      runPs: async () => {
        fake.reads++;
        return fake.table;
      },
    }),
  };
});

const GHOST = 'RQ-FAKE-GHOST';
const LIVE = 'RQ-FAKE-LIVE';

describe('worker liveness contract: artifacts are not live workers', () => {
  let tmpHome: string;
  let runsDir: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let output: string[];
  let errors: string[];

  beforeEach(() => {
    fake.table = '';
    fake.reads = 0;
    tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'worker-liveness-')));
    runsDir = join(tmpHome, '.ashlr-runs');
    mkdirSync(runsDir, { recursive: true });
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    output = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /** The artifacts a dispatched worker leaves behind in the host runs dir. */
  function seedWorkerArtifact(job: string): void {
    writeFileSync(join(runsDir, `${job}.prompt`), `FAKE_PRIVATE_PROMPT_${job}\n`, 'utf8');
    writeFileSync(join(runsDir, `${job}.notes.md`), `# notes\nFAKE_PRIVATE_NOTE_${job}\n`, 'utf8');
  }

  const row = (pid: number, etime: string, command: string) => `${pid} ${etime} ${command}`;
  /** A live worker wrapper, launched out of the mocked host dir. */
  const launch = (pid: number, etime: string, job: string) =>
    row(pid, etime, `/bin/bash ${runsDir}/bin/launch.sh ${job} phantom main work`);
  const leader = () =>
    row(700, '00:08', `/bin/bash ${runsDir}/bin/orch-pass.sh --repo /fake/projects/phantom nightly`);

  it('reports only the artifact whose job has a live launch process; the leader stays a leader', async () => {
    seedWorkerArtifact(GHOST);
    seedWorkerArtifact(LIVE);
    fake.table = [
      launch(410, '02:00', LIVE),
      // Agent child carrying the live job id is attributed to it, not counted.
      row(411, '01:58', `codex exec --cd /fake/wt/${LIVE} --json FAKE_PRIVATE_CHILD_ARG`),
      leader(),
      row(705, '00:30', 'codex exec --sandbox read-only'),
    ].join('\n');

    expect(await cmdFleet(['workers', '--json'])).toBe(0);
    expect(fake.reads).toBe(1);
    expect(errors).toEqual([]);
    const result = JSON.parse(output.join(''));
    expect(result).toEqual({
      v: 1,
      generatedAt: FIXED_NOW_ISO,
      sourceState: 'healthy',
      workers: [{ pid: 410, job: LIVE, repo: 'phantom', lane: 'main', tier: 'work', ageSeconds: 120 }],
      leaders: [{ pid: 700, label: '--repo nightly', ageSeconds: 8 }],
      orchestratorAgents: 1,
    });
    // The wire projection carries typed fields only — no artifact names,
    // prompt text, host paths or process commands.
    expect(output.join('')).not.toMatch(new RegExp(`${GHOST}|FAKE_PRIVATE|launch\\.sh|codex exec`));
    expect(output.join('')).not.toContain(runsDir);

    // Persistent state: both artifacts remain on disk and readable; the CLI
    // is read-only and consumed nothing.
    for (const job of [GHOST, LIVE]) {
      expect(readFileSync(join(runsDir, `${job}.prompt`), 'utf8')).toBe(`FAKE_PRIVATE_PROMPT_${job}\n`);
      expect(readFileSync(join(runsDir, `${job}.notes.md`), 'utf8')).toContain(`FAKE_PRIVATE_NOTE_${job}`);
      expect(await getFleetJobText(job, 'notes')).toMatchObject({ job, state: 'ok', source: 'notes' });
    }
  });

  it('prints the live worker row and separate global totals in human output', async () => {
    seedWorkerArtifact(GHOST);
    seedWorkerArtifact(LIVE);
    fake.table = [launch(410, '02:00', LIVE), leader()].join('\n');

    expect(await cmdFleet(['workers'])).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('Fleet workers: healthy');
    expect(text).toContain(`${LIVE}  main  phantom  work  120s`);
    expect(text).toContain('Leaders (global): 1; orchestrator agents (global): 0');
    expect(text).not.toMatch(new RegExp(`${GHOST}|FAKE_PRIVATE|launch\\.sh`));
    expect(text).not.toContain(runsDir);
    expect(errors).toEqual([]);
  });

  it('reports zero workers on an artifact-only host even when an agent carries the artifact job id', async () => {
    seedWorkerArtifact(GHOST);
    fake.table = [
      leader(),
      // Orphan agent carrying the ghost's id: no launch.sh row means no
      // worker, and the agent counts only under orchestratorAgents.
      row(705, '00:30', `codex exec --cd /fake/wt/${GHOST}`),
    ].join('\n');

    expect(await cmdFleet(['workers', '--json'])).toBe(0);
    const result = JSON.parse(output.join(''));
    expect(result.workers).toEqual([]);
    expect(result.leaders).toEqual([{ pid: 700, label: '--repo nightly', ageSeconds: 8 }]);
    expect(result.orchestratorAgents).toBe(1);

    output.length = 0;
    expect(await cmdFleet(['workers'])).toBe(0);
    expect(output.join('\n')).toContain('No live workers.');
    expect(output.join('\n')).toContain('Leaders (global): 1; orchestrator agents (global): 1');
    expect(output.join('\n')).not.toContain(GHOST);

    // The artifact was real the whole time — still on disk, still readable.
    expect(await getFleetJobText(GHOST, 'notes')).toMatchObject({ job: GHOST, state: 'ok' });
  });
});
