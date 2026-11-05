import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  cmdFleetStarved,
  explainFleetStarved,
  FLEET_STARVED_SCHEMA,
  FLEET_STARVED_RED_QUEUED,
} from '../src/cli/fleet-starved.js';

const SECRET = 'status-file-secret-do-not-print';
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const lane = (running: number, target: number, queued: number) => ({ running, target, queued, held: false, note: SECRET });

function status(patch: { running?: number; cap?: number; reason?: string | null; lanes?: Record<string, unknown> } = {}) {
  return {
    schema: 'dispatchd.status.v1',
    unrelated: SECRET,
    admission: {
      cap: patch.cap ?? 18,
      running: patch.running ?? 18,
      load1: 4.5,
      reason: patch.reason === undefined ? null : patch.reason,
      warnings: [SECRET],
    },
    lanes: patch.lanes ?? {},
  };
}

async function fixture(contents: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-starved-'));
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
  const code = await cmdFleetStarved(args, file.reader);
  expect(file.reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
  expect(await readFile(file.path, 'utf8')).toBe(file.text);
  const printed = String(output.mock.calls[0]?.[0] ?? '');
  expect(printed).not.toContain(SECRET);
  return { code, printed };
}

describe('explainFleetStarved', () => {
  it('keeps only lanes with queued work and marks starved under an at_cap reason', () => {
    const view = explainFleetStarved(status({
      reason: 'at_cap running 18 >= cap 18',
      lanes: { codex: lane(1, 4, 2), devin: lane(2, 2, 1), local: lane(0, 2, 0) },
    }));
    expect(view.lanes.map(row => [row.lane, row.starved])).toEqual([
      ['codex', true],
      ['devin', false],
    ]);
    expect(view.admission).toEqual({ running: 18, cap: 18, reason: 'at_cap running 18 >= cap 18', atCap: true });
    expect(view.status).toBe('ok');
  });

  it('is not starved when the reason does not start with at_cap, even with headroom', () => {
    const load = explainFleetStarved(status({
      reason: 'loadavg 40.0 > 36.0; at_cap running 18 >= cap 18',
      lanes: { codex: lane(0, 4, 3) },
    }));
    expect(load.lanes[0]).toMatchObject({ starved: false });
    expect(load.admission.atCap).toBe(false);
    const held = explainFleetStarved(status({ reason: 'paused', lanes: { codex: lane(0, 4, 3) } }));
    expect(held.lanes[0]).toMatchObject({ starved: false });
    const none = explainFleetStarved(status({ reason: null, lanes: { codex: lane(0, 4, 3) } }));
    expect(none.lanes[0]).toMatchObject({ starved: false });
  });

  it('turns red once a lane has 10 or more queued and none running, whatever the reason', () => {
    const atCap = explainFleetStarved(status({
      reason: 'at_cap running 18 >= cap 18',
      lanes: { codex: lane(0, 4, FLEET_STARVED_RED_QUEUED), devin: lane(2, 2, 1) },
    }));
    expect(atCap.status).toBe('red');
    expect(atCap.lanes[0]).toMatchObject({ lane: 'codex', backlogged: true, starved: true });
    expect(atCap.lanes[1]).toMatchObject({ backlogged: false });
    const quiet = explainFleetStarved(status({ reason: null, lanes: { codex: lane(0, 4, 12) } }));
    expect(quiet.status).toBe('red');
    expect(quiet.lanes[0]).toMatchObject({ backlogged: true, starved: false });
    const near = explainFleetStarved(status({ lanes: { codex: lane(0, 4, FLEET_STARVED_RED_QUEUED - 1) } }));
    expect(near.status).toBe('ok');
    expect(near.lanes[0]).toMatchObject({ backlogged: false });
    const running = explainFleetStarved(status({ lanes: { codex: lane(1, 4, 40) } }));
    expect(running.status).toBe('ok');
  });

  it('does not mark a lane starved when its target is already met or zero', () => {
    const view = explainFleetStarved(status({
      reason: 'at_cap running 18 >= cap 18',
      lanes: { full: lane(2, 2, 9), zero: lane(0, 0, 3) },
    }));
    expect(view.lanes).toEqual([
      { lane: 'full', running: 2, target: 2, queued: 9, starved: false, backlogged: false },
      { lane: 'zero', running: 0, target: 0, queued: 3, starved: false, backlogged: false },
    ]);
  });
});

describe('ashlr fleet starved', () => {
  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['starved']!()).cmdFleetStarved).toBe(cmdFleetStarved);
  });

  it('prints one line per queued lane, then the admission line, and exits 1 on a backlogged lane', async () => {
    const { code, printed } = await run(status({
      running: 18,
      cap: 18,
      reason: 'at_cap running 18 >= cap 18',
      lanes: {
        codex: lane(0, 4, 12),
        devin: lane(2, 2, 1),
        local: lane(0, 2, 0),
        grok: lane(1, 2, 3),
      },
    }), []);
    expect(code).toBe(1);
    expect(printed).toBe([
      'codex: 0 of 4 running, 12 queued starved',
      'devin: 2 of 2 running, 1 queued',
      'grok: 1 of 2 running, 3 queued starved',
      'admission: 18 running of cap 18, reason: at_cap running 18 >= cap 18',
    ].join('\n'));
  });

  it('exits 0 under the backlog threshold and reports reason none when absent', async () => {
    const { code, printed } = await run(status({
      running: 0,
      cap: 18,
      reason: null,
      lanes: { codex: lane(0, 4, FLEET_STARVED_RED_QUEUED - 1) },
    }), []);
    expect(code).toBe(0);
    expect(printed).toBe([
      'codex: 0 of 4 running, 9 queued',
      'admission: 0 running of cap 18, reason: none',
    ].join('\n'));
  });

  it('prints only the admission line when nothing is queued', async () => {
    const { code, printed } = await run(status({ running: 3, lanes: { devin: lane(2, 2, 0) } }), []);
    expect(code).toBe(0);
    expect(printed).toBe('admission: 3 running of cap 18, reason: none');
    const empty = await run(status({ running: 0 }), []);
    expect(empty.printed).toBe('admission: 0 running of cap 18, reason: none');
  });

  it('prints the typed view with --json', async () => {
    const { code, printed } = await run(status({
      running: 2,
      cap: 2,
      reason: 'at_cap running 2 >= cap 2',
      lanes: { codex: lane(0, 4, 15), devin: lane(2, 2, 1), idle: lane(0, 3, 0) },
    }), ['--json']);
    expect(code).toBe(1);
    expect(JSON.parse(printed)).toEqual({
      schema: FLEET_STARVED_SCHEMA,
      readOnly: true,
      status: 'red',
      admission: { running: 2, cap: 2, reason: 'at_cap running 2 >= cap 2', atCap: true },
      lanes: [
        { lane: 'codex', running: 0, target: 4, queued: 15, starved: true, backlogged: true },
        { lane: 'devin', running: 2, target: 2, queued: 1, starved: false, backlogged: false },
      ],
    });
  });

  it('keeps every line plain when a lane name or reason carries control characters', async () => {
    const { code, printed } = await run(status({
      reason: 'at_cap running 18 >= cap 18\nnext',
      lanes: { 'codex\tlane': lane(1, 1, 2) },
    }), []);
    expect(code).toBe(0);
    expect(printed).toBe([
      'codex lane: 1 of 1 running, 2 queued',
      'admission: 18 running of cap 18, reason: at_cap running 18 >= cap 18 next',
    ].join('\n'));
  });

  it('rejects invalid fixture files without echoing them', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const samples = [
      'not json ' + SECRET,
      {},
      { lanes: {} },
      { admission: { cap: 4 } },
      { admission: { cap: 4, running: 1, reason: null }, lanes: [] },
      status({ lanes: { bad: { running: -1, target: 1, queued: 1 } } }),
      status({ lanes: { bad: { running: 0.5, target: 1, queued: 1 } } }),
      status({ lanes: { bad: { running: 0, target: 1 } } }),
      status({ lanes: { ' ': lane(0, 1, 1) } }),
      status({ reason: 4 as unknown as string }),
      status({ running: -1 }),
    ];
    for (const contents of samples) {
      const file = await fixture(contents);
      expect(await cmdFleetStarved(['--json'], file.reader)).toBe(2);
      const body = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(body).toEqual({ schema: FLEET_STARVED_SCHEMA, readOnly: true, error: 'Queue status is unreadable or invalid.' });
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(await readFile(file.path, 'utf8')).toBe(file.text);
    }
    expect(await cmdFleetStarved([], async () => { throw new Error(SECRET); })).toBe(2);
    expect(output.mock.calls.at(-1)![0]).toBe('Queue status is unreadable or invalid.');
  });

  it('prints help and rejects unknown flags before reading', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader = vi.fn();
    expect(await cmdFleetStarved(['--help'], reader)).toBe(0);
    expect(await cmdFleetStarved(['-h'], reader)).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('Usage: ashlr fleet starved [--json]');
    expect(log.mock.calls[0]![0]).toContain('10 or more queued');
    expect(await cmdFleetStarved(['--json', '--json'], reader)).toBe(2);
    expect(await cmdFleetStarved(['--other'], reader)).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet starved [--json]'));
    expect(reader).not.toHaveBeenCalled();
  });
});
