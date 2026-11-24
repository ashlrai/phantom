import { describe, expect, it } from 'vitest';
import { readOsSensors, type OsSensorHost, WINDOWS_OS_SENSOR_SCRIPT } from '../src/core/resources/os-sensors.js';

function fixture(platform: string) {
  const files = new Map<string, string | null>();
  const commands = new Map<string, string | null>();
  const directories = new Map<string, string[] | null>();
  const calls: string[] = [];
  const host: OsSensorHost = {
    platform, now: () => 1234, cpus: () => [{}, {}, {}, {}], loadavg: () => [8, 4, 2],
    read: async file => { calls.push(file); return files.get(file) ?? null; },
    command: async (file, args) => { calls.push(`${file} ${args.join(' ')}`); return commands.get(`${file} ${args.join(' ')}`) ?? null; },
    list: async directory => { calls.push(directory); return directories.get(directory) ?? null; },
  };
  return { host, files, commands, directories, calls };
}
const meminfo = 'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 100 kB\nSwapFree: 75 kB\nZswap: 12 kB\n';
const psi = 'some avg10=1.25 avg60=0.50 avg300=0.25 total=1234\nfull avg10=0.25 avg60=0.10 avg300=0.05 total=123\n';

function linux() {
  const f = fixture('linux');
  f.files.set('/proc/meminfo', meminfo);
  f.files.set('/proc/pressure/memory', psi);
  f.directories.set('/sys/class/thermal', ['thermal_zone0', 'thermal_zone1', '../private']);
  f.directories.set('/sys/block', ['zram0', 'sda', '../private']);
  f.files.set('/sys/class/thermal/thermal_zone0/temp', '42000\n');
  f.files.set('/sys/class/thermal/thermal_zone1/temp', '51000\n');
  f.files.set('/sys/block/zram0/mm_stat', '100000 10000 16384 0 20000 0 0 0\n');
  return f;
}

