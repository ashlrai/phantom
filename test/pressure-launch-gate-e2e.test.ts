/**
 * RQ-PHX-PRESSURELAUNCHE2E03 — the memory-pressure launch gate, end to end.
 *
 * Mason's Nov 1 order: the Mac must never reach force-quit again — a warning
 * stops new worker launches, launches resume on their own when pressure
 * drops, no human step. This suite drives the REAL tick decision path
 * (driveTick → planDrive → bridge.launch) with only two injected facts: the
 * pressure reading and the clock. A temp runs dir carries the ready lines;
 * the live-worker list comes from the real launch.sh process filter fed a
 * synthetic `ps` table — no real process, no real memory read, no signal.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  driveTick, pressurePauseOrder, type DriveBridge, type DriveDependencies, type DriveJob,
  type DrivePressureLevel, type DriveSnapshot,
} from '../src/core/drive/supervisor.js';
import { parseReadyTsv } from '../src/core/fleet/lane-console.js';
import { parsePsTable } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-01T18:06:00.000Z');

/** Ready/job lines, dispatchd style: id, status, pool, tier, repo, priority, title. */
const READY_TSV = [
  'id\tstatus\tpool\ttier\trepo\tpriority\ttitle',
  'RQ-PHX-ALPHA\tREADY\tcodex-cmp\twork\tphantom\t8\tfirst ready line',
  'RQ-PHX-BETA\tREADY\tcodex-cmp\tmid\tphantom\t6\tsecond ready line',
  'RQ-PHX-GAMMA\tREADY\tcodex-cmp\tmid\tphantom\t4\tthird ready line',
  'RQ-PHX-NEW\tRUNNING\tcodex-cmp\tfrontier\tphantom\t9\tnewest running worker',
  'RQ-PHX-MID\tRUNNING\tcodex-cmp\twork\tphantom\t5\tmiddle running worker',
  'RQ-PHX-OLD\tRUNNING\tcodex-cmp\tlow\tphantom\t1\toldest running worker',
].join('\n') + '\n';

/**
 * A synthetic `ps -axo pid=,etime=,command=` table. The three workers are
 * launch.sh rows; the rest is GUI apps and a grep self-match — the real
 * process filter must never let a GUI name reach the pause list. The last
 * row is a hostile launch.sh line for a job the queue is NOT running.
 */
const PS_TABLE = [
  '  501 00:00:30 /Users/m/.ashlr-runs/bin/launch.sh RQ-PHX-NEW phantom codex-cmp frontier',
  '  502 00:00:30 /Users/m/.ashlr-runs/bin/launch.sh RQ-PHX-MID phantom codex-cmp work',
  '  503 00:04:00 /Users/m/.ashlr-runs/bin/launch.sh RQ-PHX-OLD phantom codex-cmp low',
  '  601 01:00:00 /Applications/Phantom.app/Contents/MacOS/Phantom --daemon',
  '  602 02:00:00 /Applications/Cursor.app/Contents/MacOS/Cursor --foreground',
  '  603 03:00:00 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
  '  604 04:00:00 /Applications/Codex.app/Contents/MacOS/Codex',
  '  605 05:00:00 /Applications/Grok Bot.app/Contents/MacOS/Grok Bot',
  '  606 06:00:00 /bin/ps -axo pid=,etime=,command=',
  '  607 07:00:00 /usr/bin/grep launch.sh',
  '  700 00:00:10 /Users/m/.ashlr-runs/bin/launch.sh Cursor phantom codex-cmp work',
].join('\n') + '\n';

const RUNNING_STATES = new Set(['RUNNING', 'STARTING']);

interface Fixture {
  dir: string;
  deps: DriveDependencies;
  bridge: DriveBridge;
  setLevel(level: DrivePressureLevel | null): void;
}

/**
 * A runs dir + a bridge that re-reads queue/ready.tsv through the real
 * ready-line parser on every snapshot, and persists a launch by rewriting
 * the job's line READY → STARTING — exactly the contract driveTick checks.
 */
