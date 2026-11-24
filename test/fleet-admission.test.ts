import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { settleAdvice } from '../src/core/fleet/settle-advice.js';
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

function status(patch: {
  running?: number; cap?: number; load1?: number; reason?: string | null;
  lanes?: Record<string, unknown>;
  gate_reason?: string | null; admit?: boolean; decision?: string; paused?: string | null;
} = {}) {
  return {
    schema: 'dispatchd.status.v1',
    unrelated: SECRET,
    paused: patch.paused ?? null,
    admission: {
      cap: patch.cap ?? 8,
      running: patch.running ?? 8,
      load1: patch.load1 ?? 12.5,
      reason: patch.reason === undefined ? 'at_cap running 8 >= cap 8' : patch.reason,
      ...(patch.gate_reason !== undefined ? { gate_reason: patch.gate_reason } : {}),
      ...(patch.admit !== undefined ? { admit: patch.admit } : {}),
      ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
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
  const reader = vi.fn(async (requested: string) => {
    if (!requested.endsWith('status.json')) throw new Error('Missing optional fixture');
    return readFile(path, 'utf8');
  });
  return { path, text, reader };
}

async function run(contents: unknown, args: string[]) {
  const file = await fixture(contents);
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetAdmission([...args, '--details'], file.reader);
  expect(file.reader.mock.calls.map(([path]) => path)).toEqual(['queue/status.json', 'queue/admission-ctl.json', 'metrics/fleet-controller.jsonl'].map(path => join(homedir(), '.ashlr-runs', path)));
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

  it('reads at target at the shed launch ceiling, not the configured one', () => {
    const report = explainFleetAdmission(status({
      lanes: {
        shedFull: { ...lane(2, 4, 6), effective_target: 2 },
        shedRoom: { ...lane(1, 4, 6), effective_target: 2 },
      },
    }));
    expect(report.lanes.map(row => [row.lane, row.target, row.reason])).toEqual([
      ['shedFull', 2, 'at target'],
      ['shedRoom', 2, 'blocked by the global cap'],
    ]);
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

  it('marks lanes admission closed when the load gate shuts admission under the cap', () => {
    const report = explainFleetAdmission(status({
      running: 3, cap: 8, reason: 'loadavg 1m 14.2 > max 12.0',
      gate_reason: 'loadavg 1m 14.2 > max 12.0', admit: false, decision: 'stop',
      lanes: { codex: lane(1, 3, 6), devin: lane(2, 2, 1), idle: lane(0, 2, 0) },
    }));
    expect(report.global).toMatchObject({ at_cap: false, closed: true, non_cap_closed: true });
    expect(report.lanes.map(row => [row.lane, row.reason, row.status])).toEqual([
      ['codex', 'admission closed', 'red'],
      ['devin', 'at target', 'ok'],
      ['idle', 'ok', 'ok'],
    ]);
    expect(report.status).toBe('red');
  });

  it('marks lanes admission closed on a pause even without gate fields', () => {
    const report = explainFleetAdmission(status({
      running: 3, cap: 8, reason: 'paused', paused: 'operator hold',
      lanes: { codex: lane(1, 3, 5) },
    }));
    expect(report.global).toMatchObject({ closed: true, non_cap_closed: true });
    expect(report.lanes[0]).toMatchObject({ reason: 'admission closed', status: 'red' });
  });

  it('derives a non-cap block from a stop verdict while under the cap', () => {
    const report = explainFleetAdmission(status({
      running: 3, cap: 8, reason: 'disk below floor', admit: false, decision: 'stop',
      lanes: { codex: lane(1, 3, 5) },
    }));
    expect(report.global.non_cap_closed).toBe(true);
    expect(report.lanes[0]!.reason).toBe('admission closed');
  });

  it('lets admission closed outrank the cap when the gate and the cap are both shut', () => {
    const report = explainFleetAdmission(status({
      running: 8, cap: 8, reason: 'loadavg 1m 14.2 > max 12.0; at_cap running 8 >= cap 8',
      gate_reason: 'loadavg 1m 14.2 > max 12.0', admit: false, decision: 'stop',
      lanes: { codex: lane(1, 3, 6) },
    }));
    expect(report.global).toMatchObject({ at_cap: true, closed: true, non_cap_closed: true });
    expect(report.lanes[0]).toMatchObject({ reason: 'admission closed', status: 'red' });
  });

  it('keeps the cap reason when the cap is the only block', () => {
    const report = explainFleetAdmission(status({
      running: 8, cap: 8, reason: 'at_cap running 8 >= cap 8', admit: false, decision: 'stop',
      lanes: { codex: lane(1, 3, 6) },
    }));
    expect(report.global).toMatchObject({ at_cap: true, closed: true, non_cap_closed: false });
    expect(report.lanes[0]).toMatchObject({ reason: 'blocked by the global cap', status: 'red' });
  });

  it('does not call an idle lane blocked while admission is closed', () => {
    const report = explainFleetAdmission(status({
      running: 3, cap: 8, reason: 'paused', paused: 'operator hold',
      lanes: { codex: lane(0, 3, 0), held: lane(0, 3, 9, true) },
    }));
    expect(report.lanes.map(row => row.reason)).toEqual(['ok', 'held']);
    expect(report.status).toBe('ok');
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
      launchGuard: { state: 'unknown', why: null, settleSeconds: null, load1: null, ownedLoad1: null },
      settleAdvice: settleAdvice(null, Date.now()),
      global: { cap: 8, running: 8, load1: 3.25, admit_reason: 'at_cap running 8 >= cap 8', at_cap: true, closed: true, non_cap_closed: false },
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
      'Launch guard: unknown; reason: unknown; settle: unknown seconds; host load: unknown; owned load: unknown.',
      `Suggested settle: unknown seconds (0/24 hours observed). ${settleAdvice(null, Date.now()).reason} No settings changed.`,
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

  it('prints the admission-closed marker and exits 1 on a gated fleet', async () => {
    const { code, printed } = await run(status({
      running: 3, cap: 8, reason: 'loadavg 1m 14.2 > max 12.0',
      gate_reason: 'loadavg 1m 14.2 > max 12.0', admit: false, decision: 'stop',
      lanes: { codex: lane(1, 3, 6) },
    }), []);
    expect(code).toBe(1);
    expect(printed).toContain('Admission: red');
    expect(printed).toContain('under the cap), admission closed, load 12.5');
    expect(printed).toContain('red codex: admission closed. Running 1 of 3. Queued 6. Held no.');
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
      expect(await cmdFleetAdmission(['--details', '--json'], file.reader)).toBe(2);
      const body = JSON.parse(String(output.mock.calls.at(-1)![0]));
      expect(body).toEqual({ schema: FLEET_ADMISSION_SCHEMA, readOnly: true, error: 'Queue status is unreadable or invalid.' });
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(await readFile(file.path, 'utf8')).toBe(file.text);
    }
    expect(await cmdFleetAdmission(['--details'], async () => { throw new Error(SECRET); })).toBe(2);
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

describe('settle advice from recorded load', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const history = (ratio: number) => Array.from({ length: 25 }, (_, hour) => JSON.stringify({
    ts: (now - Math.min(hour * 3_600_000, 86_399_000)) / 1000,
    signals: { load1: ratio * 8, ncpu: 8 }, private: SECRET,
  })).join('\n');

  it.each([[0.5, 30], [1.5, 165], [3, 300]])('suggests bounded seconds for load ratio %s', (ratio, seconds) => {
    expect(settleAdvice(history(ratio), now)).toMatchObject({ recommendedSeconds: seconds, hoursCovered: 24, samples: 25 });
  });

  it('keeps missing, short, stale, future and invalid history unknown', () => {
    for (const text of [null, '', SECRET, '{}', '[]', history(0.5).split('\n')[0]!,
      history(0.5).split('\n').slice(1).join('\n'), history(0.5).replaceAll('"ncpu":8', '"ncpu":0')]) {
      expect(settleAdvice(text, now).recommendedSeconds).toBeNull();
    }
    expect(settleAdvice(history(0.5), now - 86_400_000).recommendedSeconds).toBeNull();
    expect(settleAdvice(history(0.5), now + 86_400_000).recommendedSeconds).toBeNull();
    expect(settleAdvice(history(0.5).split('\n').filter((_, i) => i !== 12).join('\n'), now).recommendedSeconds).toBeNull();
  });

  it('uses hourly peaks, ignores malformed rows and does not let repeated quiet samples dilute pressure', () => {
    const rows = history(0.5).split('\n');
    rows[5] = rows[5]!.replace('"load1":4', '"load1":24');
    rows[12] = rows[12]!.replace('"load1":4', '"load1":24');
    const busy = [...rows, ...Array<string>(100).fill(rows[0]!), SECRET].reverse().join('\n');
    expect(settleAdvice(busy, now)).toMatchObject({ recommendedSeconds: 300, loadPerCpuP95: 3 });
    expect(settleAdvice(history(0.5).replaceAll('"ts":', '"timestamp":'), now).recommendedSeconds).toBeNull();
  });

  it('prints settle, host and owned load separately in JSON and plain words without changing files', async () => {
    const snapshot = status({ running: 3, lanes: { codex: lane(1, 3, 6) } });
    const files = new Map([
      ['status.json', JSON.stringify(snapshot)],
      ['admission-ctl.json', JSON.stringify({ why: 'settle after launch', settle_s: 300, load1: 40, owned_load1: 2, private: SECRET })],
      ['fleet-controller.jsonl', history(1.5)],
    ]);
    const before = [...files];
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reader = async (path: string) => files.get(path.split('/').at(-1)!)!;
    expect(await cmdFleetAdmission(['--details', '--json'], reader, now)).toBe(1);
    const report = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(report).toMatchObject({ readOnly: true, global: { cap: 8 }, launchGuard: {
      state: 'waiting', why: 'settle after launch', settleSeconds: 300, load1: 40, ownedLoad1: 2,
    }, lanes: [{ reason: 'admission closed', status: 'red' }], settleAdvice: { recommendedSeconds: 165 } });
    expect(await cmdFleetAdmission(['--details'], reader, now)).toBe(1);
    const plain = String(output.mock.calls.at(-1)![0]);
    expect(plain).toContain('reason: settle after launch; settle: 300 seconds; host load: 40; owned load: 2');
    expect(plain).toContain('Suggested settle: 165 seconds (24/24 hours observed)');
    expect(plain).toContain('No settings changed.');
    expect(JSON.stringify(output.mock.calls)).not.toContain(SECRET);
    expect([...files]).toEqual(before);
  });
});