describe('OS sensor contract', () => {
  it('reads Linux PSI and physical compression without substituting free RAM or original pages', async () => {
    const f = linux();
    const result = await readOsSensors({ host: f.host });
    expect(result.schema).toBe('os.sensors.v1');
    expect(result.sampledAtMs).toBe(1234);
    expect(result.memoryPressure.value).toEqual({ kind: 'psi', someAvg10Percent: 1.25, fullAvg10Percent: 0.25 });
    expect(result.swapUsedBytes.value).toBe(25 * 1024);
    expect(result.compressedBytes.value).toBe(12 * 1024 + 16384);
    expect(result.loadPerCore.value).toBe(2);
    expect(result.thermal.value).toEqual({ kind: 'max-zone-celsius', celsius: 51 });
    expect(f.calls.some(call => call.includes('private') || call.includes('sysctl'))).toBe(false);
    expect(Object.values(result).filter(value => value && typeof value === 'object').every(value => value.reason === null)).toBe(true);
  });

  it('keeps missing PSI and a partial compressed store unknown', async () => {
    const f = linux();
    f.files.delete('/proc/pressure/memory');
    f.files.delete('/sys/block/zram0/mm_stat');
    const result = await readOsSensors({ host: f.host });
    expect(result.memoryPressure).toMatchObject({ value: null, reason: 'unavailable' });
    expect(result.compressedBytes.value).toBeNull();
    expect(result.swapUsedBytes.value).toBe(25 * 1024);
  });

  it('rejects malformed, duplicated or impossible PSI and memory counters', async () => {
    const f = linux();
    for (const text of [psi + psi, psi.replace('1.25', '101.00'), psi.replace('0.25 avg60=0.10', '2.00 avg60=0.10'), 'some avg10=NaN']) {
      f.files.set('/proc/pressure/memory', text);
      expect((await readOsSensors({ host: f.host })).memoryPressure.value).toBeNull();
    }
    for (const text of [meminfo.replace('SwapFree: 75', 'SwapFree: 175'),
      meminfo + 'SwapFree: 0 kB\n', meminfo + 'SwapTotal: 125 kB\n',
      meminfo.replace('SwapTotal: 100', 'SwapTotal: 9007199254740991')]) {
      f.files.set('/proc/meminfo', text);
      expect((await readOsSensors({ host: f.host })).swapUsedBytes).toMatchObject({ value: null, reason: 'invalid' });
    }
    f.files.set('/proc/meminfo', 'SwapTotal: 100 kB\nSwapFree: 75 kB\n');
    expect((await readOsSensors({ host: f.host })).swapUsedBytes.value).toBe(25 * 1024);
    f.files.set('/proc/meminfo', meminfo.replace('Zswap: 12', 'Zswap: 9007199254740992'));
    expect((await readOsSensors({ host: f.host })).compressedBytes.value).toBeNull();
  });

  it('does not misreport absent enumeration or excessive zones as a complete zero', async () => {
    const f = linux();
    f.host.list = undefined;
    const missing = await readOsSensors({ host: f.host });
    expect(missing.compressedBytes.value).toBeNull();
    expect(missing.thermal.value).toBeNull();
    f.host.list = async () => Array.from({ length: 33 }, (_, i) => `thermal_zone${i}`);
    expect((await readOsSensors({ host: f.host })).thermal.value).toBeNull();
  });

  it('keeps measured Linux zero pressure and no compressed-store allocation as zero', async () => {
    const f = linux();
    f.directories.set('/sys/block', []);
    f.files.set('/proc/meminfo', meminfo.replace('Zswap: 12', 'Zswap: 0'));
    f.files.set('/proc/pressure/memory', psi.replaceAll('1.25', '0.00').replaceAll('0.25', '0.00'));
    const result = await readOsSensors({ host: f.host });
    expect(result.compressedBytes.value).toBe(0);
    expect(result.memoryPressure.value).toEqual({ kind: 'psi', someAvg10Percent: 0, fullAvg10Percent: 0 });
  });

  it('reads macOS native pressure, compressor occupancy and CPU speed limit', async () => {
    const f = fixture('darwin');
    f.commands.set('/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', '2\n');
    f.commands.set('/usr/sbin/sysctl vm.swapusage', 'vm.swapusage: total = 2.00G used = 1.00G free = 1.00G');
    f.commands.set('/usr/bin/vm_stat ', 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages stored in compressor: 100.\nPages occupied by compressor: 10.\n');
    f.commands.set('/usr/bin/pmset -g therm', 'CPU_Scheduler_Limit = 100\nCPU_Speed_Limit = 75\n');
    const result = await readOsSensors({ host: f.host });
    expect(result.memoryPressure.value).toEqual({ kind: 'kernel-level', level: 'warning' });
    expect(result.swapUsedBytes.value).toBe(1024 ** 3);
    expect(result.compressedBytes.value).toBe(163840);
    expect(result.thermal.value).toEqual({ kind: 'cpu-speed-limit', percent: 75 });
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every(call => !call.includes('sudo') && !call.includes('powermetrics'))).toBe(true);
  });

  it('does not infer normal macOS pressure from free-memory text or missing thermal samples', async () => {
    const f = fixture('darwin');
    f.commands.set('/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level', 'System-wide memory free percentage: 90%');
    const result = await readOsSensors({ host: f.host });
    expect(result.memoryPressure).toMatchObject({ value: null, reason: 'invalid' });
    expect(result.thermal.value).toBeNull();
    expect(result.compressedBytes.value).toBeNull();
  });

  it('rejects ambiguous or unsafe macOS swap fields and normalizes native rounded units', async () => {
    const f = fixture('darwin');
    for (const text of ['vm.swapusage: used = 1.00G used = 2.00G',
      'vm.swapusage: used = 9007199254740992T', 'vm.swapusage: used = -1.00M']) {
      f.commands.set('/usr/sbin/sysctl vm.swapusage', text);
      expect((await readOsSensors({ host: f.host })).swapUsedBytes).toMatchObject({ value: null, reason: 'invalid' });
    }
    for (const [units, scale] of [['M', 1024 ** 2], ['G', 1024 ** 3]] as const) {
      f.commands.set('/usr/sbin/sysctl vm.swapusage', `vm.swapusage: used = 1.01${units}`);
      expect((await readOsSensors({ host: f.host })).swapUsedBytes.value).toBe(Math.round(1.01 * scale));
    }
  });

  it('keeps Windows commit, pagefile use and thermal units distinct', async () => {
    const f = fixture('win32');
    f.host.command = async (file, args) => {
      expect(file).toMatch(/WindowsPowerShell\\v1.0\\powershell.exe$/);
      expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OS_SENSOR_SCRIPT]);
      return JSON.stringify({ commitBytes: 50_000, commitLimitBytes: 100_000, pagefileMiB: [12, 4], temperaturesKelvin: [300, 310] });
    };
    f.host.loadavg = () => { throw new Error('Windows load is synthetic, do not read'); };
    const result = await readOsSensors({ host: f.host });
    expect(result.memoryPressure.value).toEqual({ kind: 'commit', usedPercent: 50 });
    expect(result.swapUsedBytes.value).toBe(16 * 1024 ** 2);
    expect(result.thermal.value?.kind).toBe('max-zone-celsius');
    expect(result.thermal.value).toEqual({ kind: 'max-zone-celsius', celsius: 310 - 273.15 });
    expect(result.loadPerCore).toMatchObject({ value: null, reason: 'unsupported' });
    expect(result.compressedBytes).toMatchObject({ value: null, reason: 'unsupported' });
  });

  it('distinguishes an empty Windows pagefile inventory from failed CIM', async () => {
    const f = fixture('win32');
    f.host.command = async () => JSON.stringify({ pagefileMiB: [], commitBytes: null, commitLimitBytes: null });
    const measured = await readOsSensors({ host: f.host });
    expect(measured.swapUsedBytes.value).toBe(0);
    expect(measured.memoryPressure.value).toBeNull();
    f.host.command = async () => null;
    const failed = await readOsSensors({ host: f.host });
    expect(failed.swapUsedBytes).toMatchObject({ value: null, reason: 'unavailable' });
  });

  it('refuses Windows string, negative and overflow values rather than coercing them', async () => {
    const f = fixture('win32');
    for (const data of [{ commitBytes: '1', commitLimitBytes: 10, pagefileMiB: ['2'] },
      { commitBytes: 20, commitLimitBytes: 10, pagefileMiB: [-1] },
      { commitBytes: 0, commitLimitBytes: 0, pagefileMiB: [Number.MAX_SAFE_INTEGER] }]) {
      f.host.command = async () => JSON.stringify(data);
      const result = await readOsSensors({ host: f.host });
      expect(result.memoryPressure.value).toBeNull();
      expect(result.swapUsedBytes.value).toBeNull();
    }
  });

  it('bounds all probes by one deadline and aborts stalled commands', async () => {
    const f = fixture('darwin');
    const signals: AbortSignal[] = [];
    f.host.command = async (_file, _args, signal) => { signals.push(signal!); return new Promise(() => {}); };
    const result = await readOsSensors({ host: f.host, timeoutMs: 10 });
    expect(result.memoryPressure.reason).toBe('timeout');
    expect(result.swapUsedBytes.reason).toBe('timeout');
    expect(result.compressedBytes.reason).toBe('timeout');
    expect(signals).toHaveLength(4);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('handles rejected probes and invalid CPU readings without exposing raw errors', async () => {
    const f = fixture('linux');
    f.host.read = async () => { throw new Error('private error output'); };
    f.host.loadavg = () => [Infinity];
    const result = await readOsSensors({ host: f.host });
    expect(result.memoryPressure.reason).toBe('unavailable');
    expect(result.loadPerCore.value).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('uses no platform probes on unsupported operating systems', async () => {
    const f = fixture('freebsd');
    const result = await readOsSensors({ host: f.host });
    expect(f.calls).toHaveLength(0);
    expect(result.memoryPressure.reason).toBe('unsupported');
    expect(result.loadPerCore.value).toBeNull();
  });
});
