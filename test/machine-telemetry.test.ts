import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CpuInfo } from 'node:os';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineHeadroom, sampleMachine, type TelemetryHost } from '../src/core/resources/telemetry.js';
import { machineTelemetryEnabled, sampleMachineForDispatch } from '../src/core/resources/telemetry-store.js';
import {
  parseAccelerators, parseDisks, parseLinuxMemory, parseMacSwap, parseMemoryPressure,
  parsePs, parseQueueStatus, parseVmStat, sumJobTrees,
} from '../src/core/resources/telemetry-parsers.js';

const KiB = 1024, MiB = KiB ** 2;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1024.
Pages active:                             8192.
Pages inactive:                           4096.
Pages speculative:                         256.
Pageouts:                                   13.
`;
const MEMORY_PRESSURE = `The system has 16384 pages with a page size of 16384.
System-wide memory free percentage: 38%
`;
const LINUX_MEMORY = `MemTotal:       1048576 kB
MemFree:          32768 kB
MemAvailable:    524288 kB
SwapTotal:       262144 kB
SwapFree:        196608 kB
`;
const PS = `    1     0   0.1    1024
  100     1  25.0    2048
  101   100  50.0    4096
  102   101   2.5    1024
  200     1  10.0     512
`;
const DF = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1 100000 20000 80000 20% /
/dev/disk4s1 50000 10000 40000 20% /Volumes/Work Files
`;
const STATUS = JSON.stringify({ memguard: { state: 'running' }, running: [{ pid: 100 }, { pid: 200 }] });

function cpu(user = 100, idle = 900): CpuInfo {
  return { model: 'TEST CPU', speed: 2400, times: { user, idle, nice: 0, sys: 0, irq: 0 } };
}

function fixtureHost(platform = 'darwin') {
  let at = 1000, cores = [cpu(), cpu()];
  const calls: Array<{ file: string; args: string[] }> = [];
  const commands = new Map<string, string | null>([
    ['/bin/ps', PS], ['/bin/df', DF], ['/usr/bin/vm_stat', VM_STAT],
    ['/usr/bin/memory_pressure', MEMORY_PRESSURE],
    ['/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', '1\n'],
    ['/usr/sbin/sysctl vm.swapusage', 'vm.swapusage: total = 256.00M  used = 64.00M  free = 192.00M (encrypted)'],
    ['/usr/bin/powermetrics', null],
  ]);
  const files = new Map<string, string | null>([['/TEST/status.json', STATUS], ['/proc/meminfo', LINUX_MEMORY]]);
  const host: TelemetryHost = {
    platform, now: () => at, cpus: () => cores, totalmem: () => 1024 * MiB,
    freemem: () => 16 * MiB, loadavg: () => [1.5, 2.25, 3],
    read: async file => files.get(file) ?? null,
    command: async (file, args) => {
      calls.push({ file, args });
      return commands.get(`${file} ${args.join(' ')}`) ?? commands.get(file) ?? null;
    },
  };
  return { host, calls, commands, files, advance: () => { at += 1000; cores = [cpu(150, 950), cpu(175, 925)]; } };
}

