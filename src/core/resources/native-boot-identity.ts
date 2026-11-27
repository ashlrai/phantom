import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readWindowsPowerShell, windowsPowerShellArgs, windowsPowerShellPath } from '../util/windows-powershell.js';

export interface NativeBootIdentity {
  machineDigest: string;
  bootId: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function uuid(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return UUID.test(normalized) && normalized !== '00000000-0000-0000-0000-000000000000' ? normalized : null;
}

/** Bounded read of a Linux /proc or /etc virtual file; oversized or unreadable is unknown. */
type LinuxFileReader = (path: string) => string | null;
const readLinuxFile: LinuxFileReader = path => {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= 4096 ? text : null;
  } catch { return null; }
};

const LINUX_BOOT_ID = '/proc/sys/kernel/random/boot_id';
/** systemd's /etc/machine-id first, the D-Bus copy as fallback; both are 32 hex chars. */
const LINUX_MACHINE_IDS = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
const LINUX_MACHINE_ID = /^[a-f0-9]{32}$/;

/** Linux counterpart of the macOS read: kernel boot_id is the per-boot UUID and
 * machine-id the per-install machine identity. The digest domain is separate
 * (`linux` tag) so the two platforms can never alias one machine record. The
 * boot id is read twice around the machine read, exactly like the macOS path,
 * so an identity never mixes two boots. */
function linuxBootIdentity(read: LinuxFileReader): NativeBootIdentity | null {
  const first = uuid(read(LINUX_BOOT_ID) ?? '');
  if (!first) return null;
  const machine = LINUX_MACHINE_IDS.map(path => read(path)?.trim() ?? null)
    .find((v): v is string => v !== null && LINUX_MACHINE_ID.test(v));
  if (machine === undefined) return null;
  if (uuid(read(LINUX_BOOT_ID) ?? '') !== first) return null;
  return { bootId: first,
    machineDigest: createHash('sha256').update(`ashlr-native-machine-v1\0linux\0${machine}`).digest('hex') };
}

/** Windows counterpart: MachineGuid is the per-install machine identity and
 * LastBootUpTime ticks the per-boot discriminator, hashed into the UUID shape
 * lease schemas require. One bounded PowerShell snapshot reads both, so an
 * identity never mixes two boots. */
const WINDOWS_IDENTITY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$guid = (Get-ItemProperty -LiteralPath \'HKLM:\\SOFTWARE\\Microsoft\\Cryptography\' -Name \'MachineGuid\').MachineGuid',
  '$boot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks',
  '"machineGuid=$guid"',
  '"bootTicks=$boot"',
].join('\n');

const WINDOWS_IDENTITY_ARGS = windowsPowerShellArgs(WINDOWS_IDENTITY_SCRIPT);
const WINDOWS_IDENTITY_LINE = /^(machineGuid|bootTicks)=([A-Za-z0-9-]+)[ \t]*\r?$/;
/** DateTime.MaxValue.Ticks: the domain a real LastBootUpTime can occupy. */
const WINDOWS_BOOT_TICKS_MAX = 3_155_378_975_999_999_999n;

function parseWindowsIdentitySnapshot(text: string): { machineGuid: string; bootTicks: string } | null {
  let machineGuid: string | null = null, bootTicks: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = WINDOWS_IDENTITY_LINE.exec(line);
    if (!match) return null;
    if (match[1] === 'machineGuid') {
      if (machineGuid !== null) return null;
      machineGuid = match[2]!;
    } else {
      if (bootTicks !== null) return null;
      bootTicks = match[2]!;
    }
  }
  return machineGuid !== null && bootTicks !== null ? { machineGuid, bootTicks } : null;
}

/** Boot ticks are not UUID-shaped, so the boot id is their SHA-256 digest in
 * UUID form: stable within a boot, different on the next, and never a raw
 * hardware or clock value in durable records. */
function windowsBootId(ticks: string): string | null {
  if (!/^\d{1,20}$/.test(ticks)) return null;
  let value: bigint;
  try { value = BigInt(ticks); } catch { return null; }
  if (value <= 0n || value > WINDOWS_BOOT_TICKS_MAX) return null;
  const digest = createHash('sha256').update(`ashlr-windows-boot-v1\0${ticks}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function windowsBootIdentity(): NativeBootIdentity | null {
  try {
    const executable = windowsPowerShellPath(process.env.SystemRoot);
    if (!executable) return null;
    const snapshot = parseWindowsIdentitySnapshot(readWindowsPowerShell(executable, WINDOWS_IDENTITY_ARGS));
    if (!snapshot) return null;
    const machine = uuid(snapshot.machineGuid);
    const bootId = windowsBootId(snapshot.bootTicks);
    if (!machine || !bootId) return null;
    return { bootId,
      machineDigest: createHash('sha256').update(`ashlr-native-machine-v1\0windows\0${machine}`).digest('hex') };
  } catch {
    return null;
  }
}

/** Local OS identity only; never credentials, a provider probe, or a wall-clock heuristic. */
export function readNativeBootIdentity(readFile: LinuxFileReader = readLinuxFile): NativeBootIdentity | null {
  if (process.platform === 'linux') return linuxBootIdentity(readFile);
  if (process.platform === 'win32') return windowsBootIdentity();
  if (process.platform !== 'darwin') return null;
  const read = (file: string, args: string[]): string => execFileSync(file, args, {
    encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
  });
  try {
    const bootId = uuid(read('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']));
    if (!bootId) return null;
    const platform = read('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const matches = [...platform.matchAll(/"IOPlatformUUID"\s*=\s*"([^"\r\n]+)"/g)];
    const machine = matches.length === 1 ? uuid(matches[0]![1]!) : null;
    if (!machine || uuid(read('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])) !== bootId) return null;
    // Keep hardware identifiers out of durable records and public projections.
    return { machineDigest: createHash('sha256').update(`ashlr-native-machine-v1\0${machine}`).digest('hex'), bootId };
  } catch {
    // Unsupported, denied, oversized or timed-out reads cannot authorize recovery.
    return null;
  }
}
