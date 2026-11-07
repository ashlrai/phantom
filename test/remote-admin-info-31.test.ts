import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { sendRemoteAdminCommand, startRemoteAdminSocket } from '../src/core/web/remote-admin.js';

it.each([undefined, { publicOrigin: 'https://phone.example.invalid' }])('info is read-only with optional origin %j', async (info) => {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'phone31-'));
  const confirm = vi.fn(async () => false);
  const pairing = { mac: { pendingApprovals: () => [{ credentialId: 'private-fixture' }, {}] } } as unknown as Parameters<typeof startRemoteAdminSocket>[0];
  const devices = { list: () => [{ revokedAt: null, credentialId: 'private-fixture' }, { revokedAt: 1 }] } as unknown as Parameters<typeof startRemoteAdminSocket>[1];
  const admin = await startRemoteAdminSocket(pairing, devices, root, confirm, info);
  try {
    const result = await sendRemoteAdminCommand({ action: 'info' }, root);
    expect(result).toEqual({ publicOrigin: info?.publicOrigin ?? null, phonePath: '/verse/m', pending: 2, devices: { active: 1, revoked: 1 } });
    expect(JSON.stringify(result)).not.toMatch(/credential|audience|teamDomain|gatewayPort|token|private-fixture/i);
    expect(confirm).not.toHaveBeenCalled();
  } finally { await admin.close(); rmSync(root, { recursive: true, force: true }); }
});
