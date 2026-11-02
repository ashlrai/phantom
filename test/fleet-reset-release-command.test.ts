/**
 * RQ-PHX-RESETRELEASEVERB01 — `ashlr fleet reset-release` runs the guarded
 * reset-release primitive headlessly. A dry-run plans without writing;
 * --apply releases autobackoff holds through the real runResetReleaseOnce +
 * releaseLaneHold path. Manual holds, degraded evidence and bad arguments
 * never change anything. Source reads are injected only where the test needs
 * forged provider evidence; the release writer is always real.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetRelease } from '../src/cli/fleet-reset-release.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { readResetReleases } from '../src/core/fleet/usage-reset-release.js';
import type { UsageResetRow, UsageResetsV1 } from '../src/core/fleet/usage-reset-detect.js';

const NOW_MS = Date.parse('2026-10-31T19:28:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const READING = '2026-10-31T19:10:00Z'; // ledger as-of, newer than every hold it must release
const HELD_UNTIL = '2026-11-04T00:00:00Z'; // autobackoff's guess, far in the future
const EXPIRED_UNTIL = '2026-10-31T19:05:00Z'; // already past at NOW
const HELD_SINCE = '2026-10-31T19:00:00Z';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'reset-release-cmd-'));
  await mkdir(join(runsDir, 'queue'));
  await writeFile(join(runsDir, 'queue/slots.json'), JSON.stringify({
    'lane-a': { target: 2, floor: 0, ceiling: 4, held: true,
      held_reason: `autobackoff fake job=j-1 until=${HELD_UNTIL} src=fake`,
      held_until: HELD_UNTIL, held_by: 'autobackoff', last_change: Date.parse(HELD_SINCE) / 1000 },
    'lane-b': { target: 1, floor: 0, ceiling: 2, held: true,
      held_reason: 'manual: operator', held_by: 'Mason t1221u', last_change: Date.parse(HELD_SINCE) / 1000 },
    'lane-c': { target: 1, floor: 0, ceiling: 2, held: true,
      held_reason: `autobackoff fake job=j-2 until=${EXPIRED_UNTIL} src=fake`,
      held_until: EXPIRED_UNTIL, held_by: 'autobackoff', last_change: Date.parse(HELD_SINCE) / 1000 },
    'lane-d': { target: 1, floor: 0, ceiling: 2, held: true,
      held_reason: `autobackoff fake job=j-3 until=${HELD_UNTIL} src=fake`,
      held_until: HELD_UNTIL, held_by: 'autobackoff', last_change: Date.parse('2026-10-31T19:20:00Z') / 1000 },
  }));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify({
    last_tick: READING,
    lanes: { 'lane-a': { held: true }, 'lane-b': { held: true }, 'lane-c': { held: true }, 'lane-d': { held: true } },
    budget: { 'lane-a': { weekly_used_pct: 3 }, 'lane-b': { weekly_used_pct: 0 }, 'lane-c': { weekly_used_pct: 0 }, 'lane-d': { weekly_used_pct: 3 } },
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});

const run = async (args: string[], read?: (opts: { runsDir?: string; now?: () => number }) => Promise<UsageResetsV1>) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetResetRelease(args, {
    now: () => NOW_MS, read,
    output: text => out.push(text), error: text => err.push(text),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n'),
    json: out[0]?.startsWith('{') ? JSON.parse(out[0]!) as { planned?: { lane: string }[]; released?: { lane: string }[]; errors?: { lane: string; message: string }[]; sourceState?: string; mode?: string; at?: string; checked?: number; v?: number } : null };
};

const resets = (rows: UsageResetRow[]): UsageResetsV1 => ({ v: 1, generatedAt: NOW_ISO, sourceState: 'healthy', rows });
const row = (lane: string): UsageResetRow => ({
  lane, held: true, heldReason: 'autobackoff fake', heldUntil: HELD_UNTIL, holdSince: HELD_SINCE,
  heldBy: 'autobackoff', usedPct: 3, readingAsOf: READING, resetAt: null,
  state: 'reset-detected', releasable: true, tell: '',
});
const lane = async (id: string) => (await readLaneTargets({ runsDir })).lanes.find(l => l.lane === id);

it('resolves through the fleet convention and owns its --help', async () => {
  expect(resolveFleetSubcommand('reset-release'))
    .toEqual({ module: './fleet-reset-release.js', exportName: 'cmdFleetResetRelease' });
  const loaded = await import('../src/cli/fleet-reset-release.js');
  expect(typeof loaded.cmdFleetResetRelease).toBe('function');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleet(['reset-release', '--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet reset-release'));
  const read = vi.fn();
  const help = await run(['--help'], read);
  expect(help.code).toBe(0);
  expect(read).not.toHaveBeenCalled();
});

it('rejects bad, duplicated, missing-value and relative arguments before touching evidence', async () => {
  const read = vi.fn();
  for (const args of [
    ['--bogus'], ['positional'], ['--json', '--json'], ['--apply', '--apply'],
    ['--runs-dir'], ['--runs-dir', '--json'], ['--runs-dir', 'relative/dir'],
    ['--runs-dir', runsDir, '--runs-dir', runsDir], ['--json=1'], ['--apply=x'],
  ]) expect((await run(args, read)).code).toBe(2);
  expect(read).not.toHaveBeenCalled();
  expect(existsSync(join(runsDir, 'queue/reset-releases.jsonl'))).toBe(false);
  expect(await lane('lane-a')).toMatchObject({ held: true });
});

it('dry-run lists the releasable autobackoff holds and writes nothing', async () => {
  const { code, json } = await run(['--json', '--runs-dir', runsDir]);
  expect(code).toBe(0);
  expect(json).toMatchObject({ v: 1, mode: 'dry-run', at: NOW_ISO, sourceState: 'healthy', checked: 4, released: [], errors: [] });
  expect(json!.planned!.map(r => r.lane)).toEqual(['lane-a', 'lane-c']);
  expect(await lane('lane-a')).toMatchObject({ held: true });
  expect(await lane('lane-b')).toMatchObject({ held: true });
  expect(existsSync(join(runsDir, 'queue/reset-releases.jsonl'))).toBe(false);
  expect(existsSync(join(runsDir, 'dispatch-events.log'))).toBe(false);
  const human = await run(['--runs-dir', runsDir]);
  expect(human.code).toBe(0);
  expect(human.stdout).toContain('DRY-RUN — no changes made');
});

it('--apply releases proven resets through the real guarded path, then idles', async () => {
  const { code, json } = await run(['--apply', '--json', '--runs-dir', runsDir]);
  expect(code).toBe(0);
  expect(json).toMatchObject({ v: 1, mode: 'apply', at: NOW_ISO, sourceState: 'healthy', checked: 4, errors: [] });
  expect(json!.released!.map(r => r.lane)).toEqual(['lane-a', 'lane-c']);
  expect(await lane('lane-a')).toMatchObject({ held: false, changedBy: expect.stringContaining('reset-detect') });
  expect(await lane('lane-c')).toMatchObject({ held: false });
  expect(await lane('lane-b')).toMatchObject({ held: true, heldReason: 'manual: operator' });
  expect(await lane('lane-d')).toMatchObject({ held: true });
  expect((await readResetReleases(runsDir)).map(r => r.lane).sort()).toEqual(['lane-a', 'lane-c']);
  expect(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8'))
    .toContain('LANE_HOLD released lane-a by reset-detect');
  const again = await run(['--apply', '--json', '--runs-dir', runsDir]);
  expect(again.code).toBe(0);
  expect(again.json).toMatchObject({ mode: 'apply', released: [], errors: [] });
});

it('keeps a manual hold held when injected evidence claims it releasable', async () => {
  const { code, json } = await run(['--apply', '--json', '--runs-dir', runsDir], async () => resets([row('lane-b')]));
  expect(code).toBe(1);
  expect(json).toMatchObject({ sourceState: 'healthy', released: [], errors: [{ lane: 'lane-b', message: 'Lane was held manually' }] });
  expect(await lane('lane-b')).toMatchObject({ held: true, heldReason: 'manual: operator' });
});

it('releases nothing on degraded evidence in either mode', async () => {
  await writeFile(join(runsDir, 'queue/status.json'), '{');
  for (const args of [['--json', '--runs-dir', runsDir], ['--apply', '--json', '--runs-dir', runsDir]]) {
    const { code, json } = await run(args);
    expect(code).toBe(1);
    expect(json).toMatchObject({ sourceState: 'degraded', released: [] });
  }
  expect(await lane('lane-a')).toMatchObject({ held: true });
});

it('reports a partial release failure as nonzero while releasing what succeeded', async () => {
  const { code, json } = await run(['--apply', '--json', '--runs-dir', runsDir], async () => resets([row('lane-a'), row('lane-zz')]));
  expect(code).toBe(1);
  expect(json).toMatchObject({ checked: 2, released: [{ lane: 'lane-a' }], errors: [{ lane: 'lane-zz', message: 'Unknown lane' }] });
  expect(await lane('lane-a')).toMatchObject({ held: false });
});

it('surfaces an audit-append failure as nonzero after a real release', async () => {
  await mkdir(join(runsDir, 'queue/reset-releases.jsonl'));
  const { code, json } = await run(['--apply', '--json', '--runs-dir', runsDir]);
  expect(code).toBe(1);
  expect(json!.released).toHaveLength(2);
  expect(json!.errors![0]!.message).toContain('audit append failed');
  expect(await lane('lane-a')).toMatchObject({ held: false });
});
