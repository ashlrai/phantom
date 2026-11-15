/**
 * recut-coreold-c218.test.ts — regression coverage for the PR #1685 recut
 * (RQ-PHDESKQ8): `GET /api/wb/v1/fleet`, the composite live fleet workbench
 * read, and the `isLiveQueueStatus` export it required on lane-console.
 *
 * Hermetic: a tmp ASHLR_HOME + injected queueDir/paths/now seams — no real
 * home, no gh subprocess (an empty enrolled list short-circuits the reader).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { isLiveQueueStatus } from '../src/core/fleet/lane-console.js';
import {
  buildWorkbenchFleetView,
  WB_FLEET_PATH,
} from '../src/core/web/workbench-fleet-view.js';
import { isWbApiPath } from '../src/core/web/wb-read-api.js';

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevAshlrHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recut-c218-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('route registration', () => {
  it('/api/wb/v1/fleet is a recognized wb read path', () => {
    expect(WB_FLEET_PATH).toBe('/api/wb/v1/fleet');
    expect(isWbApiPath(WB_FLEET_PATH)).toBe(true);
  });
});

describe('isLiveQueueStatus', () => {
  it('normalizes case and keeps READY queued-not-live', () => {
    expect(isLiveQueueStatus('claimed')).toBe(true);
    expect(isLiveQueueStatus('PR-OPEN')).toBe(true);
    expect(isLiveQueueStatus('ready')).toBe(false);
    expect(isLiveQueueStatus('DONE')).toBe(false);
    expect(isLiveQueueStatus('bogus')).toBe(false);
  });
});

describe('buildWorkbenchFleetView', () => {
  it('answers a workbench.fleet.v1 composite with per-section honesty', async () => {
    const queueDir = join(home, 'queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      join(queueDir, 'queue.v1.json'),
      JSON.stringify({
        schema: 'queue.v1',
        jobs: [
          { id: 'RQ-1', status: 'CLAIMED', pool: 'devin', tier: 'work', task: 'recut task' },
          { id: 'RQ-2', status: 'READY', pool: 'devin', tier: 'work' },
        ],
      }),
    );
    writeFileSync(join(queueDir, 'ready.tsv'), 'RQ-9\tREADY\tdevin\twork\tphantom\tP2\ttsv only\n');

    const view = await buildWorkbenchFleetView(makeConfig(), {
      queueDir,
      paths: () => [],
      now: () => Date.parse('2026-11-12T00:00:00Z'),
    });

    expect(view.schema).toBe('workbench.fleet.v1');
    expect(view.v).toBe(1);
    expect(['ok', 'degraded']).toContain(view.state);

    expect(view.jobs.state).toBe('ok');
    expect(view.jobs.counts).toEqual({ live: 1, ready: 2, total: 3 });
    const rq1 = view.jobs.jobs.find((j) => j.id === 'RQ-1');
    expect(rq1).toMatchObject({ status: 'CLAIMED', live: true, source: 'queue.v1', summary: 'recut task' });
    const rq9 = view.jobs.jobs.find((j) => j.id === 'RQ-9');
    expect(rq9).toMatchObject({ status: 'READY', live: false, source: 'ready.tsv' });

    // Empty enrolled list yields an honest, empty PR section — never a throw.
    expect(view.prs.state).toBe('ok');
    expect(view.prs.open).toEqual([]);
    // No leader store seeded → the section says why instead of fabricating.
    expect(view.leader.state).toBe('unknown');
    expect(view.leader.reason).toBe('missing');
  });

  it('reports missing queue files as unknown with reason missing', async () => {
    const view = await buildWorkbenchFleetView(makeConfig(), {
      queueDir: join(home, 'no-such-queue'),
      paths: () => [],
      now: () => Date.now(),
    });
    expect(view.jobs.state).toBe('unknown');
    expect(view.jobs.reason).toBe('missing');
    expect(view.jobs.jobs).toEqual([]);
  });
});
