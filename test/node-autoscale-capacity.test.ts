import { describe, expect, it } from 'vitest';
import { childrenFromRows, harnessFor, harnessSessions, type ProcessRow } from '../src/core/drive/nodes/harness-adapters.js';
import { CAPACITY_POLICY, computeNodeCapacity, parseNodeCapacityDoc, type NodeSnapshot } from '../src/core/drive/nodes/capacity-model.js';
import {
  cpuBusyPercent, measureNode, parseFootprint, parsePgrepList, parsePsRows, parseSwapTotal, parseSwapouts, type MeasureHost,
} from '../src/core/drive/nodes/node-measure.js';
import { MEMORY_GUARD } from '../src/core/resources/lane-autopilot.js';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
const T0 = Date.parse('2026-11-16T05:10:00.000Z');

/** Recorded on the main MBP (128 GiB, 18 cores) at 2026-11-16 00:10 ET by this lane: vm_stat, memory_pressure, sysctl. */
const MBP_RECORDED = {
  totalBytes: 137438953472,
  vmStat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                   265797.\nPages speculative:                            221999.\nSwapouts:                                  1520000.\n',
  pressure: 'The system has 137438953472 (8388608 pages with a page size of 16384).\nSystem-wide memory free percentage: 43%\n',
  swap: 'vm.swapusage: total = 8192.00M  used = 7113.31M  free = 1078.69M  (encrypted)\n',
  load: [214.56, 115.14, 89.08],
};

function snap(over: Partial<NodeSnapshot> & { sessions?: NodeSnapshot['sessions'] } = {}): NodeSnapshot {
  return {
    node: 'mbp', measuredAtMs: T0, platform: 'darwin',
    cpu: { cores: 18, load: [10, 10, 10], busyPercent: 50 },
    mem: { totalBytes: 128 * GIB, freeBytes: 40 * GIB, freePercent: 43, pressureLevel: 1 },
    swap: { usedBytes: 7 * GIB, totalBytes: 8 * GIB, swapoutsTotal: 1_000 },
    processSource: 'ps',
    sessions: [
      { harness: 'codex', rootPid: 10, processes: 5, memBytes: 400 * MIB, cpuPercent: 30 },
      { harness: 'codex', rootPid: 11, processes: 4, memBytes: 600 * MIB, cpuPercent: 50 },
      { harness: 'grok', rootPid: 20, processes: 2, memBytes: 150 * MIB, cpuPercent: 5 },
    ],
    ...over,
  };
}

it.each([[81.25, 0.30, 3], [81.375, 0.29, 2]])(
  'counts CPU-limited sessions at %s%% host utilization', (busyPercent, headroom, expected) => {
    const doc = computeNodeCapacity(snap({
      cpu: { cores: 8, load: null, busyPercent },
      sessions: [{ harness: 'codex', rootPid: 10, processes: 1, memBytes: 400 * MIB, cpuPercent: 10 }],
    }));
    expect(doc.cpu.headroom_cores).toBe(headroom);
    expect(doc.agents_runnable_now.codex).toBe(expected);
  },
);

