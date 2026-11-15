import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetNodes } from '../src/cli/fleet-nodes.js';

const now = Date.parse('2026-11-02T12:00:30Z');
const oldHome = process.env['ASHLR_HOME'];
afterEach(() => { vi.restoreAllMocks(); if (oldHome === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = oldHome; });
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'fleet-nodes-'));
  process.env['ASHLR_HOME'] = home;
  mkdirSync(join(home, 'nodes'));
  return join(home, 'nodes', 'nodes.json');
}
function run(args: string[]) {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(s); });
  const code = cmdFleetNodes(args);
  log.mockRestore();
  return { code, output: lines.join('\n') };
}
it('reads deterministic inventory and reports heartbeat evidence in JSON and text', () => {
  const file = setup();
  const nodes = [
    { nodeId: 'fresh', session: 1, heartbeatAt: now - 30_000, expiresAt: now + 100_000, caps: ['codex'], owners: ['team'] },
    { nodeId: 'stale', session: 2, heartbeatAt: now - 120_000, expiresAt: now + 100_000 },
    { nodeId: 'unknown', session: 3, heartbeatAt: 0, expiresAt: now + 100_000 },
    { nodeId: 'offline', session: 4, heartbeatAt: now - 300_000, expiresAt: now + 100_000 },
  ];
  writeFileSync(file, JSON.stringify({ version: 'drive.nodes.v1', sequence: 4, observedAt: now, nodes, leader: null, jobs: [] }));
  const args = ['--json', '--now', new Date(now).toISOString()];
  const first = run(args);
  expect(first.code).toBe(0);
  expect(run(args)).toEqual(first);
  const result = JSON.parse(first.output);
  expect(result.sourcePath).toBe(file);
  expect(result.observedAt).toBe(new Date(now).toISOString());
  expect(result.nodes.map((n: { id: string; status: string }) => [n.id, n.status])).toEqual([['fresh', 'ready'], ['offline', 'down'], ['stale', 'stale'], ['unknown', 'unknown']]);
  expect(run(['--now', new Date(now).toISOString()]).output).toContain('stale  worker  stale  heartbeat 2m');
  expect(readFileSync(file, 'utf8')).toContain('fresh');
});
it('distinguishes missing, malformed and empty inventory without writing', () => {
  const file = setup();
  expect(run(['--json']).code).toBe(1);
  expect(readdirSync(join(file, '..'))).toEqual([]);
  writeFileSync(file, '{');
  expect(JSON.parse(run(['--json']).output).error).toBe('inventory is not valid JSON');
  writeFileSync(file, JSON.stringify({ version: 'drive.nodes.v1', sequence: 0, observedAt: 0, nodes: [], leader: null, jobs: [] }));
  expect(run(['--json']).code).toBe(0);
});