describe('machine telemetry fixture parsers', () => {
  it('reads macOS page size, speculative free pages, swap units and pressure', () => {
    expect(parseVmStat(VM_STAT)).toEqual({ freeBytes: 1280 * 16384, pageouts: 13 });
    expect(parseMacSwap('vm.swapusage: used = 1.50G free = 2.00G')).toBe(1.5 * KiB ** 3);
    expect(parseMemoryPressure('level: 1')).toBe('normal');
    expect(parseMemoryPressure('memory pressure level: warning')).toBe('warning');
    expect(parseMemoryPressure('level: 4')).toBe('critical');
    expect(parseMemoryPressure(MEMORY_PRESSURE)).toBeNull();
  });

  it('uses Linux MemAvailable instead of MemFree and derives swap consumption', () => {
    expect(parseLinuxMemory(LINUX_MEMORY)).toEqual({ totalBytes: 1024 * MiB, freeBytes: 512 * MiB, swapUsedBytes: 64 * MiB });
    expect(parseLinuxMemory(LINUX_MEMORY.replace('524288', '2097152'))).toBeNull();
    expect(parseLinuxMemory('MemTotal: 1 kB')).toBeNull();
  });

  it('reads disk free bytes for every volume including spaces in mount paths', () => {
    expect(parseDisks(DF)).toEqual([{ volume: '/', freeBytes: 80000 * KiB }, { volume: '/Volumes/Work Files', freeBytes: 40000 * KiB }]);
    expect(parseDisks('df: cannot read mount table')).toBeNull();
  });

  it('sums CPU and RSS over the complete running job process tree', () => {
    expect(sumJobTrees([100, 200], parsePs(PS))).toEqual([
      { pid: 100, cpuPercent: 77.5, rssBytes: 7168 * KiB, processes: 3 },
      { pid: 200, cpuPercent: 10, rssBytes: 512 * KiB, processes: 1 },
    ]);
  });

  it('terminates cyclic trees and preserves unknown roots or failed ps snapshots', () => {
    const cycle = parsePs('100 101 1.5 20\n101 100 2.5 40\n');
    expect(sumJobTrees([100], cycle)).toEqual([{ pid: 100, cpuPercent: 4, rssBytes: 60 * KiB, processes: 2 }]);
    expect(sumJobTrees([100], null)).toEqual([{ pid: 100, cpuPercent: null, rssBytes: null, processes: 0 }]);
    expect(sumJobTrees([999], parsePs(PS))[0]?.rssBytes).toBeNull();
  });

  it.each(['100 1 20', '100 1 -1 50', '100 1 1 -1', '100 1 1 50\n100 1 2 60', '100 1 NaN 50', '0 1 1 50'])('rejects malformed process rows: %s', text => {
    expect(parsePs(text)).toBeNull();
  });

  it('selects running jobs, deduplicates roots and recognizes memguard pause', () => {
    expect(parseQueueStatus(JSON.stringify({ memguard: 'pause', jobs: [{ pid: 100, status: 'running' }, { pid: 100 }, { pid: 200, status: 'done' }] })))
      .toEqual({ pids: [100], paused: true });
    expect(parseQueueStatus(JSON.stringify({ memguard: { paused: true }, running: [] }))).toEqual({ pids: [], paused: true });
    expect(parseQueueStatus(STATUS)).toEqual({ pids: [100, 200], paused: false });
  });

  it.each([null, '{', '[]', '{}', '{"running":[{"pid":-1}]}', '{"jobs":[null]}'])('marks invalid queue evidence unknown: %s', text => {
    expect(parseQueueStatus(text)).toEqual({ pids: [], paused: null });
  });

  it('retains jobs but does not infer a running guard from absent or unknown memguard', () => {
    expect(parseQueueStatus(JSON.stringify({ running: [{ pid: 100 }] }))).toEqual({ pids: [100], paused: null });
    expect(parseQueueStatus(JSON.stringify({ running: [{ pid: 100 }], memguard: 'unknown' }))).toEqual({ pids: [100], paused: null });
  });

  it('retains null for unavailable or malformed accelerator readings', () => {
    expect(parseAccelerators(null)).toEqual({ gpuPercent: null, anePercent: null });
    expect(parseAccelerators('GPU HW active residency: 101%\nANE active residency: -1%')).toEqual({ gpuPercent: null, anePercent: null });
    expect(parseAccelerators('GPU HW active residency: 12.5%\nANE active residency: 3%')).toEqual({ gpuPercent: 12.5, anePercent: 3 });
  });
});

describe('headroom policy', () => {
  it('reserves 25 percent of free memory and floors suggested extra slots', () => {
    expect(machineHeadroom(1000, 0, false, 200, [])).toBe(3);
    expect(machineHeadroom(1000, 0, false, 750, [])).toBe(1);
    expect(machineHeadroom(0, 0, false, 200, [])).toBe(0);
  });

  it('fails closed for pause, growing or unknown swap, and unknown job RSS', () => {
    expect(machineHeadroom(1000, 0, true, 200, [])).toBe(0);
    expect(machineHeadroom(1000, 0, null, 200, [])).toBe(0);
    expect(machineHeadroom(1000, 1, false, 200, [])).toBe(0);
    expect(machineHeadroom(1000, null, false, 200, [])).toBe(0);
    expect(machineHeadroom(1000, 0, false, 200, [{ pid: 1, cpuPercent: null, rssBytes: null, processes: 0 }])).toBe(0);
    expect(machineHeadroom(null, 0, false, 200, [])).toBe(0);
    expect(machineHeadroom(1000, 0, false, 0, [])).toBe(0);
  });
});