function fixture(rows = READY_TSV): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pressure-gate-'));
  mkdirSync(join(dir, 'queue'));
  const readyFile = join(dir, 'queue', 'ready.tsv');
  writeFileSync(readyFile, rows);
  let level: DrivePressureLevel | null = 'normal';
  const snapshot = async (): Promise<DriveSnapshot> => {
    const jobs: DriveJob[] = parseReadyTsv(readFileSync(readyFile, 'utf8')).rows
      .filter((row): row is typeof row & { id: string } => row.id !== null)
      .map(row => ({
        id: row.id, pool: row.pool, priority: Number.parseInt(row.priority ?? '0', 10) || 0,
        state: RUNNING_STATES.has(row.status) ? row.status as DriveJob['state'] : row.status === 'READY' ? 'READY' : 'HELD',
      }));
    return { version: 1, maxRunning: 5, paused: false, admission: 'open',
      pools: [{ id: 'codex-cmp', floor: 0, ceiling: 5 }], jobs };
  };
  const bridge: DriveBridge = {
    snapshot,
    acquire: vi.fn(async () => 'lease'),
    reap: vi.fn(async () => {}),
    launch: vi.fn(async (_lease, id) => {
      const lines = readFileSync(readyFile, 'utf8').split('\n');
      const at = lines.findIndex(line => line.split('\t')[0] === id);
      if (at < 0) return 'held';
      const cells = lines[at]!.split('\t');
      cells[1] = 'STARTING';
      lines[at] = cells.join('\t');
      writeFileSync(readyFile, lines.join('\n'));
      return 'launched';
    }),
    reservePublish: vi.fn(async () => false),
    finishPublish: vi.fn(async () => {}),
    writeStatus: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const deps: DriveDependencies = {
    bridge,
    paused: vi.fn(async () => false),
    publish: vi.fn(async () => {}),
    now: () => NOW,
    pressure: async () => level,
    liveWorkers: async () => parsePsTable(PS_TABLE).workers,
  };
  return { dir, deps, bridge, setLevel: next => { level = next; } };
}

