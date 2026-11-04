import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  cmdFleetLaneShare,
  explainFleetLaneShare,
  laneMark,
  FLEET_LANE_SHARE_SCHEMA,
  FLEET_LANE_SHARE_STARVED_QUEUED,
} from '../src/cli/fleet-lane-share.js';

const SECRET = 'status-file-secret-do-not-print';
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const lane = (running: number, target: number, queued: number) => ({ running, target, queued, held: false, note: SECRET });

function status(patch: { cap?: number; reason?: string | null; lanes?: Record<string, unknown> } = {}) {
  return {
    schema: 'dispatchd.status.v1',
    unrelated: SECRET,
    admission: {
      // running deliberately disagrees with the lane sum: fleet running comes from the lanes.
      cap: patch.cap ?? 18,
      running: 99,
      load1: 4.5,
      reason: patch.reason === undefined ? null : patch.reason,
      warnings: [SECRET],
    },
    lanes: patch.lanes ?? {},
  };
}

async function fixture(contents: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-lane-share-'));
  dirs.push(dir);
  const path = join(dir, 'status.json');
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
  await writeFile(path, text);
  const reader = vi.fn(async (_requested: string) => readFile(path, 'utf8'));
  return { path, text, reader };
}

async function run(contents: unknown, args: string[]) {
  const file = await fixture(contents);
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetLaneShare(args, file.reader);
  expect(file.reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
  expect(await readFile(file.path, 'utf8')).toBe(file.text);
  const printed = String(output.mock.calls[0]?.[0] ?? '');
  expect(printed).not.toContain(SECRET);
  return { code, printed };
}

describe('laneMark', () => {
  it('marks starved only at 10 or more queued with none running', () => {
    expect(laneMark(0, 4, FLEET_LANE_SHARE_STARVED_QUEUED)).toBe('starved');
    expect(laneMark(0, 4, FLEET_LANE_SHARE_STARVED_QUEUED - 1)).toBeNull();
    expect(laneMark(0, 4, 0)).toBeNull();
    expect(laneMark(1, 4, 99)).toBeNull();
  });

  it('marks full when running equals target, and starved wins when both are true', () => {
    expect(laneMark(4, 4, 0)).toBe('full');
    expect(laneMark(4, 4, 30)).toBe('full');
    expect(laneMark(3, 4, 0)).toBeNull();
    expect(laneMark(0, 0, 30)).toBe('starved');
  });
});

describe('explainFleetLaneShare', () => {
  it('sums fleet running from the lanes and takes the cap from admission', () => {
    const view = explainFleetLaneShare(status({
      cap: 12,
      lanes: { codex: lane(1, 4, 2), devin: lane(2, 2, 0), local: lane(0, 2, 3) },
    }));
    expect(view.fleet).toEqual({ running: 3, cap: 12 });
    expect(view.status).toBe('ok');
    expect(view.admissionReason).toBeNull();
  });

  it('goes red only when a starved lane sits behind an at_cap admission reason', () => {
    const red = explainFleetLaneShare(status({
      reason: 'at_cap running 18 >= cap 18',
      lanes: { codex: lane(0, 4, 12), devin: lane(2, 2, 1) },
    }));
    expect(red.status).toBe('red');
    expect(red.lanes.map(row => [row.lane, row.mark, row.starvedAtCap])).toEqual([
      ['codex', 'starved', true],
      ['devin', 'full', false],
    ]);
    // Same starvation without the at_cap prefix (gate tripped on load first) stays ok.
    const load = explainFleetLaneShare(status({
      reason: 'loadavg 40.0 > 36.0; at_cap running 18 >= cap 18',
      lanes: { codex: lane(0, 4, 12) },
    }));
    expect(load.status).toBe('ok');
    expect(load.lanes[0]).toMatchObject({ mark: 'starved', starvedAtCap: false });
    const held = explainFleetLaneShare(status({ reason: 'paused', lanes: { codex: lane(0, 4, 12) } }));
    expect(held.status).toBe('ok');
  });
});

describe('ashlr fleet lane-share', () => {
  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['lane-share']!()).cmdFleetLaneShare).toBe(cmdFleetLaneShare);
  });

  it('prints one line per lane with marks, then the fleet line, and exits 1 on starved at the cap', async () => {
    const { code, printed } = await run(status({
      reason: 'at_cap running 18 >= cap 18',
      lanes: {
        codex: lane(0, 4, 12),
        devin: lane(2, 2, 1),
        local: lane(0, 2, 3),
      },
    }), []);
    expect(code).toBe(1);
    expect(printed).toBe([
      'codex: 0 of 4 running, 12 queued starved',
      'devin: 2 of 2 running, 1 queued full',
      'local: 0 of 2 running, 3 queued',
      'fleet: 2 running of cap 18',
      'red: codex starved while the admission reason starts with at_cap',
    ].join('\n'));
  });

  it('marks a lane starved once 10 are queued with none running', async () => {
    const { code, printed } = await run(status({
      reason: 'at_cap running 0 >= cap 18',
      lanes: { codex: lane(0, 4, FLEET_LANE_SHARE_STARVED_QUEUED) },
    }), []);
    expect(code).toBe(1);
    expect(printed).toContain('codex: 0 of 4 running, 10 queued starved');
    const near = await run(status({
      reason: 'at_cap running 0 >= cap 18',
      lanes: { codex: lane(0, 4, FLEET_LANE_SHARE_STARVED_QUEUED - 1) },
    }), []);
    expect(near.code).toBe(0);
    expect(near.printed).toContain('codex: 0 of 4 running, 9 queued\n');
    expect(near.printed).not.toContain('starved');
  });

  it('exits 0 for the same marks when the fleet is not parked at the cap', async () => {
    const { code, printed } = await run(status({
      reason: null,
      lanes: { codex: lane(0, 4, 40) },
    }), []);
    expect(code).toBe(0);
    expect(printed).toBe([
      'codex: 0 of 4 running, 40 queued starved',
      'fleet: 0 running of cap 18',
    ].join('\n'));
  });

  it('prints the typed view with --json', async () => {
    const { code, printed } = await run(status({
      cap: 2,
      reason: 'at_cap running 2 >= cap 2',
      lanes: { codex: lane(0, 4, 15), devin: lane(2, 2, 1) },
    }), ['--json']);
    expect(code).toBe(1);
    expect(JSON.parse(printed)).toEqual({
      schema: FLEET_LANE_SHARE_SCHEMA,
      readOnly: true,
      status: 'red',
      fleet: { running: 2, cap: 2 },
      admissionReason: 'at_cap running 2 >= cap 2',
      lanes: [
        { lane: 'codex', running: 0, target: 4, queued: 15, mark: 'starved', starvedAtCap: true },
        { lane: 'devin', running: 2, target: 2, queued: 1, mark: 'full', starvedAtCap: false },
      ],
    });
  });

  it('accepts an empty lane map and still reports the cap', async () => {
    const { code, printed } = await run(status({}), ['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toMatchObject({ status: 'ok', fleet: { running: 0, cap: 18 }, lanes: [] });
    const plain = await run(status({}), []);
    expect(plain.printed).toBe('fleet: 0 running of cap 18');
  });

  it('keeps every line plain when a lane name carries control characters', async () => {
    const { code, printed } = await run(status({ lanes: { 'codex\tlane': lane(1, 1, 0) } }), []);
    expect(code).toBe(0);
    expect(printed.split('\n')[0]).toBe('codex lane: 1 of 1 running, 0 queued full');
  });

  it('rejects invalid fixture files without echoing them', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const samples = [
      'not json ' + SECRET,
      {},
      { lanes: {} },
      { admission: { cap: 4 } },
      { admission: { cap: 4, reason: null }, lanes: [] },
      status({ lanes: { bad: { running: -1, target: 1, queued: 1 } } }),
      status({ lanes: { bad: { running: 0.5, target: 1, queued: 1 } } }),
      status({ lanes: { bad: { running: 0, target: 1 } } }),
      status({ lanes: { ' ': lane(0, 1, 1) } }),
      status({ reason: 4 as unknown as string }),
    ];
    for (const contents of samples) {
      const file = await fixture(contents);
      expect(await cmdFleetLaneShare(['--json'], file.reader)).toBe(2);
      const body = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(body).toEqual({ schema: FLEET_LANE_SHARE_SCHEMA, readOnly: true, error: 'Queue status is unreadable or invalid.' });
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(await readFile(file.path, 'utf8')).toBe(file.text);
    }
    expect(await cmdFleetLaneShare([], async () => { throw new Error(SECRET); })).toBe(2);
    expect(output.mock.calls.at(-1)![0]).toBe('Queue status is unreadable or invalid.');
  });

  it('prints help and rejects unknown flags before reading', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader = vi.fn();
    expect(await cmdFleetLaneShare(['--help'], reader)).toBe(0);
    expect(await cmdFleetLaneShare(['-h'], reader)).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('Usage: ashlr fleet lane-share [--json]');
    expect(log.mock.calls[0]![0]).toContain('10 or more queued');
    expect(await cmdFleetLaneShare(['--json', '--json'], reader)).toBe(2);
    expect(await cmdFleetLaneShare(['--other'], reader)).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet lane-share [--json]'));
    expect(reader).not.toHaveBeenCalled();
  });
});
