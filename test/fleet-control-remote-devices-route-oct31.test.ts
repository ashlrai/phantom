import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi, setFleetControlDepsForTest } from '../src/core/verse/fleet-control-api.js';
import { defaultFleetControlDeps } from '../src/core/fleet/fleet-control.js';
import type { RemoteDevice } from '../src/core/web/remote-device-store.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { PairedDevicesSnapshot } from '../src/web-ui/routes/verse/sections/paired-devices-model.js';

const path = '/api/verse/fleet/control/remote-devices';
const device: RemoteDevice = {
  id: '11111111-1111-1111-1111-111111111111', label: 'Fake phone', email: 'fake@example.invalid', subject: 'fake-subject',
  scopes: { read: true, act: true }, credentialId: 'fake-credential-material', publicKey: 'fake-public-key-material',
  counter: 4, transports: ['internal'], deviceType: 'singleDevice', backedUp: false,
  createdAt: 1800000000000, lastUsedAt: 1800000060000, revokedAt: null,
};
afterEach(() => { setFleetControlDepsForTest(null); vi.restoreAllMocks(); });
async function call(method = 'GET', url = path) {
  let status = 0, payload = '';
  const req = { url, method } as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { payload = body; } } as unknown as ServerResponse;
  await handleFleetControlApi({} as VerseApiContext, req, res, path, method);
  return { status, body: JSON.parse(payload) as PairedDevicesSnapshot };
}
it('projects only display fields with ISO timestamps, scope and revocation', async () => {
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), remoteDevices: () => ({ list: () => [device,
    { ...device, id: '22222222-2222-2222-2222-222222222222', scopes: { read: true, act: false }, lastUsedAt: null, revokedAt: 1800000120000 },
  ] }) });
  const result = await call();
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ v: 1, generatedAt: expect.any(String), sourceState: 'healthy', devices: [
    { id: device.id, label: device.label, email: device.email, subject: device.subject, act: true,
      createdAt: new Date(device.createdAt).toISOString(), lastUsedAt: new Date(device.lastUsedAt!).toISOString(), revokedAt: null },
    { id: '22222222-2222-2222-2222-222222222222', label: device.label, email: device.email, subject: device.subject, act: false,
      createdAt: new Date(device.createdAt).toISOString(), lastUsedAt: null, revokedAt: new Date(1800000120000).toISOString() },
  ] });
  expect(new Date(result.body.generatedAt).toISOString()).toBe(result.body.generatedAt);
});
it('clamps display strings and preserves a healthy empty registry', async () => {
  const list = vi.fn(() => [{ ...device, label: 'fake label '.repeat(25), email: 'fake email '.repeat(25), subject: 'fake subject '.repeat(25) }]);
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), remoteDevices: () => ({ list }) });
  const { body } = await call();
  for (const field of ['label', 'email', 'subject'] as const) expect(body.devices[0][field]).toHaveLength(200);
  list.mockReturnValue([]);
  expect((await call()).body).toMatchObject({ sourceState: 'healthy', devices: [] });
});
it('reports an absent registry as missing', async () => {
  // The test runner provides an isolated HOME with no remote registry.
  expect(await call()).toMatchObject({ status: 200, body: { sourceState: 'missing', devices: [] } });
});
it('rejects queries and writes before reading the store', async () => {
  const list = vi.fn(() => []);
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), remoteDevices: () => ({ list }) });
  expect((await call('GET', `${path}?extra=1`)).status).toBe(400);
  expect((await call('POST')).status).toBe(405);
  expect(list).not.toHaveBeenCalled();
});
it('fails closed with a bounded error if the registry cannot be read', async () => {
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), remoteDevices: () => ({ list() { throw new Error('fake private detail'); } }) });
  expect(await call()).toEqual({ status: 500, body: { code: 'fleet-control-failed', error: 'the remote devices request failed' } });
});