describe('harness adapters', () => {
  it('maps CLI kernel names to company-agnostic harness ids and ignores desktop apps', () => {
    expect(harnessFor('codex')?.id).toBe('codex');
    expect(harnessFor('2.1.321')?.id).toBe('claude');
    expect(harnessFor('grok-native')?.id).toBe('grok');
    expect(harnessFor('cursor-agent')?.id).toBe('cursor');
    expect(harnessFor('llama-server')?.kind).toBe('local-model');
    for (const app of ['Claude', 'Codex', 'Grok', 'Devin', 'node', 'Python', '2.1']) expect(harnessFor(app)).toBeNull();
  });

  it('counts a CLI with its MCP children as one session and never double-counts a nested harness', () => {
    const rows: ProcessRow[] = [
      { pid: 100, ppid: 1, name: 'codex', memBytes: 200 * MIB, cpuPercent: 10 },
      { pid: 101, ppid: 100, name: 'codex', memBytes: 50 * MIB, cpuPercent: 1 },   // re-exec, same session
      { pid: 102, ppid: 100, name: 'node', memBytes: 80 * MIB, cpuPercent: 2 },    // MCP server
      { pid: 103, ppid: 102, name: 'Python', memBytes: 20 * MIB, cpuPercent: 0 },
      { pid: 104, ppid: 100, name: '2.1.321', memBytes: 300 * MIB, cpuPercent: 4 }, // claude spawned by codex: own session
      { pid: 105, ppid: 104, name: 'node', memBytes: 60 * MIB, cpuPercent: 1 },
      { pid: 200, ppid: 1, name: 'Codex', memBytes: 900 * MIB, cpuPercent: 3 },     // desktop app, not a session
    ];
    const sessions = harnessSessions(rows, childrenFromRows(rows));
    expect(sessions).toEqual([
      { harness: 'codex', rootPid: 100, processes: 4, memBytes: 350 * MIB, cpuPercent: 13 },
      { harness: 'claude', rootPid: 104, processes: 2, memBytes: 360 * MIB, cpuPercent: 5 },
    ]);
  });

  it('marks a session unmeasured when one live process is unreadable, and skips exited ones', () => {
    const rows: ProcessRow[] = [
      { pid: 1, ppid: null, name: 'devin', memBytes: 100, cpuPercent: null },
      { pid: 2, ppid: null, name: 'node', memBytes: null, cpuPercent: null },
      { pid: 5, ppid: null, name: 'grok', memBytes: 10, cpuPercent: null },
    ];
    const sessions = harnessSessions(rows, new Map([[1, [2]], [5, [6]]]));   // pid 6 exited
    expect(sessions.find(s => s.harness === 'devin')?.memBytes).toBeNull();
    expect(sessions.find(s => s.harness === 'grok')?.memBytes).toBe(10);
  });
});

describe('measurement parsers (recorded host output)', () => {
  it('parses ps, pgrep, footprint and swap counters', () => {
    expect(parsePsRows('  10     1  2048  12.5 codex\n  11    10  1024   0.0 Google Chrome He\n')).toEqual([
      { pid: 10, ppid: 1, name: 'codex', memBytes: 2048 * 1024, cpuPercent: 12.5 },
      { pid: 11, ppid: 10, name: 'Google Chrome He', memBytes: 1024 * 1024, cpuPercent: 0 },
    ]);
    expect(parsePsRows('garbage')).toBeNull();
    expect(parsePgrepList('270 codex\n6648 2.1.321\n\n')).toEqual([{ pid: 270, name: 'codex' }, { pid: 6648, name: '2.1.321' }]);
    // Recorded from `footprint --noCategories -f bytes -p 270` on the main MBP.
    expect(parseFootprint('codex [270]: 64-bit    Footprint: 173213064 B (16384 bytes per page)\nAuxiliary data:\n    phys_footprint: 173229448 B\n    phys_footprint_peak: 366249712 B\n')).toBe(173229448);
    expect(parseFootprint('footprint: Must run as root.')).toBeNull();
    expect(parseSwapouts(MBP_RECORDED.vmStat)).toBe(1520000);
    expect(parseSwapTotal(MBP_RECORDED.swap)).toBe(8 * GIB);
  });

  it('computes CPU busy percent from counter deltas and refuses mismatched samples', () => {
    const core = (busy: number, idle: number) => ({ model: '', speed: 0, times: { user: busy, nice: 0, sys: 0, irq: 0, idle } });
    expect(cpuBusyPercent([core(0, 0), core(0, 0)], [core(75, 25), core(25, 75)])).toBe(50);
    expect(cpuBusyPercent([core(0, 0)], [core(1, 1), core(1, 1)])).toBeNull();
  });

  it('measures through the pgrep + footprint fallback when ps is denied', async () => {
    let cpuCalls = 0;
    const run = async (file: string, args: string[]): Promise<string | null> => {
      if (file === '/bin/ps') return null;   // EPERM in sandboxed lanes
      if (file === '/usr/bin/vm_stat') return MBP_RECORDED.vmStat;
      if (file === '/usr/bin/memory_pressure') return MBP_RECORDED.pressure;
      if (file === '/usr/sbin/sysctl') return args[0] === '-n' ? '1\n' : MBP_RECORDED.swap;
      if (file === '/usr/bin/pgrep' && args[0] === '-l') return '270 codex\n300 node\n6648 2.1.321\n900 Codex\n';
      if (file === '/usr/bin/pgrep' && args[0] === '-P') return ({ '270': '300\n', '300': '', '6648': '' } as Record<string, string>)[args[1]!] ?? '';
      if (file === '/usr/bin/footprint') {
        const bytes = ({ '270': 173229448, '300': 80 * MIB, '6648': 420 * MIB } as Record<string, number>)[args.at(-1)!];
        return bytes === undefined ? null : `    phys_footprint: ${bytes} B\n`;
      }
      return null;
    };
    const host: MeasureHost = {
      platform: 'darwin', now: () => T0, hostname: () => 'MacBook-Pro-2.local', loadavg: () => MBP_RECORDED.load,
      totalmem: () => MBP_RECORDED.totalBytes, freemem: () => 0, sleep: async () => {}, run,
      cpus: () => {
        const later = cpuCalls++ > 0;
        return Array.from({ length: 18 }, () => ({ model: '', speed: 0, times: { user: later ? 95 : 0, nice: 0, sys: 0, irq: 0, idle: later ? 5 : 0 } }));
      },
    };
    const s = await measureNode({ host });
    expect(s.node).toBe('MacBook-Pro-2');
    expect(s.processSource).toBe('pgrep+footprint');
    expect(s.sessions).toEqual([
      { harness: 'codex', rootPid: 270, processes: 2, memBytes: 173229448 + 80 * MIB, cpuPercent: null },
      { harness: 'claude', rootPid: 6648, processes: 1, memBytes: 420 * MIB, cpuPercent: null },
    ]);
    expect(s.mem).toEqual({ totalBytes: MBP_RECORDED.totalBytes, freeBytes: (265797 + 221999) * 16384, freePercent: 43, pressureLevel: 1 });
    expect(s.swap.usedBytes).toBe(Math.round(7113.31 / 1024 * GIB));
    expect(s.cpu.busyPercent).toBe(95);
  });
});