describe('machine sampling with fixture hosts', () => {
  it.each(['darwin', 'linux'])('samples %s without waiting for CPU or swap deltas', async platform => {
    const fixture = fixtureHost(platform);
    const first = await sampleMachine({ host: fixture.host, statusPath: '/TEST/status.json', estimatedJobRssBytes: MiB });
    expect(first.cpu.perCore.map(core => core.usedPercent)).toEqual([null, null]);
    expect(first.cpu.loadAverage).toEqual([1.5, 2.25, 3]);
    expect(first.swap).toEqual({ usedBytes: 64 * MiB, growthBytesPerSecond: null });
    expect(first.jobs[0]).toEqual({ pid: 100, cpuPercent: 77.5, rssBytes: 7 * MiB, processes: 3 });
    expect(first.queueState).toBe('known');
    expect(first.gpuPercent).toBeNull();
    expect(first.anePercent).toBeNull();
    expect(first.headroom).toBe(0);
    fixture.advance();
    const second = await sampleMachine({ host: fixture.host, previous: first, statusPath: '/TEST/status.json', estimatedJobRssBytes: MiB });
    expect(second.cpu.perCore.map(core => core.usedPercent)).toEqual([50, 75]);
    expect(second.swap.growthBytesPerSecond).toBe(0);
    expect(second.estimatedJobRssBytes).toBe(7 * MiB);
    expect(second.headroom).toBe(Math.floor(second.ram.freeBytes! * 0.75 / (7 * MiB)));
    expect(second.ram.usedBytes).toBe(second.ram.totalBytes! - second.ram.freeBytes!);
    expect(second.memoryPressure).toEqual(platform === 'darwin'
      ? { level: 'normal', freePercent: 38, pageouts: 13 }
      : { level: null, freePercent: null, pageouts: null });
  });

  it('uses numeric-only ps columns and fixed nonprivileged macOS commands', async () => {
    const fixture = fixtureHost();
    await sampleMachine({ host: fixture.host });
    expect(fixture.calls).toEqual([
      { file: '/bin/ps', args: ['-axo', 'pid=,ppid=,%cpu=,rss='] },
      { file: '/bin/df', args: ['-lkP'] },
      { file: '/usr/bin/vm_stat', args: [] },
      { file: '/usr/bin/memory_pressure', args: ['-Q'] },
      { file: '/usr/sbin/sysctl', args: ['-n', 'kern.memorystatus_vm_pressure_level'] },
      { file: '/usr/sbin/sysctl', args: ['vm.swapusage'] },
      { file: '/usr/bin/powermetrics', args: ['--samplers', 'gpu_power,ane_power', '-n', '1', '-i', '1'] },
    ]);
    expect(JSON.stringify(fixture.calls)).not.toMatch(/sudo|command=|args=|shell/);
  });

  it('runs only ps and df on Linux', async () => {
    const fixture = fixtureHost('linux');
    await sampleMachine({ host: fixture.host });
    expect(fixture.calls.map(call => call.file)).toEqual(['/bin/ps', '/bin/df']);
  });

  it('reads an available unprivileged Linux GPU counter and rejects invalid counters', async () => {
    const fixture = fixtureHost('linux');
    fixture.files.set('/sys/class/drm/card0/device/gpu_busy_percent', '37\n');
    expect((await sampleMachine({ host: fixture.host })).gpuPercent).toBe(37);
    fixture.files.set('/sys/class/drm/card0/device/gpu_busy_percent', '101\n');
    expect((await sampleMachine({ host: fixture.host })).gpuPercent).toBeNull();
  });

  it('forces zero headroom at critical pressure and memguard pause', async () => {
    const fixture = fixtureHost();
    const first = await sampleMachine({ host: fixture.host, statusPath: '/TEST/status.json' });
    fixture.advance();
    fixture.commands.set('/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', '4');
    const critical = await sampleMachine({ host: fixture.host, previous: first, statusPath: '/TEST/status.json' });
    expect(critical.memoryPressure.level).toBe('critical');
    expect(critical.headroom).toBe(0);
    fixture.commands.set('/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', '1');
    fixture.files.set('/TEST/status.json', JSON.stringify({ running: [], memguard: 'pause' }));
    const paused = await sampleMachine({ host: fixture.host, previous: first, statusPath: '/TEST/status.json' });
    expect(paused.memguardPaused).toBe(true);
    expect(paused.headroom).toBe(0);
  });

  it('measures swap growth and clamps swap shrink to zero', async () => {
    const fixture = fixtureHost('linux');
    const first = await sampleMachine({ host: fixture.host });
    fixture.advance();
    fixture.files.set('/proc/meminfo', LINUX_MEMORY.replace('196608', '131072'));
    const growing = await sampleMachine({ host: fixture.host, previous: first });
    expect(growing.swap.growthBytesPerSecond).toBe(64 * MiB);
    expect(growing.headroom).toBe(0);
    fixture.files.set('/proc/meminfo', LINUX_MEMORY.replace('196608', '262144'));
    expect((await sampleMachine({ host: fixture.host, previous: first })).swap.growthBytesPerSecond).toBe(0);
  });

  it('does not reuse a baseline across platforms, stale timestamps or reversed clocks', async () => {
    const fixture = fixtureHost('linux');
    const first = await sampleMachine({ host: fixture.host });
    fixture.advance();
    for (const previous of [{ ...first, platform: 'darwin' }, { ...first, sampledAtMs: -400000 }, { ...first, sampledAtMs: 3000 }]) {
      expect((await sampleMachine({ host: fixture.host, previous })).swap.growthBytesPerSecond).toBeNull();
    }
  });

  it('never forwards raw queue strings, extra fields or command errors', async () => {
    const fixture = fixtureHost();
    const privateValue = ['TEST', 'PRIVATE', 'QUEUE', 'CONTENT'].join('-');
    fixture.files.set('/TEST/status.json', JSON.stringify({ running: [{ pid: 100, prompt: privateValue, token: privateValue }], memguard: 'running', metadata: privateValue }));
    fixture.commands.set('/usr/bin/powermetrics', `error: ${privateValue}`);
    const result = await sampleMachine({ host: fixture.host, statusPath: '/TEST/status.json' });
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(result.jobs).toEqual([{ pid: 100, cpuPercent: 77.5, rssBytes: 7 * MiB, processes: 3 }]);
  });

  it('degrades unavailable OS commands and queue reads to unknown', async () => {
    const fixture = fixtureHost('linux');
    fixture.host.command = async () => { throw new Error('TEST command failed'); };
    fixture.host.read = async () => { throw new Error('TEST read failed'); };
    const result = await sampleMachine({ host: fixture.host });
    expect(result.ram).toEqual({ totalBytes: null, usedBytes: null, freeBytes: null });
    expect(result.disks).toBeNull();
    expect(result.swap).toEqual({ usedBytes: null, growthBytesPerSecond: null });
    expect(result.queueState).toBe('unknown');
    expect(result.headroom).toBe(0);
  });

  it('does not invoke OS commands on unsupported platforms', async () => {
    const fixture = fixtureHost('win32');
    const result = await sampleMachine({ host: fixture.host });
    expect(fixture.calls).toEqual([]);
    expect(result.cpu).toEqual({ perCore: [], loadAverage: [] });
    expect(result.ram.freeBytes).toBeNull();
    expect(result.headroom).toBe(0);
  });
});

