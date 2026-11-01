import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi, setFleetControlDepsForTest } from '../src/core/verse/fleet-control-api.js';
import { defaultFleetControlDeps } from '../src/core/fleet/fleet-control.js';
import type { RemoteDevice } from '../src/core/web/remote-device-store.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const id = '11111111-1111-1111-1111-111111111111';
function setup(remoteAdmin: (input: unknown) => Promise<unknown>) {
  setFleetControlDepsForTest({ ...defaultFleetControlDeps(), remoteAdmin,
    remoteDevices: () => ({ list: () => [{ revokedAt: null }, { revokedAt: 1 }] as RemoteDevice[] }) });
}
afterEach(() => { setFleetControlDepsForTest(null); vi.useRealTimers(); });
async function call(route: string, body?: unknown, authorized = true, allowDispatch = true) {
  const path = `/api/verse/fleet/control/${route}`;
  const method = body === undefined ? 'GET' : 'POST';
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    url: path, method, headers: { 'content-type': 'application/json', ...(authorized ? { 'x-ashlr-token': 'test-local' } : {}) },
  }) as IncomingMessage;
  let status = 0, payload = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { payload = text; } } as unknown as ServerResponse;
  await handleFleetControlApi({ allowDispatch, token: 'test-local' } as VerseApiContext, req, res, path, method);
  return { status, body: JSON.parse(payload) };
}
it('returns the running phone URL and only public counts', async () => {
  const admin = vi.fn(async () => ({ publicOrigin: 'https://phone.example.invalid', pending: 2,
    devices: { active: 1, revoked: 3, credentialId: 'private-fixture' }, audience: 'private-fixture' }));
  setup(admin);
  const result = await call('remote-phone');
  expect(result).toEqual({ status: 200, body: { v: 1, generatedAt: expect.any(String), gateway: 'running',
    phoneUrl: 'https://phone.example.invalid/verse/m', publicOrigin: 'https://phone.example.invalid', pending: 2, devices: { active: 1, revoked: 3 } } });
  expect(admin).toHaveBeenCalledWith({ action: 'info' });
  expect(JSON.stringify(result)).not.toMatch(/credential|audience|token|private-fixture/i);
});
it('supports a running socket without an origin', async () => {
  setup(async () => ({ publicOrigin: null, pending: 0, devices: { active: 0, revoked: 0 } }));
  expect((await call('remote-phone')).body).toMatchObject({ gateway: 'running', phoneUrl: null, publicOrigin: null });
});
it.each(['ENOENT', 'ECONNREFUSED'])('falls back to registry counts for %s', async (code) => {
  setup(async () => { throw Object.assign(new Error('private-fixture'), { code }); });
  expect((await call('remote-phone')).body).toMatchObject({ gateway: 'not-running', phoneUrl: null, publicOrigin: null, pending: 0, devices: { active: 1, revoked: 1 } });
  expect((await call('remote-pending')).body).toMatchObject({ gateway: 'not-running', approvals: [] });
});
it.each(['remote-phone', 'remote-pending'])('bounds %s reads to three seconds', async (route) => {
  vi.useFakeTimers();
  setup(() => new Promise(() => {}));
  const pending = call(route);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(await pending).toMatchObject({ status: 200, body: { gateway: 'not-running' } });
  expect(vi.getTimerCount()).toBe(0);
});
it('projects pending approvals and bounds every string', async () => {
  const admin = vi.fn(async () => ({ approvals: [{ id, label: 'x'.repeat(250), email: 'email '.repeat(50), subject: 's'.repeat(250), deviceType: 'type '.repeat(50), credentialId: 'private-fixture', token: 'private-fixture' }] }));
  setup(admin);
  const result = await call('remote-pending');
  expect(result.body).toEqual({ v: 1, generatedAt: expect.any(String), gateway: 'running', approvals: [{ id, label: 'x'.repeat(200), email: 'email '.repeat(50).slice(0, 200), subject: 's'.repeat(200), deviceType: 'type '.repeat(50).slice(0, 200) }] });
  expect(admin).toHaveBeenCalledWith({ action: 'pending' });
  expect(JSON.stringify(result)).not.toMatch(/credential|audience|token|private-fixture/i);
});
it.each(['approve', 'deny'])('forwards %s after the mutation gate', async (action) => {
  const value = action === 'approve' ? { approved: true, deviceId: id } : { denied: true };
  const admin = vi.fn(async () => ({ ...value, credentialId: 'private-fixture' }));
  setup(admin);
  expect(await call('remote-pairing', { action, id })).toEqual({ status: 200, body: { v: 1, result: value } });
  expect(admin).toHaveBeenCalledWith({ action, id });
});
it('rejects bad ids, actions, missing credentials and disabled dispatch before the socket', async () => {
  const admin = vi.fn(async () => ({})); setup(admin);
  expect((await call('remote-pairing', { action: 'approve', id: 'bad' })).status).toBe(400);
  expect((await call('remote-pairing', { action: 'invite', id })).status).toBe(400);
  expect((await call('remote-pairing', { action: 'deny', id }, false)).status).toBe(401);
  expect((await call('remote-pairing', { action: 'deny', id }, true, false)).status).toBe(404);
  expect(admin).not.toHaveBeenCalled();
});
it.each([false, true])('bounds failures without leaking socket errors (reply=%s)', async (reply) => {
  setup(async () => { if (reply) return { error: 'private-fixture' }; throw new Error('private-fixture'); });
  expect(await call('remote-pairing', { action: 'approve', id })).toEqual({ status: 502, body: { code: 'remote-pairing-failed', error: 'the remote operator request failed' } });
});
it('allows the Mac dialog time and stops waiting at 70 seconds', async () => {
  vi.useFakeTimers(); setup(() => new Promise(() => {}));
  let done = false;
  const pending = call('remote-pairing', { action: 'approve', id }).then(result => { done = true; return result; });
  await vi.advanceTimersByTimeAsync(69_999); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect((await pending).status).toBe(502);
  expect(vi.getTimerCount()).toBe(0);
});