describe('Linux /proc measurement', () => {
  const MEMINFO = `MemTotal:       16777216 kB
MemFree:         1048576 kB
MemAvailable:    8388608 kB
Buffers:          524288 kB
SwapTotal:       2097152 kB
SwapFree:        1048576 kB
`;
  const PSI_NORMAL = `some avg10=2.50 avg60=1.00 avg300=0.50 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
  const PSI_WARN = `some avg10=15.00 avg60=9.00 avg300=4.00 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
  const VMSTAT = `pswpin 100\npswpout 4242\npgpgin 999999\n`;
  const PS = '  10     1 102400  5.0 codex\n  11    10  51200  1.0 node\n';
  const TOTAL = 16 * GIB;

  function linuxHost(files: Record<string, string | null>, withReadFile = true): MeasureHost {
    const host: MeasureHost = {
      platform: 'linux', now: () => T0, hostname: () => 'linux-box', loadavg: () => [1, 2, 3],
      totalmem: () => TOTAL, freemem: () => 8 * GIB, sleep: async () => {},
      run: async file => file === '/bin/ps' ? PS : null,
      cpus: () => Array.from({ length: 8 }, () => ({ model: '', speed: 0, times: { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 } })),
    };
    if (withReadFile) host.readFile = async path => files[path] ?? null;
    return host;
  }

  it('reads MemAvailable, swap and PSI from /proc so the capacity doc is measured', async () => {
    const s = await measureNode({ host: linuxHost({ '/proc/meminfo': MEMINFO, '/proc/pressure/memory': PSI_NORMAL, '/proc/vmstat': VMSTAT }) });
    expect(s.platform).toBe('linux');
    expect(s.processSource).toBe('ps');
    expect(s.mem).toEqual({ totalBytes: TOTAL, freeBytes: 8 * GIB, freePercent: 50, pressureLevel: 1 });
    expect(s.swap).toEqual({ usedBytes: GIB, totalBytes: 2 * GIB, swapoutsTotal: 4242 });
    // Before the /proc reader every Linux harness reported unmeasured; now the model
    // derives a real runnable count from headroom and the measured codex footprint
    // (codex pid 10 plus its node child pid 11: 150 MiB; headroom (50-30)% of 16 GiB).
    const doc = computeNodeCapacity(s);
    expect(doc.mem_free).toMatchObject({ free_percent: 50, pressure_level: 1 });
    expect(doc.swap).toMatchObject({ used_bytes: GIB, total_bytes: 2 * GIB, swapouts_total: 4242 });
    expect(doc.agents_runnable_now.codex).toBe(21);
    expect(doc.basis.limiting.codex).toBe('memory');
  });

  it('maps PSI some avg10 onto the admission bands and fails closed when /proc is unreadable', async () => {
    const warn = await measureNode({ host: linuxHost({ '/proc/meminfo': MEMINFO, '/proc/pressure/memory': PSI_WARN, '/proc/vmstat': VMSTAT }) });
    expect(warn.mem.pressureLevel).toBe(2);
    const doc = computeNodeCapacity(warn);
    expect(doc.agents_runnable_now.codex).toBe(0);
    expect(doc.basis.limiting.codex).toBe('pressure');

    const noPsi = await measureNode({ host: linuxHost({ '/proc/meminfo': MEMINFO, '/proc/pressure/memory': null, '/proc/vmstat': VMSTAT }) });
    expect(noPsi.mem.pressureLevel).toBeNull();
    expect(computeNodeCapacity(noPsi).agents_runnable_now.codex).toBeNull();

    // An injected host with no readFile at all keeps every Linux reading unknown.
    const blind = await measureNode({ host: linuxHost({}, false) });
    expect(blind.mem.pressureLevel).toBeNull();
    expect(blind.swap).toEqual({ usedBytes: null, totalBytes: null, swapoutsTotal: null });
    expect(computeNodeCapacity(blind).agents_runnable_now.codex).toBeNull();
  });
});

