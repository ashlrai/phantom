/** Mac-local remote phone custody and diagnosis commands. */
import { createInterface } from 'node:readline/promises';
import { sendRemoteAdminCommand } from '../core/web/remote-admin.js';
import { diagnoseRemoteLocal, type RemoteDoctorDeps } from '../core/web/remote-local-doctor.js';

const UUID = /^[0-9a-f-]{36}$/;

async function confirm(phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(`Type ${phrase} on this Mac to continue: `)).trim() === phrase; }
  finally { reader.close(); }
}

export async function cmdVerseRemote(args: string[], doctorDeps?: RemoteDoctorDeps): Promise<number> {
  const [action, id] = args;
  if (action === 'status') {
    const rest = args.slice(1);
    const json = rest.includes('--json');
    const configIndex = rest.indexOf('--config');
    if (configIndex < 0 || !rest[configIndex + 1] || rest[configIndex + 1].startsWith('--')
      || rest.filter((arg) => arg === '--config').length !== 1
      || rest.filter((arg) => arg === '--json').length > 1 || rest.length !== (json ? 3 : 2)) {
      console.error('Usage: phm verse remote status --config <path> [--json]'); return 2;
    }
    const report = await diagnoseRemoteLocal(rest[configIndex + 1], doctorDeps);
    if (json) console.log(JSON.stringify(report));
    else {
      console.log(`Phone URL: ${report.phoneUrl ?? 'unknown (config unavailable)'}`);
      console.log(`Config: ${report.config}; local listener: ${report.listener}${report.gatewayPort ? ` (port ${report.gatewayPort})` : ''}; admin: ${report.admin}`);
      console.log(`Paired active devices: ${report.activeDevices ?? 'unknown'}`);
      console.log('Public reachability: unknown; Access policy: unknown');
      console.log(`Next: ${report.nextStep}`);
    }
    return report.localReady ? 0 : 1;
  }
  if (!action || !['invite', 'pending', 'devices', 'approve', 'deny', 'revoke'].includes(action)
    || (action !== 'invite' && args.length > 2)) {
    console.error('Usage: phm verse remote status --config <path> [--json] | invite <Access-subject> [read|act] | pending | devices | approve <id> | deny <id> | revoke <id>');
    return 2;
  }
  if (action === 'invite') {
    const scope = args[2] ?? 'read';
    if (!id || !/^[A-Za-z0-9_-]{8,256}$/.test(id) || (scope !== 'read' && scope !== 'act') || args.length > 3
      || !(await confirm(`INVITE ${id}`))) return 2;
    let result: unknown;
    try { result = await sendRemoteAdminCommand({ action, subject: id, scope }); }
    catch (error) { console.error(`Remote gateway operator socket unavailable: ${error instanceof Error ? error.message : String(error)}`); return 1; }
    if (!result || typeof result !== 'object' || !('code' in result)) {
      console.error('Invitation unavailable. Is the remote gateway running on this Mac?'); return 1;
    }
    const invite = result as { code: string; expiresAt: number };
    console.log(`One-use pairing code: ${invite.code}`);
    console.log(`Expires: ${new Date(invite.expiresAt).toLocaleString()}`);
    return 0;
  }
  if ((action === 'approve' || action === 'deny' || action === 'revoke') && (!id || !UUID.test(id))) return 2;
  if ((action === 'pending' || action === 'devices') && args.length !== 1) return 2;
  if ((action === 'approve' || action === 'deny' || action === 'revoke')
    && !(await confirm(`${action.toUpperCase()} ${id}`))) return 2;
  try {
    const result = await sendRemoteAdminCommand({ action, id });
    if (result && typeof result === 'object' && 'error' in result) {
      console.error(String((result as { error: unknown }).error)); return 1;
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`Remote gateway operator socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
