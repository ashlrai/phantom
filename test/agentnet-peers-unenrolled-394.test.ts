import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdAgentnet } from '../src/cli/agentnet.js';
import { listPeers } from '../src/core/agentnet/slack-identities.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'peer-unenrolled-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const binding = { callsign: 'agent1', lane: 'lane1', sessionId: 'fake-session', sessionHash: 'a'.repeat(64),
  expiresAt: 4102444800000, teamId: 'TFAKE', userId: 'UFAKE', botId: 'BFAKE', topic: 'mesh' };

it('reports a missing bindings path without creating it', () => {
  const path = join(root, 'agentnet', 'bindings.json');
  expect(listPeers(path)).toEqual({ status: 'not-enrolled', peers: [] });
  expect(existsSync(join(root, 'agentnet'))).toBe(false);
});
it('lists a valid binding without session details', () => {
  const path = join(root, 'bindings.json');
  writeFileSync(path, JSON.stringify({ version: 1, peers: [binding] }), { mode: 0o600 });
  const result = listPeers(path);
  expect(result.status).toBe('ok');
  expect(result.peers).toHaveLength(1);
  expect(result.peers[0]).not.toHaveProperty('sessionHash');
  expect(result.peers[0]).not.toHaveProperty('sessionId');
});
it('rejects public bindings files', () => {
  if (process.platform === 'win32') return;
  const path = join(root, 'bindings.json');
  writeFileSync(path, JSON.stringify({ version: 1, peers: [binding] }), { mode: 0o644 });
  expect(() => listPeers(path)).toThrow();
});
it('rejects symlinked bindings files', () => {
  const target = join(root, 'target.json'), path = join(root, 'bindings.json');
  writeFileSync(target, JSON.stringify({ version: 1, peers: [binding] }), { mode: 0o600 });
  symlinkSync(target, path);
  expect(() => listPeers(path)).toThrow();
});
it('reports missing enrollment through the CLI successfully', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdAgentnet(['peers', 'list', '--json'], { bindings: join(root, 'missing', 'bindings.json') })).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ status: 'not-enrolled', peers: [] });
});