describe('memory pressure launch gate — the real tick decision path', () => {
  it('normal pressure launches ready work up to the free slots', async () => {
    const f = fixture();
    try {
      // 3 workers running, maxRunning 5 → exactly two free slots.
      const report = await driveTick(f.deps);
      expect(report.pressure).toBe('normal');
      expect(report.held).toBeNull();
      expect(report.planned).toEqual(['RQ-PHX-ALPHA', 'RQ-PHX-BETA']);
      expect(report.launched).toEqual(['RQ-PHX-ALPHA', 'RQ-PHX-BETA']);
      expect(report.pauseWorkers).toEqual([]);
      expect(f.bridge.launch).toHaveBeenCalledTimes(2);
      // The third ready line stayed queued — the free slots were the bound.
      expect(readFileSync(join(f.dir, 'queue', 'ready.tsv'), 'utf8')).toContain('RQ-PHX-GAMMA\tREADY');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('warning pressure launches nothing and the reason names memory pressure', async () => {
    const f = fixture();
    f.setLevel('warning');
    try {
      const report = await driveTick(f.deps);
      expect(report.pressure).toBe('warning');
      expect(report.launched).toEqual([]);
      expect(report.planned).toEqual([]);
      expect(report.held).toBe('memory-pressure');
      expect(report.pauseWorkers).toEqual([]);
      expect(f.bridge.launch).not.toHaveBeenCalled();
      // Queue state is untouched — the hold is a decision, not a mutation.
      expect(readFileSync(join(f.dir, 'queue', 'ready.tsv'), 'utf8')).toBe(READY_TSV);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('critical pressure pauses the newest, lowest-value workers and never names a GUI app', async () => {
    const f = fixture();
    f.setLevel('critical');
    try {
      const report = await driveTick(f.deps);
      expect(report.pressure).toBe('critical');
      expect(report.launched).toEqual([]);
      expect(report.held).toBe('memory-pressure');
      expect(f.bridge.launch).not.toHaveBeenCalled();
      // NEW and MID tie at 30s → lower value (priority 5 vs 9) first; OLD is oldest.
      expect(report.pauseWorkers).toEqual(['RQ-PHX-MID', 'RQ-PHX-NEW', 'RQ-PHX-OLD']);
      for (const app of ['Phantom', 'Cursor', 'ChatGPT', 'Codex', 'Grok Bot']) {
        expect(report.pauseWorkers).not.toContain(app);
      }
      expect(report.pauseWorkers.join(',')).not.toMatch(/Phantom|Cursor|ChatGPT|Codex|Grok Bot/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('a missing or malformed reading holds launches but pauses nobody', async () => {
    const f = fixture();
    f.setLevel(null);
    try {
      const report = await driveTick(f.deps);
      expect(report.launched).toEqual([]);
      expect(report.held).toBe('memory-pressure');
      expect(report.pauseWorkers).toEqual([]);
      expect(f.bridge.launch).not.toHaveBeenCalled();
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('warning then normal: launches resume on the next tick with no manual step', async () => {
    const f = fixture();
    f.setLevel('warning');
    try {
      const held = await driveTick(f.deps);
      expect(held.launched).toEqual([]);
      expect(held.held).toBe('memory-pressure');
      f.setLevel('normal');
      // Nothing was latched and nothing needs clearing — the next tick reads
      // the new level and fills the same two free slots.
      const resumed = await driveTick(f.deps);
      expect(resumed.pressure).toBe('normal');
      expect(resumed.held).toBeNull();
      expect(resumed.launched).toEqual(['RQ-PHX-ALPHA', 'RQ-PHX-BETA']);
      expect(f.bridge.launch).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it('ignores malformed workers and orders unknown ages after finite ages', async () => {
    const f = fixture();
    f.setLevel('critical');
    f.deps.liveWorkers = async () => [null, { job: 'RQ-PHX-NEW', ageSeconds: Infinity },
      { job: 'RQ-PHX-MID', ageSeconds: 30 }, { job: 'Cursor', ageSeconds: 1 }] as never;
    try {
      const report = await driveTick(f.deps);
      expect(report.pauseWorkers).toEqual(['RQ-PHX-MID', 'RQ-PHX-NEW']);
      expect(pressurePauseOrder([{ job: 'a', ageSeconds: null }, { job: 'b', ageSeconds: 3 },
        { job: 'b', ageSeconds: 1 }], () => 0)).toEqual(['b', 'a']);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('demonstrates absent host pressure callback permits launches', async () => {
    const f = fixture();
    delete f.deps.pressure;
    try {
      const report = await driveTick(f.deps);
      expect(report.pressure).toBe('normal');
      expect(report.launched).toEqual(['RQ-PHX-ALPHA', 'RQ-PHX-BETA']);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

});

// Exercise the actual CLI composition and ScriptDriveBridge launch method with a
// hermetic host transport; no host executable or system telemetry is touched.
const integration = vi.hoisted(() => ({ levels: [] as string[], operations: [] as string[], state: 'READY' }));
vi.mock('../src/core/drive/host-pressure.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/drive/host-pressure.js')>();
  return { ...actual, readDrivePressure: async () => integration.levels.shift() ?? 'warning' };
});
vi.mock('../src/core/drive/script-bridge.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/drive/script-bridge.js')>();
  return { ...actual, checkDrivePublisher: async () => {}, ScriptDriveBridge: class extends actual.ScriptDriveBridge {
    constructor(path: string, _command: unknown, _check: unknown, pressure: () => Promise<DrivePressureLevel>) {
      super(path, async (_exe, args) => {
        const op = args[0]!;
        integration.operations.push(op);
        let result: unknown = true;
        if (op === 'acquire') result = '0123456789abcdef';
        if (op === 'snapshot') result = { version: 1, pools: [{ id: 'codex-cmp', floor: 1, ceiling: 1 }],
          maxRunning: 1, paused: false, admission: 'open', jobs: [{ id: 'RQ-PHX-ALPHA', pool: 'codex-cmp', state: integration.state, priority: 1 }] };
        if (op === 'launch') { integration.state = 'STARTING'; result = 'launched'; }
        return JSON.stringify({ protocol: 'phm-drive/v1', result });
      }, async () => {}, pressure);
    }
  } };
});

it('built-in CLI holds warning, resumes on normal, and rechecks before host launch', async () => {
  const { cmdDrive } = await import('../src/cli/drive.js');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    integration.state = 'READY'; integration.operations = []; integration.levels = ['warning'];
    expect(await cmdDrive(['--once'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ pressure: 'warning', held: 'memory-pressure', launched: [] });
    expect(integration.operations).not.toContain('launch');
    integration.operations = []; integration.levels = ['normal', 'warning'];
    expect(await cmdDrive(['--once'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ pressure: 'normal', held: 'launch-held', launched: [] });
    expect(integration.operations).not.toContain('launch');
    integration.operations = []; integration.levels = ['normal', 'normal'];
    expect(await cmdDrive(['--once'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ pressure: 'normal', launched: ['RQ-PHX-ALPHA'] });
    expect(integration.operations.filter(op => op === 'launch')).toHaveLength(1);
  } finally { output.mockRestore(); }
});

it('classifies only known normal kernel pressure with permitted headroom as normal', async () => {
  const { classifyDrivePressure } = await import('../src/core/drive/host-pressure.js');
  const healthy = { allowed: true, reading: { freePercent: 50, swapGb: 0 }, reason: null };
  expect(classifyDrivePressure('1', healthy)).toBe('normal');
  expect(classifyDrivePressure('2', healthy)).toBe('warning');
  expect(classifyDrivePressure('4', healthy)).toBe('critical');
  for (const value of [null, '', '3', 'garbage']) expect(classifyDrivePressure(value, healthy)).toBe('warning');
  expect(classifyDrivePressure('1', { ...healthy, allowed: false })).toBe('warning');
  expect(classifyDrivePressure('1', { ...healthy, reading: null })).toBe('warning');
});

// Exercise the actual bounded reader, bypassing only this file's CLI-composition
// mock. Neither the host platform nor any real telemetry command is changed.
it.each(['linux', 'win32'] as const)('retains %s admission without macOS telemetry', async platform => {
  const { readDrivePressure } = await vi.importActual<typeof import('../src/core/drive/host-pressure.js')>('../src/core/drive/host-pressure.js');
  const exec = vi.fn(() => { throw new Error('macOS command must not run'); });
  const headroom = vi.fn(() => { throw new Error('macOS sample must not run'); });
  expect(await readDrivePressure({ platform, exec: exec as never, headroom })).toBe('normal');
  expect(exec).not.toHaveBeenCalled();
  expect(headroom).not.toHaveBeenCalled();
});

it.each([['1\n', 'normal'], ['2\n', 'warning'], ['4\n', 'critical'], ['garbage\n', 'warning']] as const)(
  'uses bounded Darwin telemetry %s as %s', async (kernel, expected) => {
    const { readDrivePressure } = await vi.importActual<typeof import('../src/core/drive/host-pressure.js')>('../src/core/drive/host-pressure.js');
    const exec = vi.fn(() => kernel);
    const headroom = vi.fn(() => ({ allowed: true, reading: { freePercent: 50, swapGb: 0 }, reason: null }));
    expect(await readDrivePressure({ platform: 'darwin', exec: exec as never, headroom })).toBe(expected);
    expect(exec).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(headroom).toHaveBeenCalledOnce();
  });

it('holds Darwin when the bounded kernel reader fails', async () => {
  const { readDrivePressure } = await vi.importActual<typeof import('../src/core/drive/host-pressure.js')>('../src/core/drive/host-pressure.js');
  const exec = vi.fn(() => { throw new Error('synthetic telemetry failure'); });
  const headroom = vi.fn(() => { throw new Error('must not sample after failed read'); });
  expect(await readDrivePressure({ platform: 'darwin', exec: exec as never, headroom })).toBe('warning');
  expect(headroom).not.toHaveBeenCalled();
});
