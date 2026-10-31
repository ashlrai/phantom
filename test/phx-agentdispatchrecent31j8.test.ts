import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runDispatchRecent } from '../examples/agents/dispatch-recent.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const dirs: string[] = [];
const now = () => Date.parse('2026-10-31T00:30:00Z');
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function temporaryDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-recent-'));
  dirs.push(dir);
  return dir;
}
function harness(runsDir: string) {
  let stdout = '';
  let stderr = '';
  let reads = 0;
  const deps = {
    read: () => { reads++; return readFleetRunsDirState({ runsDir, now }); },
    stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += text; },
  };
  return { deps, output: () => ({ stdout, stderr, reads }) };
}

describe('dispatch-recent example', () => {
  it('reports mixed recent events and source health without inferring merges', async () => {
    const dir = await temporaryDir();
    await mkdir(join(dir, 'queue'));
    await writeFile(join(dir, 'queue/status.json'), JSON.stringify({
      last_tick: '2026-10-31T00:29:00Z', paused: false, mem_free_pct: 50, lanes: {},
    }));
    await writeFile(join(dir, 'dispatch-events.log'), [
      '2026-10-31 00:01:00 LAUNCH fake-job',
      '2026-10-31 00:02:00 PUBLISH_START fake-job',
      '2026-10-31 00:03:00 PUBLISHED fake-job',
      '2026-10-31 00:04:00 PUBLISH_ABORT fake-job',
      '2026-10-31 00:05:00 INCIDENT prompt=private words',
      '2026-10-31 00:06:00 LANE_HOLD fake-lane',
      '2026-10-31 00:07:00 INBOX unrelated',
      'bad row',
    ].join('\n'));
    const h = harness(dir);
    expect(await runDispatchRecent([], h.deps)).toBe(0);
    const { stdout, stderr } = h.output();
    const result = JSON.parse(stdout);
    expect(stderr).toBe('');
    expect(result).toMatchObject({
      generatedAt: '2026-10-31T00:30:00.000Z', runsDirPresent: true,
      sourceState: 'degraded', lastTick: '2026-10-31T00:29:00Z',
      sources: { status: 'healthy', events: 'degraded', metrics: 'missing' },
    });
    expect(result.events.map((event: { kind: string }) => event.kind)).toEqual([
      'LANE_HOLD', 'INCIDENT', 'PUBLISH_ABORT', 'PUBLISHED', 'PUBLISH_START', 'LAUNCH',
    ]);
    expect(result.events[1].text).not.toContain('private words');
    expect(stdout.toLowerCase()).not.toContain('merge');

    for (const kind of ['LAUNCH', 'PUBLISHED', 'PUBLISH_START', 'PUBLISH_ABORT', 'INCIDENT', 'LANE_HOLD']) {
      const filtered = harness(dir);
      expect(await runDispatchRecent(['--kind', kind], filtered.deps)).toBe(0);
      expect(JSON.parse(filtered.output().stdout).events.map((event: { kind: string }) => event.kind)).toEqual([kind]);
    }
  });

  it('reports an absent directory and unknown tick without inventing freshness', async () => {
    const h = harness(join(await temporaryDir(), 'absent'));
    expect(await runDispatchRecent([], h.deps)).toBe(0);
    expect(JSON.parse(h.output().stdout)).toMatchObject({
      runsDirPresent: false, sourceState: 'missing', lastTick: null, events: [],
      sources: { status: 'missing', events: 'missing' },
    });
  });

  it('rejects invalid or repeated arguments before reading, and supports help', async () => {
    for (const args of [['--kind'], ['--kind', 'MERGED'], ['--kind', 'LAUNCH', '--kind', 'INCIDENT'], ['--wat'], ['--help', '--help']]) {
      const h = harness('unused');
      expect(await runDispatchRecent(args, h.deps)).toBe(2);
      expect(h.output()).toMatchObject({ stdout: '', reads: 0 });
      expect(h.output().stderr).toContain('Usage:');
    }
    const h = harness('unused');
    expect(await runDispatchRecent(['--help'], h.deps)).toBe(0);
    expect(h.output()).toMatchObject({ stderr: '', reads: 0 });
    expect(h.output().stdout).toContain('--kind');
  });

  it('does not expose unexpected reader errors', async () => {
    const h = harness('unused');
    expect(await runDispatchRecent([], { ...h.deps, read: async () => { throw new Error('private failure'); } })).toBe(1);
    expect(h.output().stdout).toBe('');
    expect(h.output().stderr).toBe('error: dispatch evidence unavailable\n');
  });

  it('runs directly with an isolated home', async () => {
    const home = await temporaryDir();
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'), 'examples/agents/dispatch-recent.ts',
    ], { env: { HOME: home, PATH: process.env.PATH ?? '' } });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ runsDirPresent: false, lastTick: null, events: [] });
  });
});
