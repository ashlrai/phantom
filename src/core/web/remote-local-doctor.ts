/** Read-only, local evidence about the opt-in phone gateway. */
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { remoteAdminSocketPath } from './remote-admin.js';
import { assertPrivatePath, readRemoteGatewayConfig } from './remote-fs.js';

type AdminAction = 'pending' | 'devices';
export interface RemoteDoctorDeps {
  probe?: (port: number) => Promise<boolean>;
  admin?: (action: AdminAction) => Promise<unknown>;
  adminSocketPath?: string;
}

function probeListener(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => finish(false), 1500);
    function finish(result: boolean) { clearTimeout(timer); socket.destroy(); resolve(result); }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Speak the existing read-only admin protocol without its directory-creating client. */
function readAdmin(action: AdminAction, path = remoteAdminSocketPath()): Promise<unknown> {
  assertPrivatePath(dirname(path), 'directory', 'unavailable');
  assertPrivatePath(path, 'socket', 'unavailable');
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = '';
    const timer = setTimeout(() => finish(), 1500);
    function finish(value?: unknown) {
      clearTimeout(timer); socket.destroy();
      if (value === undefined) reject(new Error('unavailable')); else resolve(value);
    }
    socket.once('connect', () => socket.write(`${JSON.stringify({ action })}\n`));
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > 4096) return finish();
      const end = text.indexOf('\n');
      if (end >= 0) {
        try { finish(JSON.parse(text.slice(0, end)) as unknown); } catch { finish(); }
      }
    });
    socket.once('error', () => finish());
    socket.once('close', () => { if (!text.includes('\n')) finish(); });
  });
}

export async function diagnoseRemoteLocal(path: string, deps: RemoteDoctorDeps = {}) {
  const report = {
    schemaVersion: 1, config: 'invalid' as 'valid' | 'invalid', phoneUrl: null as string | null,
    gatewayPort: null as number | null, listener: 'unknown' as 'unknown' | 'listening' | 'unavailable',
    admin: 'unknown' as 'unknown' | 'available' | 'unavailable', activeDevices: null as number | null,
    publicReachability: 'unknown', accessPolicy: 'unknown', localReady: false,
    nextStep: 'Provide a valid private remote gateway config with --config.',
  };
  let config: ReturnType<typeof readRemoteGatewayConfig>;
  try { config = readRemoteGatewayConfig(path); } catch { return report; }
  report.config = 'valid';
  report.phoneUrl = `${config.access.publicOrigin}/verse/m/`;
  report.gatewayPort = config.gatewayPort;
  const admin = deps.admin ?? ((action: AdminAction) => readAdmin(action, deps.adminSocketPath));
  const [listener, pending, devices] = await Promise.allSettled([
    Promise.resolve().then(() => (deps.probe ?? probeListener)(config.gatewayPort)),
    Promise.resolve().then(() => admin('pending')), Promise.resolve().then(() => admin('devices')),
  ]);
  report.listener = listener.status === 'fulfilled' && listener.value ? 'listening' : 'unavailable';
  if (pending.status === 'fulfilled' && devices.status === 'fulfilled'
    && pending.value && typeof pending.value === 'object' && 'approvals' in pending.value && Array.isArray(pending.value.approvals)
    && devices.value && typeof devices.value === 'object' && 'devices' in devices.value && Array.isArray(devices.value.devices)
    && devices.value.devices.every((d: unknown) => d && typeof d === 'object' && 'revokedAt' in d
      && (d.revokedAt === null || (typeof d.revokedAt === 'number' && Number.isSafeInteger(d.revokedAt))))) {
    report.admin = 'available';
    report.activeDevices = devices.value.devices.filter((d: { revokedAt: number | null }) => d.revokedAt === null).length;
  } else report.admin = 'unavailable';
  report.localReady = report.listener === 'listening' && report.admin === 'available' && report.activeDevices !== 0;
  report.nextStep = report.listener !== 'listening' ? 'Check the gateway process started with phm verse --remote-config on this Mac.'
    : report.admin !== 'available' ? 'Check the remote gateway operator socket on this Mac.'
      : report.activeDevices === 0 ? 'Pair and approve a phone using the existing Mac operator flow.'
        : 'Verify public reachability and the Access policy separately, then open the phone URL.';
  return report;
}
