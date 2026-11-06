import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdVerseRemote } from '../src/cli/verse-remote.js';
import type { RemoteDoctorDeps } from '../src/core/web/remote-local-doctor.js';

const fakeSubject = 'fake-subject-123';
const fakeAudience = 'a'.repeat(64);
const config = { access: { publicOrigin: 'https://phone.example.test', teamDomain: 'https://fake.cloudflareaccess.com',
  audience: fakeAudience, allowedSubjects: [fakeSubject] }, gatewayPort: 43210 };
let root: string;
let path: string;
let output: string[];
let calls: string[];
let deps: RemoteDoctorDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'remote-doctor-'));
  path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  output = [];
  calls = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });
  deps = {
    probe: async (port) => { calls.push(`probe:${port}`); return true; },
    admin: async (action) => {
      calls.push(action);
      return action === 'pending' ? { approvals: [{ subject: fakeSubject, code: 'fake-pairing-code' }] }
        : { devices: [{ revokedAt: null, email: 'fake@example.test', subject: fakeSubject, publicKey: 'fake-public-key' },
          { revokedAt: 123 }] };
    },
  };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function run(args: string[], input = deps) {
  const exit = await cmdVerseRemote(args, input);
  const text = output.join('\n');
  for (const secret of [fakeSubject, fakeAudience, 'fake-pairing-code', 'fake@example.test', 'fake-public-key']) {
    expect(text).not.toContain(secret);
  }
  expect(calls.filter((action) => !['probe:43210', 'pending', 'devices'].includes(action))).toEqual([]);
  return { exit, text };
}

describe('remote local diagnosis', () => {
  it('reports local components and explicitly unknown public evidence in stable JSON', async () => {
    const { exit, text } = await run(['status', '--config', path, '--json']);
    expect(exit).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, config: 'valid', phoneUrl: 'https://phone.example.test/verse/m/',
      gatewayPort: 43210, listener: 'listening', admin: 'available', activeDevices: 1, publicReachability: 'unknown',
      accessPolicy: 'unknown', localReady: true });
    expect(calls.sort()).toEqual(['devices', 'pending', 'probe:43210']);
  });
  it('shows a refused listener and actionable human output', async () => {
    deps.probe = async () => false;
    const { exit, text } = await run(['status', '--config', path]);
    expect(exit).toBe(1);
    expect(text).toContain('https://phone.example.test/verse/m/');
    expect(text).toContain('local listener: unavailable');
    expect(text).toContain('Check the gateway process');
    expect(text).toContain('Public reachability: unknown; Access policy: unknown');
  });
  it('reports unavailable admin and does not expose errors', async () => {
    deps.admin = async () => { throw new Error(fakeSubject); };
    const { exit, text } = await run(['status', '--json', '--config', path]);
    expect(exit).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ listener: 'listening', admin: 'unavailable', activeDevices: null });
  });
  it('reports no active devices as a blocker', async () => {
    deps.admin = async (action) => action === 'pending' ? { approvals: [] } : { devices: [{ revokedAt: 1 }] };
    const { exit, text } = await run(['status', '--config', path, '--json']);
    expect(exit).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ activeDevices: 0, localReady: false });
    expect(text).toContain('Pair and approve');
  });
  it('refuses missing, insecure, symlinked, oversized and malformed configs before probing', async () => {
    const link = join(root, 'link');
    symlinkSync(path, link);
    for (const candidate of [join(root, 'missing'), link]) {
      const { exit, text } = await run(['status', '--config', candidate, '--json']);
      expect(exit).toBe(1); expect(JSON.parse(text).config).toBe('invalid'); output = [];
    }
    chmodSync(path, 0o644);
    expect((await run(['status', '--config', path])).exit).toBe(1); output = [];
    chmodSync(path, 0o600);
    for (const content of [' '.repeat(8193), '{', JSON.stringify({ ...config, extra: true })]) {
      writeFileSync(path, content);
      expect((await run(['status', '--config', path])).exit).toBe(1); output = [];
    }
    expect(calls).toEqual([]);
  });
  it('rejects invalid arguments without probing', async () => {
    for (const args of [['status'], ['status', '--config'], ['status', '--config', path, '--json', '--json'],
      ['status', '--config', path, 'extra'], ['status', '--config', '--json']]) {
      expect((await run(args)).exit).toBe(2); output = [];
    }
    expect(calls).toEqual([]);
  });
  it('reads the existing admin protocol over a private socket without mutations', async () => {
    const { createServer } = await import('node:net');
    const socketPath = join(root, 'admin.sock');
    const server = createServer((socket) => socket.once('data', (chunk) => {
      const command = JSON.parse(chunk.toString()) as { action: string };
      calls.push(command.action);
      socket.end(JSON.stringify(command.action === 'pending' ? { approvals: [] } : { devices: [{ revokedAt: null }] }) + '\n');
    }));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    try {
      deps.admin = undefined;
      deps.adminSocketPath = socketPath;
      const { exit, text } = await run(['status', '--config', path, '--json']);
      expect(exit).toBe(0);
      expect(JSON.parse(text)).toMatchObject({ admin: 'available', activeDevices: 1 });
      expect(calls.sort()).toEqual(['devices', 'pending', 'probe:43210']);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it('uses the real bounded loopback probe for a refused port', async () => {
    deps.probe = undefined;
    deps.admin = async () => { throw new Error('unavailable'); };
    // Port zero is invalid, so obtain a temporary unused port from a local server.
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    writeFileSync(path, JSON.stringify({ ...config, gatewayPort: address.port }));
    const { exit, text } = await run(['status', '--config', path, '--json']);
    expect(exit).toBe(1); expect(JSON.parse(text).listener).toBe('unavailable');
  });
});
