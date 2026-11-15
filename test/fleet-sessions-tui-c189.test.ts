/**
 * Recut RQ-PHX-RECUTCOREOLDC189 (source: PR #3919, RQ-SWE-TUI-SESSIONS-1).
 *
 * End-to-end coverage for the carried TUI Sessions tab — run through the
 * REAL modules on disk, not mocks:
 *
 *   queue/ready.tsv + queue/status.json + queue/run/<job>.{line,dispatched,
 *   rc,fin} fixtures  →  getFleetSessions() (fleet.sessions.v1)
 *   →  DashboardSnapshot.sessions  →  renderFrame() sessions tab.
 *
 * Asserts the tab renders the projected rows honestly (job, repo, lane,
 * status, elapsed), that a missing/degraded runs dir degrades to explicit
 * text instead of looking broken, and that the frame stays value-blind —
 * prompt paths and marker contents never appear in the rendered output.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getFleetSessions, type FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import type { DashboardSnapshot } from '../src/core/types.js';
import { renderFrame } from '../src/tui/render.js';
import { stripAnsi } from '../src/cli/ui.js';

const ANCHOR = Date.parse('2026-11-05T12:00:00Z');
const S = 1000;
const opts = { now: () => ANCHOR } as const;
const noPs = async (): Promise<string> => '';

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sessions-tui-c189-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers — every path is inside the per-test scratch dir.
// ---------------------------------------------------------------------------

async function write(root: string, rel: string, content: string): Promise<string> {
  const path = join(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function touch(path: string, ms: number): Promise<void> {
  const d = new Date(ms);
  await utimes(path, d, d);
}

const epoch = (ms: number): string => String(Math.floor(ms / 1000));
const line = (job: string, repo = 'phantom', lane = 'devin', tier = 'work'): string =>
  `${job}\t${repo}\t${lane}\t${tier}\t/prompt/dir/${job}.md`;

/** A runs dir with one running, one queued and one finished session. */
async function fixtureRunsDir(): Promise<string> {
  const dir = join(scratch, 'runs');
  await write(dir, 'queue/status.json', JSON.stringify({
    schema: 'dispatchd.status.v1',
    last_tick: new Date(ANCHOR - 12 * S).toISOString(),
    paused: false,
  }));
  await write(dir, 'queue/ready.tsv', `RQ-QUEUED-9\tphantom\tclaude\twork\t/prompt/dir/RQ-QUEUED-9.md\n`);
  // Running: claimed 12m ago, fresh agent artifact on disk.
  await touch(await write(dir, 'queue/run/RQ-RUN-7.line', line('RQ-RUN-7')), ANCHOR - 720 * S);
  await write(dir, 'queue/run/RQ-RUN-7.dispatched', epoch(ANCHOR - 720 * S));
  await touch(await write(dir, 'RQ-RUN-7.log', 'agent output\n'), ANCHOR - 30 * S);
  // Finished: exit code + a .fin marker (no .base → the marker is the evidence).
  await touch(await write(dir, 'queue/run/RQ-FIN-3.line', line('RQ-FIN-3', 'phantom', 'claude')), ANCHOR - 3600 * S);
  await write(dir, 'queue/run/RQ-FIN-3.dispatched', epoch(ANCHOR - 3600 * S));
  await write(dir, 'queue/run/RQ-FIN-3.rc', '0');
  await touch(await write(dir, 'queue/run/RQ-FIN-3.fin', 'x'), ANCHOR - 600 * S);
  return dir;
}

function snapWithSessions(sessions?: FleetSessionsV1): DashboardSnapshot {
  return {
    generatedAt: new Date(ANCHOR).toISOString(),
    repos: { total: 1, dirty: 0, stale: 0 },
    tools: { installed: 1, total: 1 },
    activity: { sessions: 0, tokens: 0, estCostUsd: 0, commits: 0 },
    runs: [],
    swarms: [],
    mcp: [],
    genome: { entries: 0, projects: 0 },
    ...(sessions !== undefined ? { sessions } : {}),
  };
}

const STATE = { tab: 'sessions' as const, selected: 0, cols: 120, rows: 30, nowMs: ANCHOR };

// ---------------------------------------------------------------------------
// getFleetSessions → renderFrame — the carried tab end to end.
// ---------------------------------------------------------------------------

describe('sessions tab — real projection through renderFrame', () => {
  it('renders running, queued and finished sessions with their status and elapsed', async () => {
    const view = await getFleetSessions({ ...opts, runsDir: await fixtureRunsDir(), runPs: noPs });
    expect(view.schema).toBe('fleet.sessions.v1');
    expect(view.sessions.map(s => s.job).sort()).toEqual(['RQ-QUEUED-9', 'RQ-RUN-7']);
    expect(view.recent.map(s => s.job)).toEqual(['RQ-FIN-3']);

    const frame = stripAnsi(renderFrame(snapWithSessions(view), STATE));
    expect(frame).toContain('Sessions — dispatcher');
    expect(frame).toContain('8:Sessions');
    expect(frame).toContain('RQ-RUN-7');
    expect(frame).toContain('RQ-QUEUED-9');
    expect(frame).toContain('RQ-FIN-3');
    expect(frame).toContain('running');
    expect(frame).toContain('queued');
    expect(frame).toContain('finished');
    expect(frame).toContain('12m'); // RQ-RUN-7 elapsed since claim
    expect(frame).toContain('tick 12s ago');
    expect(frame).toContain('devin');
    expect(frame).toContain('claude');
  });

  it('never renders prompt paths or marker contents (value-blind frame)', async () => {
    const view = await getFleetSessions({ ...opts, runsDir: await fixtureRunsDir(), runPs: noPs });
    const frame = renderFrame(snapWithSessions(view), STATE);
    expect(stripAnsi(frame)).not.toContain('/prompt/');
    expect(stripAnsi(frame)).not.toContain('dir/RQ-QUEUED-9.md');
    expect(stripAnsi(frame)).not.toContain('agent output');
  });

  it('says "no dispatcher session state" when the runs dir is absent', async () => {
    const missing = join(scratch, 'no-such-runs-dir');
    const view = await getFleetSessions({ ...opts, runsDir: missing, runPs: noPs });
    expect(view.sourceState).toBe('missing');
    const frame = stripAnsi(renderFrame(snapWithSessions(view), STATE));
    expect(frame).toContain('No dispatcher session state found.');
    expect(frame).toContain('runs dir absent');
  });

});
