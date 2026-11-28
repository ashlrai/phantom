/** Mac-local remote phone custody and diagnosis commands. */
import { createInterface } from 'node:readline/promises';
import { REMOTE_SUBJECT_RE, REMOTE_UUID_RE, isRemoteRecord } from '../core/web/remote-access.js';
import { sendRemoteAdminCommand } from '../core/web/remote-admin.js';
import { phonePairingQr } from '../core/web/phone-pairing-qr.js';
import { diagnoseRemoteLocal, type RemoteDoctorDeps } from '../core/web/remote-local-doctor.js';

async function confirm(phrase: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(`Type ${phrase} on this Mac to continue: `)).trim() === phrase; }
  finally { reader.close(); }
}

async function callAdmin(input: unknown): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try { return { ok: true, value: await sendRemoteAdminCommand(input) }; }
  catch (error) {
    console.error(`Remote gateway operator socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }
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
    if (!id || !REMOTE_SUBJECT_RE.test(id) || (scope !== 'read' && scope !== 'act') || args.length > 3
      || !(await confirm(`INVITE ${id}`))) return 2;
    const response = await callAdmin({ action, subject: id, scope });
    if (!response.ok) return 1;
    if (!isRemoteRecord(response.value) || !('code' in response.value)) {
      console.error('Invitation unavailable. Is the remote gateway running on this Mac?'); return 1;
    }
    const invite = response.value as { code: string; expiresAt: number };
    console.log(`One-use pairing code: ${invite.code}`);
    console.log(`Expires: ${new Date(invite.expiresAt).toLocaleString()}`);
    try {
      const info = await sendRemoteAdminCommand({ action: 'info' });
      const origin = isRemoteRecord(info) ? info.publicOrigin : null;
      const qr = typeof origin === 'string' ? phonePairingQr(origin, invite.code, invite.expiresAt, Date.now()) : null;
      if (qr) {
        console.log('Scan this on the phone. The code is in the URL fragment and is not sent to the server.');
        console.log(qr.payload);
        console.log(qr.ascii);
      }
    } catch { /* The one-use code above is enough when the operator socket cannot answer info. */ }
    return 0;
  }
  const mutatingIdAction = action === 'approve' || action === 'deny' || action === 'revoke';
  if (mutatingIdAction && (!id || !REMOTE_UUID_RE.test(id))) return 2;
  if ((action === 'pending' || action === 'devices') && args.length !== 1) return 2;
  if (mutatingIdAction && !(await confirm(`${action.toUpperCase()} ${id}`))) return 2;
  const response = await callAdmin({ action, id });
  if (!response.ok) return 1;
  if (isRemoteRecord(response.value) && 'error' in response.value) {
    console.error(String(response.value.error)); return 1;
  }
  console.log(JSON.stringify(response.value, null, 2));
  return 0;
}
