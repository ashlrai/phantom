import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNativeBootIdentity } from '../src/core/resources/native-boot-identity.js';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const boot = '11111111-2222-3333-4444-555555555555';
const machine = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
beforeEach(() => { exec.mockReset(); Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' }); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); });
function readings(first = boot, hardware = `"IOPlatformUUID" = "${machine}"`, last = boot) {
  exec.mockReturnValueOnce(first).mockReturnValueOnce(hardware).mockReturnValueOnce(last);
}

describe('bounded local native boot identity', () => {
  it('normalizes stable OS UUIDs, hashes the machine identity, and uses fixed bounded nonsecret execution', () => {
    readings(` ${boot.toUpperCase()}\n`, `"IOPlatformUUID" = "${machine.toUpperCase()}"`, `${boot}\n`);
    expect(readNativeBootIdentity()).toEqual({ bootId: boot,
      machineDigest: createHash('sha256').update(`ashlr-native-machine-v1\0${machine}`).digest('hex') });
    expect(exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']],
      ['/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']],
      ['/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']],
    ]);
    for (const [, , options] of exec.mock.calls) expect(options).toEqual({ encoding: 'utf8', timeout: 1000,
      maxBuffer: 64 * 1024, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } });
  });

  it.each(['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', `${boot}\n${boot}`])(
    'rejects invalid boot output before reading hardware %#', (value) => {
      readings(value); expect(readNativeBootIdentity()).toBeNull(); expect(exec).toHaveBeenCalledTimes(1);
    });

  it.each(['', '"IOPlatformUUID" = "not-a-uuid"', '"IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"',
    `"IOPlatformUUID" = "${machine}"\n"IOPlatformUUID" = "${machine}"`, `"IOPlatformUUID" = "${machine}\nextra"`])(
    'rejects missing malformed or duplicate hardware UUIDs %#', (value) => {
      readings(boot, value); expect(readNativeBootIdentity()).toBeNull();
    });

  it('rejects a boot change during the identity read', () => {
    readings(boot, `"IOPlatformUUID" = "${machine}"`, '66666666-2222-3333-4444-555555555555');
    expect(readNativeBootIdentity()).toBeNull();
  });

  it.each([0, 1, 2])('fails closed on denied oversized or timed-out OS reads at stage %s', (stage) => {
    for (let i = 0; i < stage; i++) exec.mockReturnValueOnce(i === 0 ? boot : `"IOPlatformUUID" = "${machine}"`);
    exec.mockImplementationOnce(() => { throw new Error('private OS diagnostics'); });
    expect(readNativeBootIdentity()).toBeNull();
  });

  it.each(['win32', 'freebsd'])('does not launch commands on unsupported platform %s', (value) => {
    Object.defineProperty(process, 'platform', { ...platform, value });
    expect(readNativeBootIdentity()).toBeNull(); expect(exec).not.toHaveBeenCalled();
  });
});

describe('Linux boot identity', () => {
  const machineId = '0123456789abcdef0123456789abcdef';
  const files: Record<string, string | null> = {
    '/proc/sys/kernel/random/boot_id': `${boot}\n`,
    '/etc/machine-id': `${machineId}\n`,
    '/var/lib/dbus/machine-id': null,
  };
  const read = (map: Record<string, string | null>) => (path: string) => map[path] ?? null;
  beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); });

  it('hashes the machine-id under the linux domain with the kernel boot id', () => {
    expect(readNativeBootIdentity(read(files))).toEqual({ bootId: boot,
      machineDigest: createHash('sha256').update(`ashlr-native-machine-v1\0linux\0${machineId}`).digest('hex') });
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to the D-Bus machine-id when /etc/machine-id is absent', () => {
    const map = { ...files, '/etc/machine-id': null, '/var/lib/dbus/machine-id': `${machineId}\n` };
    expect(readNativeBootIdentity(read(map))?.bootId).toBe(boot);
  });

  it('rejects a boot change during the identity read', () => {
    let calls = 0;
    const flip = (path: string) => {
      if (path !== '/proc/sys/kernel/random/boot_id') return files[path] ?? null;
      calls += 1;
      return `${calls === 1 ? boot : '66666666-2222-3333-4444-555555555555'}\n`;
    };
    expect(readNativeBootIdentity(flip)).toBeNull();
  });

  it.each([
    [{ ...files, '/proc/sys/kernel/random/boot_id': null }],
    [{ ...files, '/proc/sys/kernel/random/boot_id': 'not-a-uuid\n' }],
    [{ ...files, '/proc/sys/kernel/random/boot_id': '00000000-0000-0000-0000-000000000000\n' }],
    [{ ...files, '/etc/machine-id': null, '/var/lib/dbus/machine-id': null }],
    [{ ...files, '/etc/machine-id': 'uninitialized\n' }],
    [{ ...files, '/etc/machine-id': `${machineId.toUpperCase()}\n` }],
    [{ ...files, '/etc/machine-id': `${machineId.slice(0, 31)}\n` }],
  ])('fails closed on missing or malformed Linux identity %#', (map) => {
    expect(readNativeBootIdentity(read(map))).toBeNull();
  });
});
