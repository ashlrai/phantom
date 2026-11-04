/** fleet-resources.test.ts — `ashlr fleet resources`: one plain line per
 * slots.json lane with the router's used_frac reading and reset time.
 * "skipped" at used_frac >= 1, "unseen" when a lane with target > 0 has no
 * resources.json entry (exit 1). Injected readers only; plainly fake values. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  buildFleetResourcesView,
  cmdFleetResources,
  FLEET_RESOURCES_SCHEMA,
  ROUTER_ASSUMED_USED_FRAC,
  type FleetResourcesDeps,
} from '../src/cli/fleet-resources.js';

const SECRET = 'resources-file-secret-do-not-print';
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const lane = (target: number, extra: Record<string, unknown> = {}) =>
  ({ target, floor: 0, ceiling: 12, held: false, ...extra });

function files({ slots, resources }: { slots?: unknown; resources?: unknown }): Map<string, string> {
  const map = new Map<string, string>();
  if (slots !== undefined) map.set('slots.json', typeof slots === 'string' ? slots : JSON.stringify(slots));
  if (resources !== undefined) map.set('resources.json', typeof resources === 'string' ? resources : JSON.stringify(resources));
  return map;
}

async function run(fileMap: Map<string, string>, args: string[] = []) {
  const read = vi.fn(async (path: string) => {
    const name = path.split('/').pop()!;
    const text = fileMap.get(name);
    if (text === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return text;
  });
  const logs: string[] = [];
  const errs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
  vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => { errs.push(String(msg)); });
  const deps: FleetResourcesDeps = { read, now: () => new Date('2026-11-04T12:00:00Z') };
  const code = await cmdFleetResources(args, deps);
  return { code, out: logs.join('\n'), err: errs.join('\n'), read };
}

describe('buildFleetResourcesView', () => {
  it('projects target, used_frac and reset per lane and marks skipped at 1 or more', () => {
    const view = buildFleetResourcesView(
      { state: 'healthy', rows: {
        devin: lane(8), codex: lane(4), claude: lane(1), idle: lane(0),
      } },
      { state: 'healthy', rows: {
        devin: { used_frac: 0.42, reset_at: '2026-11-05T00:00:00Z' },
        codex: { used_frac: 1.25, reset_at: '2026-11-05T06:00:00Z' },
        claude: { used_frac: 1, reset_at: null },
      } },
      '2026-11-04T12:00:00.000Z',
    );
    expect(view.lanes).toEqual([
      { lane: 'devin', target: 8, usedFrac: 0.42, resetAt: '2026-11-05T00:00:00Z', status: 'ok' },
      { lane: 'codex', target: 4, usedFrac: 1.25, resetAt: '2026-11-05T06:00:00Z', status: 'skipped' },
      { lane: 'claude', target: 1, usedFrac: 1, resetAt: null, status: 'skipped' },
      { lane: 'idle', target: 0, usedFrac: null, resetAt: null, status: 'ok' },
    ]);
    expect(view.unseenLanes).toEqual([]);
  });

  it('marks a lane unseen only when its target is above 0 and it has no entry', () => {
    const view = buildFleetResourcesView(
      { state: 'healthy', rows: { live: lane(2), paused: lane(0) } },
      { state: 'healthy', rows: {} },
      '2026-11-04T12:00:00.000Z',
    );
    expect(view.lanes.map(l => [l.lane, l.status])).toEqual([['live', 'unseen'], ['paused', 'ok']]);
    expect(view.unseenLanes).toEqual(['live']);
  });
});

describe('ashlr fleet resources', () => {
  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS.resources!()).cmdFleetResources).toBe(cmdFleetResources);
  });

  it('prints one plain line per slots.json lane, in file order', async () => {
    const { code, out } = await run(files({
      slots: { devin: lane(8), codex: lane(4), claude: lane(1), paused: lane(0) },
      resources: {
        devin: { used_frac: 0.42, reset_at: '2026-11-05T00:00:00Z' },
        codex: { used_frac: 1.25, reset_at: '2026-11-05T06:00:00Z' },
        claude: { used_frac: 0.99, reset_at: '2026-11-04T18:00:00Z' },
      },
    }));
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines).toEqual([
      'devin: ok; target=8; used_frac=0.42; reset=2026-11-05T00:00:00Z',
      'codex: skipped; target=4; used_frac=1.25; reset=2026-11-05T06:00:00Z',
      'claude: ok; target=1; used_frac=0.99; reset=2026-11-04T18:00:00Z',
      'paused: ok; target=0; used_frac=unset, router assumes 0.5; reset=unknown',
    ]);
  });

  it('marks unseen lanes, exits 1 and still prints every lane', async () => {
    const { code, out } = await run(files({
      slots: { devin: lane(8), codex: lane(4), paused: lane(0) },
      resources: { devin: { used_frac: 0.5, reset_at: '2026-11-05T00:00:00Z' } },
    }));
    expect(code).toBe(1);
    expect(out).toContain(`codex: unseen; target=4; used_frac=unset, router assumes ${ROUTER_ASSUMED_USED_FRAC}; reset=unknown`);
    expect(out).toContain('devin: ok; target=8');
    expect(out).toContain('paused: ok; target=0');
  });

  it('treats a missing resources.json as no readings: every live lane unseen', async () => {
    const { code, out } = await run(files({ slots: { devin: lane(2) } }));
    expect(code).toBe(1);
    expect(out).toContain('devin: unseen; target=2; used_frac=unset, router assumes 0.5; reset=unknown');
    const { code: codeJson, out: outJson } = await run(files({ slots: { devin: lane(2) } }), ['--json']);
    expect(codeJson).toBe(1);
    expect(JSON.parse(outJson)).toMatchObject({ resources: 'missing', unseenLanes: ['devin'] });
  });

  it('accepts the lanes wrapper and skips global slots keys', async () => {
    const { code, out } = await run(files({
      slots: { lanes: { devin: lane(3) }, hard_cap: 18, metadata: { keep: 'me' } },
      resources: { lanes: { devin: { used_frac: 0, reset_at: '2026-11-06T00:00:00Z' } } },
    }));
    expect(code).toBe(0);
    expect(out).toBe('devin: ok; target=3; used_frac=0; reset=2026-11-06T00:00:00Z');
    expect(out).not.toContain('hard_cap');
    expect(out).not.toContain('metadata');
  });

  it('emits the view through --json and keeps secret-shaped entry fields out', async () => {
    const { code, out } = await run(files({
      slots: { devin: lane(8), codex: lane(4) },
      resources: { devin: { used_frac: 0.5, reset_at: '2026-11-05T00:00:00Z', source: SECRET } },
    }), ['--json']);
    expect(code).toBe(1);
    expect(out).not.toContain(SECRET);
    const view = JSON.parse(out);
    expect(view).toEqual({
      schema: FLEET_RESOURCES_SCHEMA,
      readOnly: true,
      generatedAt: '2026-11-04T12:00:00.000Z',
      slots: 'healthy',
      resources: 'healthy',
      unseenLanes: ['codex'],
      lanes: [
        { lane: 'devin', target: 8, usedFrac: 0.5, resetAt: '2026-11-05T00:00:00Z', status: 'ok' },
        { lane: 'codex', target: 4, usedFrac: null, resetAt: null, status: 'unseen' },
      ],
    });
  });

  it('reports no lanes when slots.json is missing or unreadable, exit 0', async () => {
    const missing = await run(files({}));
    expect(missing.code).toBe(0);
    expect(missing.out).toBe('no lanes (slots.json missing)');
    const degraded = await run(files({ slots: '{broken' }));
    expect(degraded.code).toBe(0);
    expect(degraded.out).toBe('no lanes (slots.json unreadable)');
    const notObject = await run(files({ slots: [1, 2] }));
    expect(notObject.code).toBe(0);
    expect(notObject.out).toBe('no lanes (slots.json unreadable)');
    const empty = await run(files({ slots: {} }));
    expect(empty.code).toBe(0);
    expect(empty.out).toBe('no lanes');
  });

  it('notes an unreadable resources.json and reads every lane as unseen', async () => {
    const { code, out } = await run(files({ slots: { devin: lane(2) }, resources: '{oops' }));
    expect(code).toBe(1);
    expect(out).toContain('devin: unseen; target=2');
    expect(out).toContain('resources.json unreadable; every lane reads as unseen');
  });

  it('does not let a __proto__ key in resources.json count as an entry for other lanes', async () => {
    const { code, out } = await run(files({
      slots: { devin: lane(2) },
      resources: '{"__proto__":{"used_frac":0,"reset_at":"x"},"devin":{"used_frac":0.1}}',
    }));
    expect(code).toBe(0);
    expect(out).toContain('devin: ok; target=2; used_frac=0.1; reset=unknown');
    const only = await run(files({
      slots: { devin: lane(2) },
      resources: '{"__proto__":{"used_frac":0}}',
    }));
    expect(only.code).toBe(1);
    expect(only.out).toContain('devin: unseen; target=2');
  });

  it('normalizes an epoch-seconds reset_at and flattens control characters', async () => {
    const { code, out } = await run(files({
      slots: { 'codex\tlane': lane(2) },
      resources: { 'codex\tlane': { used_frac: 0.1, reset_at: 1793830800 } },
    }));
    expect(code).toBe(0);
    expect(out).toBe(`codex lane: ok; target=2; used_frac=0.1; reset=${new Date(1793830800 * 1000).toISOString()}`);
    const huge = await run(files({
      slots: { devin: lane(1) },
      resources: { devin: { used_frac: 0.1, reset_at: 1e20 } },
    }));
    expect(huge.code).toBe(0);
    expect(huge.out).toBe('devin: ok; target=1; used_frac=0.1; reset=unknown');
  });

  it('reads a real runs dir end-to-end through --runs-dir', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'fleet-resources-'));
    dirs.push(runsDir);
    await mkdir(join(runsDir, 'queue'));
    const slotsPath = join(runsDir, 'queue', 'slots.json');
    await writeFile(slotsPath, JSON.stringify({ devin: lane(4), codex: lane(1) }));
    await writeFile(join(runsDir, 'queue', 'resources.json'),
      JSON.stringify({ devin: { used_frac: 0.75, reset_at: '2026-11-05T00:00:00Z' } }));
    const slotsBefore = await readFile(slotsPath, 'utf8');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
    // No injected read: the real utf8 reader runs against the temp runs dir.
    const code = await cmdFleetResources(['--runs-dir', runsDir], { now: () => new Date('2026-11-04T12:00:00Z') });
    expect(code).toBe(1);
    expect(logs.join('\n').split('\n')).toEqual([
      'devin: ok; target=4; used_frac=0.75; reset=2026-11-05T00:00:00Z',
      'codex: unseen; target=1; used_frac=unset, router assumes 0.5; reset=unknown',
    ]);
    expect(await readFile(slotsPath, 'utf8')).toBe(slotsBefore); // read-only
  });

  it('prints help and exits 0', async () => {
    const { code, out, read } = await run(new Map(), ['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Usage: ashlr fleet resources');
    expect(out).toContain('unseen');
    expect(read).not.toHaveBeenCalled();
    expect((await run(new Map(), ['-h'])).code).toBe(0);
  });

  it.each([
    ['--bogus'],
    ['--runs-dir'],
    ['--runs-dir', 'relative/path'],
    ['extra'],
    ['--json', '--', 'extra'],
  ])('rejects usage error %j with exit 2', async (...args: string[]) => {
    const { code, err, read } = await run(new Map(), args);
    expect(code).toBe(2);
    expect(err).toContain('Usage: ashlr fleet resources');
    expect(read).not.toHaveBeenCalled();
  });
});
