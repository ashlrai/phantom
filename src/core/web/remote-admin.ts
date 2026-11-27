/** Mac-only Unix socket for pairing custody. Never route this through Tunnel. */
import { chmodSync, lstatSync, unlinkSync, type Stats } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { defaultVerseRoot } from '../verse/preferences.js';
import { REMOTE_UUID_RE, ensurePrivateDirectory, isPrivateOwnedStat, isRemoteRecord, lstatOrNull } from './remote-access.js';
import type { createRemotePairing } from './remote-pairing.js';
import type { RemoteDeviceStore } from './remote-device-store.js';

const SOCKET_NAME = 'remote-admin.sock';
const MAX_COMMAND = 4096;
const OPERATOR_DIR_ERROR = 'Remote operator directory is not private';
type Pairing = ReturnType<typeof createRemotePairing>;
type OperatorAction = 'invite' | 'approve' | 'deny' | 'revoke';
export type ConfirmMacOperator = (action: OperatorAction, id: string) => Promise<boolean>;

export function remoteAdminSocketPath(root = defaultVerseRoot()): string { return join(root, SOCKET_NAME); }

function unlinkIfSameSocket(path: string, identity: Pick<Stats, 'ino' | 'dev'>): void {
  try {
    const current = lstatSync(path);
    if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
  } catch { /* a replaced path is never removed */ }
}

/** A killed sidecar leaves its Unix socket pathname behind. Reclaim only a
 * private socket owned by this user after a connection proves no listener is
 * alive; never remove a regular file, symlink, or another process's socket. */
async function clearStaleSocket(root: string, path: string): Promise<void> {
  const before = lstatOrNull(path);
  if (!before) return;
  if (!isPrivateOwnedStat(before, 'socket')) {
    throw new Error('Remote admin socket path is not a private owned socket');
  }
  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(1_000, () => probe.destroy(new Error('Remote admin socket probe timed out')));
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      // A retiring sidecar can unlink its socket between lstat and connect.
      // Recheck below before removing anything; bind still rejects a new listener.
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error('Remote admin socket already has a live listener');
  ensurePrivateDirectory(root, OPERATOR_DIR_ERROR);
  const after = lstatOrNull(path);
  if (!after) return;
  if (!isPrivateOwnedStat(after, 'socket') || after.ino !== before.ino || after.dev !== before.dev) {
    throw new Error('Remote admin socket changed during stale recovery');
  }
  unlinkSync(path);
}

/** A same-UID agent can reach a user socket, so require a visible Mac choice. */
async function confirmMacOperator(action: OperatorAction, id: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const message = `${action.toUpperCase()} Ashlr phone access for ${id}? Check the pending device in the Mac terminal first.`;
  const script = `display dialog ${JSON.stringify(message)} buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution`;
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 60_000, maxBuffer: 1024 }, (error) => resolve(!error));
  });
}

async function command(pairing: Pairing, devices: RemoteDeviceStore, input: unknown, confirm: ConfirmMacOperator, info?: { publicOrigin: string }): Promise<unknown> {
  if (!isRemoteRecord(input)) return { error: 'Invalid operator command' };
  const value = input;
  switch (value.action) {
    case 'invite': {
      if (typeof value.subject !== 'string' || (value.scope !== 'read' && value.scope !== 'act')) return { error: 'Invalid invitation' };
      if (!(await confirm('invite', value.subject))) return { error: 'Mac operator confirmation required' };
      const result = pairing.mac.issueInvitation(value.subject, { read: true, act: value.scope === 'act' });
      return result ?? { error: 'Invitation unavailable' };
    }
    case 'info': {
      const all = devices.list();
      return { publicOrigin: info?.publicOrigin ?? null, phonePath: '/verse/m',
        pending: pairing.mac.pendingApprovals().length,
        devices: { active: all.filter(d => d.revokedAt === null).length, revoked: all.filter(d => d.revokedAt !== null).length } };
    }
    case 'pending': return { approvals: pairing.mac.pendingApprovals() };
    case 'devices': return { devices: devices.list().map((d) => ({ id: d.id, label: d.label, email: d.email,
      subject: d.subject, scopes: d.scopes, createdAt: d.createdAt, revokedAt: d.revokedAt })) };
    case 'approve':
    case 'deny':
    case 'revoke': {
      const id = value.id;
      if (typeof id !== 'string' || !REMOTE_UUID_RE.test(id)) {
        return { error: value.action === 'revoke' ? 'Invalid device ID' : 'Invalid pairing ID' };
      }
      if (!(await confirm(value.action, id))) return { error: 'Mac operator confirmation required' };
      if (value.action === 'approve') {
        const approved = pairing.mac.approvePairing(id, { approved: true });
        return approved ? { approved: true, deviceId: approved.id } : { error: 'Pairing unavailable' };
      }
      if (value.action === 'deny') { pairing.mac.denyPairing(id); return { denied: true }; }
      return { revoked: pairing.mac.revokeDevice(id) };
    }
    default: return { error: 'Unknown operator command' };
  }
}

/** The socket is mode 0600 in a private directory; never expose it through the phone gateway. */
export async function startRemoteAdminSocket(pairing: Pairing, devices: RemoteDeviceStore, root = defaultVerseRoot(),
  confirmOperator: ConfirmMacOperator = confirmMacOperator, info?: { publicOrigin: string }) {
  ensurePrivateDirectory(root, OPERATOR_DIR_ERROR);
  const path = remoteAdminSocketPath(root);
  await clearStaleSocket(root, path);
  let confirmationBusy = false;
  const guardedConfirm: ConfirmMacOperator = async (action, id) => {
    if (confirmationBusy) return false;
    confirmationBusy = true;
    try { return await confirmOperator(action, id); }
    finally { confirmationBusy = false; }
  };
  const server: Server = createServer((socket) => {
    let text = '';
    socket.setTimeout(75_000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > MAX_COMMAND) { socket.destroy(); return; }
      const end = text.indexOf('\n');
      if (end < 0) return;
      socket.removeAllListeners('data');
      void (async () => {
        let answer: unknown;
        try { answer = await command(pairing, devices, JSON.parse(text.slice(0, end)) as unknown, guardedConfirm, info); }
        catch { answer = { error: 'Invalid operator command' }; }
        socket.end(`${JSON.stringify(answer)}\n`);
      })();
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  const identity = lstatSync(path);
  try {
    chmodSync(path, 0o600);
    const secured = lstatSync(path);
    if (!isPrivateOwnedStat(secured, 'socket')
      || secured.ino !== identity.ino || secured.dev !== identity.dev) throw new Error('Remote admin socket is not private');
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlinkIfSameSocket(path, identity);
    throw error;
  }
  return {
    path,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      unlinkIfSameSocket(path, identity);
    },
  };
}

export async function sendRemoteAdminCommand(input: unknown, root = defaultVerseRoot()): Promise<unknown> {
  ensurePrivateDirectory(root, OPERATOR_DIR_ERROR);
  return new Promise((resolve, reject) => {
    const socket = createConnection(remoteAdminSocketPath(root));
    let text = '';
    socket.setTimeout(75_000, () => socket.destroy(new Error('Remote operator command timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify(input)}\n`));
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (Buffer.byteLength(text) > MAX_COMMAND) { socket.destroy(new Error('Remote operator response too large')); return; }
      const end = text.indexOf('\n');
      if (end >= 0) {
        try { resolve(JSON.parse(text.slice(0, end)) as unknown); socket.end(); }
        catch { reject(new Error('Invalid remote operator response')); socket.destroy(); }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => { if (!text.includes('\n')) reject(new Error('Remote operator socket closed')); });
  });
}
