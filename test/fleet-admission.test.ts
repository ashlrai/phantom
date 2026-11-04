import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  cmdFleetAdmission,
  explainFleetAdmission,
  FLEET_ADMISSION_RED_QUEUED,
  FLEET_ADMISSION_SCHEMA,
} from '../src/cli/fleet-admission.js';

const SECRET = 'status-file-secret-do-not-print';
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const lane = (running: number, target: number, queued: number, held = false) => ({ running, target, queued, held, note: SECRET });

function status(patch: { running?: number; cap?: number; load1?: number; reason?: string | null; lanes?: Record<string, unknown> } = {}) {
  return {
    schema: 'dispatchd.status.v1',
    unrelated: SECRET,
    admission: {
      cap: patch.cap ?? 8,
      running: patch.running ?? 8,
      load1: patch.load1 ?? 12.5,
      reason: patch.reason === undefined ? 'at_cap running 8 >= cap 8' : patch.reason,
      warnings: [SECRET],
    },
    lanes: patch.lanes ?? {},
  };
}

async function fixture(contents: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-admission-'));
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
  const code = await cmdFleetAdmission(args, file.reader);
  expect(file.reader).toHaveBeenCalledExactlyOnceWith(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
  expect(await readFile(file.path, 'utf8')).toBe(file.text);
  const printed = String(output.mock.calls[0]?.[0] ?? '');
  expect(printed).not.toContain(SECRET);
  return { code, printed };
}

describe('explainFleetAdmission', () => {
  it('names held, at target, the global cap, then ok, in that order', () => {
    const report = explainFleetAdmission(status({
      lanes: {
        held: lane(0, 3, 9, true),
        full: lane(3, 3, 9),
        over: lane(4, 3, 1),
        blocked: lane(1, 3, 4),
        waiting: lane(1, 3, 0),
      },
    }));
    expect(report.lanes.map(row => [row.lane, row.reason, row.status])).toEqual([
      ['held', 'held', 'ok'],
      ['full', 'at target', 'ok'],
      ['over', 'at target', 'ok'],
      ['blocked', 'blocked by the global cap', 'ok'],
      ['waiting', 'ok', 'ok'],
    ]);
    expect(report.status).toBe('ok');
  });

  it('is red only when a cap-blocked lane has 5 or more queued', () => {
    const below = explainFleetAdmission(status({ lanes: { codex: lane(1, 3, FLEET_ADMISSION_RED_QUEUED - 1) } }));
    expect(below.status).toBe('ok');
    expect(below.lanes[0]).toMatchObject({ reason: 'blocked by the global cap', status: 'ok', queued: 4 });
    const at = explainFleetAdmission(status({ running: 9, cap: 8, lanes: { codex: lane(0, 2, FLEET_ADMISSION_RED_QUEUED) } }));
    expect(at.status).toBe('red');
    expect(at.global).toMatchObject({ cap: 8, running: 9, at_cap: true });
    expect(at.lanes[0]!.status).toBe('red');
  });

  it('does not call the cap a block while global running is under it', () => {
    const report = explainFleetAdmission(status({ running: 7, cap: 8, reason: null, lanes: { codex: lane(0, 2, 20) } }));
    expect(report.lanes[0]).toMatchObject({ reason: 'ok', status: 'ok' });
    expect(report.global).toMatchObject({ at_cap: false, admit_reason: null, load1: 12.5 });
    expect(report.status).toBe('ok');
  });

  it('treats a zero cap with nothing running as at the cap', () => {
    const report = explainFleetAdmission(status({ running: 0, cap: 0, lanes: { local: lane(0, 1, 5) } }));
    expect(report.global.at_cap).toBe(true);
    expect(report.status).toBe('red');
  });
});

describe('ashlr fleet admission', () => {
  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS.admission!()).cmdFleetAdmission).toBe(cmdFleetAdmission);
  });

  it('prints the global block and each lane from a fixture file, and exits 1 on red', async () => {
    const { code, printed } = await run(status({
      load1: 3.25,
      reason: 'at_cap running 8 >= cap 8',
      lanes: {
        codex: lane(1, 4, 6),
        devin: lane(2, 2, 1),
        held: lane(0, 2, 8, true),
      },
    }), ['--json']);
    expect(code).toBe(1);
    expect(JSON.parse(printed)).toEqual({
      schema: FLEET_ADMISSION_SCHEMA,
      readOnly: true,
      status: 'red',
      global: { cap: 8, running: 8, load1: 3.25, admit_reason: 'at_cap running 8 >= cap 8', at_cap: true },
      lanes: [
        { lane: 'codex', running: 1, target: 4, queued: 6, held: false, reason: 'blocked by the global cap', status: 'red' },
        { lane: 'devin', running: 2, target: 2, queued: 1, held: false, reason: 'at target', status: 'ok' },
        { lane: 'held', running: 0, target: 2, queued: 8, held: true, reason: 'held', status: 'ok' },
      ],
    });
  });

  it('uses plain words and exits 0 when the queue is short of the red line', async () => {
    const { code, printed } = await run(status({
      running: 3, cap: 8, reason: null, lanes: { codex: lane(1, 3, 4) },
    }), []);
    expect(code).toBe(0);
    expect(printed).toBe([
      'Admission: ok',
      'Global cap 8, running 3 (under the cap), load 12.5, admit reason: none',
      'ok codex: ok. Running 1 of 3. Queued 4. Held no.',
    ].join('\n'));
  });

  it('says when the fleet is at the cap and a lane is red', async () => {
    const { code, printed } = await run(status({ lanes: { codex: lane(1, 3, 5) } }), []);
    expect(code).toBe(1);
    expect(printed).toContain('Admission: red');
    expect(printed).toContain('Global cap 8, running 8 (at the cap), load 12.5, admit reason: at_cap running 8 >= cap 8');
    expect(printed).toContain('red codex: blocked by the global cap. Running 1 of 3. Queued 5. Held no.');
  });

  it('accepts an empty lane map and a missing admit reason', async () => {
    const { code, printed } = await run({ lanes: {}, admission: { cap: 4, running: 0, load1: 1 } }, ['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toMatchObject({
      status: 'ok', global: { cap: 4, running: 0, load1: 1, admit_reason: null, at_cap: false }, lanes: [],
    });
    const plain = await run({ lanes: {}, admission: { cap: 4, running: 0, load1: 1 } }, []);
    expect(plain.printed).toContain('No lanes.');
    expect(plain.printed).toContain('admit reason: none');
  });

  it('flattens control characters and scrubs a home path out of the admit reason', async () => {
    const home = homedir();
    const { code, printed } = await run(status({
      reason: `paused\n${home}/secret`,
      lanes: { 'codex\tlane': lane(3, 3, 0) },
    }), ['--json']);
    expect(code).toBe(0);
    const report = JSON.parse(printed) as { global: { admit_reason: string }; lanes: { lane: string }[] };
    expect(report.global.admit_reason).toBe('paused ~/secret');
    expect(report.global.admit_reason).not.toContain(home);
    expect(report.lanes[0]!.lane).toBe('codex lane');
  });

  it('rejects invalid fixture files without echoing them', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const samples = [
      'not json ' + SECRET,
      {},
      { lanes: {} },
      { admission: { cap: 1, running: 1, load1: 1 } },
      { admission: { cap: 1, running: 1, load1: 1 }, lanes: [] },
      status({ lanes: { bad: { running: -1, target: 1, queued: 1, held: false } } }),
      status({ lanes: { bad: { running: 0, target: 1, queued: 1, held: 'yes' } } }),
      status({ load1: Number.NaN }),
      status({ reason: 4 as unknown as string }),
    ];
    for (const contents of samples) {
      const file = await fixture(contents);
      expect(await cmdFleetAdmission(['--json'], file.reader)).toBe(2);
      const body = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(body).toEqual({ schema: FLEET_ADMISSION_SCHEMA, readOnly: true, error: 'Queue status is unreadable or invalid.' });
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(await readFile(file.path, 'utf8')).toBe(file.text);
    }
    expect(await cmdFleetAdmission([], async () => { throw new Error(SECRET); })).toBe(2);
    expect(output.mock.calls.at(-1)![0]).toBe('Queue status is unreadable or invalid.');
  });

  it('prints help and rejects unknown flags before reading', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader = vi.fn();
    expect(await cmdFleetAdmission(['--help'], reader)).toBe(0);
    expect(await cmdFleetAdmission(['-h'], reader)).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('Usage: ashlr fleet admission [--json]');
    expect(log.mock.calls[0]![0]).toContain('5 or more queued');
    expect(await cmdFleetAdmission(['--json', '--json'], reader)).toBe(2);
    expect(await cmdFleetAdmission(['--other'], reader)).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet admission [--json]'));
    expect(reader).not.toHaveBeenCalled();
  });
});