describe('capacity model', () => {
  it('derives headroom above the memguard raise line and per-harness runnable from measured footprints', () => {
    expect(CAPACITY_POLICY.memReserveFreePct).toBe(MEMORY_GUARD.raiseFreePct);
    const doc = computeNodeCapacity(snap());
    // (43% - 30%) of 128 GiB
    expect(doc.mem_free.headroom_bytes).toBe(Math.floor(128 * GIB * 0.13));
    // 18 * 0.85 - 9 busy cores
    expect(doc.cpu.headroom_cores).toBe(6.3);
    expect(doc.per_harness_footprint.codex).toMatchObject({ sessions: 2, mem_bytes_max: 600 * MIB, mem_bytes_median: 500 * MIB, cpu_cores_per_session: 0.4, source: 'measured' });
    // memory: 16.64 GiB / 600 MiB = 28; cpu: 6.3 / 0.4 = 15 -> cpu-limited
    expect(doc.agents_runnable_now.codex).toBe(15);
    expect(doc.basis.limiting.codex).toBe('cpu');
    // grok: 16.64 GiB / 150 MiB = 113; cpu 6.3 / 0.05 = 126 -> memory-limited, not throttled to 1 by a host backoff
    expect(doc.agents_runnable_now.grok).toBe(113);
    expect(doc.basis.limiting.grok).toBe('memory');
    // never-observed harness: unknown, not zero and not a guess
    expect(doc.agents_runnable_now.devin).toBeNull();
    expect(doc.basis.limiting.devin).toBe('unmeasured');
    expect(doc.swap.growing).toBeNull();
    // A model server is not an agent session: never a runnable count, sized per model by the router.
    const served = computeNodeCapacity(snap({ sessions: [{ harness: 'local-model', rootPid: 9, processes: 2, memBytes: 14 * MIB, cpuPercent: 1 }] }));
    expect(served.agents_runnable_now['local-model']).toBeNull();
    expect(served.basis.notes.some(n => n.includes('mmapped'))).toBe(true);
    expect(parseNodeCapacityDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  it('keeps a measured rate just below the swap-growth threshold runnable', () => {
    const prev = computeNodeCapacity(snap());
    const doc = computeNodeCapacity(snap({
      measuredAtMs: T0 + 60_001,
      swap: { ...snap().swap, swapoutsTotal: 1_000 + MEMORY_GUARD.growingSwapoutsPerMin },
    }), prev);

    expect(doc.swap.swapouts_per_min).toBeLessThan(MEMORY_GUARD.growingSwapoutsPerMin);
    expect(doc.swap.growing).toBe(false);
    expect(doc.agents_runnable_now.codex).toBeGreaterThan(0);
  });

  it('keeps the integrity gates: kernel pressure and swap growth stop every harness', () => {
    const warn = computeNodeCapacity(snap({ mem: { totalBytes: 128 * GIB, freeBytes: null, freePercent: 60, pressureLevel: 2 } }));
    expect(Object.values(warn.agents_runnable_now).every(n => n === 0)).toBe(true);
    expect(warn.basis.limiting.grok).toBe('pressure');
    const prev = computeNodeCapacity(snap());
    const later = snap({ measuredAtMs: T0 + 60_000, swap: { usedBytes: 7.5 * GIB, totalBytes: 8 * GIB, swapoutsTotal: 1_000 + MEMORY_GUARD.growingSwapoutsPerMin } });
    const grown = computeNodeCapacity(later, prev);
    expect(grown.swap).toMatchObject({ swapouts_per_min: 100, growing: true, growth_bytes_per_min: 0.5 * GIB });
    expect(grown.agents_runnable_now.codex).toBe(0);
    expect(grown.basis.limiting.codex).toBe('swap-growth');
    // Parked swap that is not growing never blocks (memguard rule), even near full.
    const parked = computeNodeCapacity(snap({ measuredAtMs: T0 + 60_000, swap: { usedBytes: 7.9 * GIB, totalBytes: 8 * GIB, swapoutsTotal: 1_005 } }), prev);
    expect(parked.swap.growing).toBe(false);
    expect(parked.agents_runnable_now.codex).toBe(15);
  });

  it('ignores a rebooted counter, a stale or foreign previous sample', () => {
    const prev = computeNodeCapacity(snap());
    expect(computeNodeCapacity(snap({ measuredAtMs: T0 + 60_000, swap: { usedBytes: 1, totalBytes: 1, swapoutsTotal: 5 } }), prev).swap.swapouts_per_min).toBeNull();
    expect(computeNodeCapacity(snap({ measuredAtMs: T0 + CAPACITY_POLICY.maxDeltaMs + 1 }), prev).swap.swapouts_per_min).toBeNull();
    expect(computeNodeCapacity(snap({ node: 'air', measuredAtMs: T0 + 60_000 }), prev).swap.swapouts_per_min).toBeNull();
  });

  it('reuses a learned footprint when no session is live, until it expires', () => {
    const prev = computeNodeCapacity(snap());
    const idle = computeNodeCapacity(snap({ measuredAtMs: T0 + 3_600_000, sessions: [] }), prev);
    expect(idle.per_harness_footprint.codex).toMatchObject({ source: 'learned', sessions: 0, mem_bytes_max: 600 * MIB, learned_at: prev.measured_at });
    expect(idle.agents_runnable_now.codex).not.toBeNull();
    const chained = computeNodeCapacity(snap({ measuredAtMs: T0 + CAPACITY_POLICY.learnedFootprintTtlMs + 1, sessions: [] }), idle);
    expect(chained.per_harness_footprint.codex).toBeUndefined();
    expect(chained.agents_runnable_now.codex).toBeNull();
  });

  it.each([false, true])('handles zero RSS without invalidating the capacity document (previous sample: %s)', usePrevious => {
    const baseline = snap();
    const previous = usePrevious ? computeNodeCapacity(baseline) : null;
    const doc = computeNodeCapacity(snap({
      measuredAtMs: T0 + 60_000,
      sessions: baseline.sessions!.map(session => session.harness === 'codex' ? { ...session, memBytes: 0 } : session),
    }), previous);

    expect(parseNodeCapacityDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(doc.agents_runnable_now.grok).toBeGreaterThan(0);
    expect(doc.agents_runnable_now.codex).toBe(previous?.agents_runnable_now.codex ?? null);
    if (previous) {
      expect(doc.per_harness_footprint.codex).toMatchObject({ source: 'learned', learned_at: previous.measured_at });
    } else {
      expect(doc.per_harness_footprint.codex).toBeUndefined();
    }
  });

  it('charges host busy cores per session when the process source has no CPU column', () => {
    const doc = computeNodeCapacity(snap({ processSource: 'pgrep+footprint', cpu: { cores: 18, load: [214.56, 115.14, 89.08], busyPercent: 95 },
      sessions: [{ harness: 'codex', rootPid: 1, processes: 3, memBytes: 500 * MIB, cpuPercent: null }] }));
    expect(doc.per_harness_footprint.codex?.cpu_cores_per_session).toBe(17.1);
    expect(doc.cpu.headroom_cores).toBe(0);
    expect(doc.agents_runnable_now.codex).toBe(0);
    expect(doc.basis.limiting.codex).toBe('cpu');
    expect(doc.cpu.run_queue_per_core).toBe(11.92);
    expect(doc.basis.notes.some(n => n.includes('upper bound'))).toBe(true);
  });

  it('fails closed on unknown pressure, and on an unreadable process table', () => {
    const unknown = computeNodeCapacity(snap({ mem: { totalBytes: 128 * GIB, freeBytes: 1, freePercent: 50, pressureLevel: null } }));
    expect(Object.values(unknown.agents_runnable_now).every(n => n === null)).toBe(true);
    const blind = computeNodeCapacity(snap({ processSource: 'unavailable', sessions: null }));
    expect(blind.basis.live_sessions).toBeNull();
    expect(blind.agents_runnable_now.codex).toBeNull();
  });

  it('rejects malformed documents', () => {
    const doc = JSON.parse(JSON.stringify(computeNodeCapacity(snap())));
    expect(parseNodeCapacityDoc({ ...doc, schema: 'x' })).toBeNull();
    expect(parseNodeCapacityDoc({ ...doc, node: '../etc' })).toBeNull();
    expect(parseNodeCapacityDoc({ ...doc, agents_runnable_now: { codex: -1 } })).toBeNull();
    expect(parseNodeCapacityDoc({ ...doc, per_harness_footprint: { codex: { mem_bytes_max: 0, cpu_cores_per_session: null } } })).toBeNull();
    expect(parseNodeCapacityDoc(null)).toBeNull();
  });

  it('requires valid routing measurements and accepts explicit unknowns', () => {
    const doc = computeNodeCapacity(snap());
    expect(parseNodeCapacityDoc({ ...doc, cpu: {} })).toBeNull();
    expect(parseNodeCapacityDoc({ ...doc, cpu: { ...doc.cpu, headroom_cores: '0' } })).toBeNull();
    expect(parseNodeCapacityDoc({ ...doc, mem_free: { ...doc.mem_free, headroom_bytes: -1 } })).toBeNull();
    expect(parseNodeCapacityDoc({ ...doc, mem_free: { ...doc.mem_free, pressure_level: '2' } })).toBeNull();
    expect(parseNodeCapacityDoc({ ...doc, swap: { ...doc.swap, growing: 'true' } })).toBeNull();
    const unknown = {
      ...doc,
      cpu: { ...doc.cpu, headroom_cores: null },
      mem_free: { ...doc.mem_free, headroom_bytes: null, pressure_level: null },
      swap: { ...doc.swap, growing: null },
    };
    expect(parseNodeCapacityDoc(unknown)).toEqual(unknown);
  });
});

describe('phm node capacity / route CLI', () => {
  it('writes the document atomically with mode 0600 and refuses a non-file target', async () => {
    const { mkdtempSync, statSync, readFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeCapacityDoc } = await import('../src/cli/node-capacity.js');
    const dir = mkdtempSync(join(tmpdir(), 'node-cap-'));
    const doc = computeNodeCapacity(snap());
    await writeCapacityDoc(join(dir, 'node-capacity.json'), doc);
    expect(statSync(join(dir, 'node-capacity.json')).mode & 0o777).toBe(0o600);
    expect(parseNodeCapacityDoc(JSON.parse(readFileSync(join(dir, 'node-capacity.json'), 'utf8')))).toEqual(doc);
    mkdirSync(join(dir, 'taken'));
    await expect(writeCapacityDoc(join(dir, 'taken'), doc)).rejects.toThrow(/not a regular file/);
  });

  it('routes from files and reports JSON', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { cmdNodeRoute } = await import('../src/cli/node-capacity.js');
    const dir = mkdtempSync(join(tmpdir(), 'node-route-'));
    const file = (name: string, value: unknown) => { writeFileSync(join(dir, name), JSON.stringify(value)); return join(dir, name); };
    const doc = computeNodeCapacity(snap({ measuredAtMs: Date.now() }));
    const cap = file('cap.json', doc);
    const malformed = file('malformed.json', { ...doc, cpu: { ...doc.cpu, headroom_cores: '0' } });
    const costs = file('costs.json', [{ provider: 'grok', model: 'grok-5', harness: 'grok', tokensPerJob: 1e6, minutesPerJob: 20 }]);
    const jobs = file('jobs.json', [{ id: 'j1' }]);
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      expect(await cmdNodeRoute(['--capacity', cap, '--costs', costs, '--jobs', jobs, '--json'])).toBe(0);
      expect(await cmdNodeRoute(['--capacity', costs, '--costs', costs, '--jobs', jobs, '--json'])).toBe(2);
      expect(await cmdNodeRoute(['--capacity', malformed, '--costs', costs, '--jobs', jobs, '--json'])).toBe(2);
      expect(await cmdNodeRoute(['--bogus', '--json'])).toBe(2);
    } finally { console.log = log; }
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: 'phantom.node-route.v1', plan: [{ jobId: 'j1', nodeId: 'mbp', provider: 'grok' }] });
    expect(JSON.parse(lines[1]!).error.message).toMatch(/node-capacity\.v1/);
    expect(JSON.parse(lines[2]!).error.message).toMatch(/node-capacity\.v1/);
  });
});