describe('dispatch telemetry persistence', () => {
  let directory: string, fleetPath: string;
  const enabled = { telemetry: { machine: { enabled: true, estimatedJobRssBytes: MiB } } };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'TEST-machine-telemetry-'));
    fleetPath = join(directory, 'fleet.json');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each([undefined, {}, { telemetry: {} }, { telemetry: { machine: { enabled: false } } }, { telemetry: { machine: { enabled: 'true' } } }])('does no I/O unless enabled is exactly true: %j', async config => {
    const fixture = fixtureHost();
    expect(machineTelemetryEnabled(config)).toBe(false);
    expect(await sampleMachineForDispatch(config, { fleetPath, host: fixture.host })).toBeNull();
    expect(fixture.calls).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it('adds only resources.machine while preserving existing fleet and resource fields', async () => {
    await writeFile(fleetPath, JSON.stringify({ dispatchTick: 12, jobs: [100], resources: { slots: 8 } }), { mode: 0o600 });
    const fixture = fixtureHost();
    const sample = await sampleMachineForDispatch(enabled, { fleetPath, host: fixture.host, statusPath: '/TEST/status.json' });
    const persisted: unknown = JSON.parse(await readFile(fleetPath, 'utf8'));
    expect(sample).not.toBeNull();
    expect(persisted).toEqual({ dispatchTick: 12, jobs: [100], resources: { slots: 8, machine: sample } });
    expect(await readdir(directory)).toEqual(['fleet.json']);
  });

  it('carries baselines across one-shot dispatch calls for CPU and swap growth', async () => {
    const fixture = fixtureHost('linux');
    const first = await sampleMachineForDispatch(enabled, { fleetPath, host: fixture.host, statusPath: '/TEST/status.json' });
    expect(first?.swap.growthBytesPerSecond).toBeNull();
    fixture.advance();
    const second = await sampleMachineForDispatch(enabled, { fleetPath, host: fixture.host, statusPath: '/TEST/status.json' });
    expect(second?.cpu.perCore.map(core => core.usedPercent)).toEqual([50, 75]);
    expect(second?.swap.growthBytesPerSecond).toBe(0);
    expect(second?.headroom).toBe(Math.floor(512 * MiB * 0.75 / (7 * MiB)));
  });

  it('merges into the latest fleet when a dispatcher updates fields during probes', async () => {
    await writeFile(fleetPath, JSON.stringify({ dispatchTick: 12, resources: { slots: 8 } }), { mode: 0o600 });
    const fixture = fixtureHost();
    const command = fixture.host.command;
    fixture.host.command = async (file, args) => {
      if (file === '/bin/ps') await writeFile(fleetPath, JSON.stringify({ dispatchTick: 13, resources: { slots: 9 } }), { mode: 0o600 });
      return command(file, args);
    };
    const sample = await sampleMachineForDispatch(enabled, { fleetPath, host: fixture.host });
    expect(sample).not.toBeNull();
    expect(JSON.parse(await readFile(fleetPath, 'utf8'))).toEqual({ dispatchTick: 13, resources: { slots: 9, machine: sample } });
  });

  it.each(['{', '[]', '{"resources":[]}'])('preserves malformed fleet state without replacing it: %s', async raw => {
    await writeFile(fleetPath, raw, { mode: 0o600 });
    const fixture = fixtureHost();
    expect(await sampleMachineForDispatch(enabled, { fleetPath, host: fixture.host })).toBeNull();
    expect(await readFile(fleetPath, 'utf8')).toBe(raw);
    expect(fixture.calls).toEqual([]);
    expect(await readdir(directory)).toEqual(['fleet.json']);
  });

  it('preserves concurrent lock ownership and never replaces a locked fleet', async () => {
    const raw = JSON.stringify({ resources: { slots: 5 } });
    await writeFile(fleetPath, raw, { mode: 0o600 });
    await writeFile(`${fleetPath}.machine.lock`, 'TEST-owner', { mode: 0o600 });
    expect(await sampleMachineForDispatch(enabled, { fleetPath, host: fixtureHost().host })).toBeNull();
    expect(await readFile(fleetPath, 'utf8')).toBe(raw);
    expect(await readFile(`${fleetPath}.machine.lock`, 'utf8')).toBe('TEST-owner');
  });

  it('refuses a fleet symlink and keeps the destination unchanged', async () => {
    const destination = join(directory, 'TEST-other.json');
    await writeFile(destination, '{}', { mode: 0o600 });
    await symlink(destination, fleetPath);
    expect(await sampleMachineForDispatch(enabled, { fleetPath, host: fixtureHost().host })).toBeNull();
    expect(await readFile(destination, 'utf8')).toBe('{}');
  });

  it('ignores invalid or arbitrary persisted baseline fields', async () => {
    const privateValue = ['TEST', 'PRIVATE', 'BASELINE'].join('-');
    await writeFile(fleetPath, JSON.stringify({ resources: { machine: {
      schemaVersion: 1, sampledAtMs: 0, platform: 'darwin', swap: { usedBytes: -1 },
      cpu: { perCore: [] }, raw: privateValue,
    } } }), { mode: 0o600 });
    const result = await sampleMachineForDispatch(enabled, { fleetPath, host: fixtureHost().host });
    expect(result?.swap.growthBytesPerSecond).toBeNull();
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(await readFile(fleetPath, 'utf8')).not.toContain(privateValue);
  });
});
