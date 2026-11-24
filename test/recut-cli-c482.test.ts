import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdGraph } from '../src/cli/graph.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('recovers explicit graph status through the CLI without rewriting either source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recut-cli-c482-'));
  roots.push(root);
  const fleet = join(root, 'fleet.json'), seats = join(root, 'seats.json');
  const fleetText = JSON.stringify({ schema: 'fleet.v1', agents: [], mcp: [], edges: [] });
  writeFileSync(fleet, fleetText);
  writeFileSync(seats, '[]');
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdGraph(['status', '--fleet', fleet, '--seats', seats, '--json'])).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
    schema: 'graph.v1', complete: true, sources: { fleet: 'loaded', seats: 'loaded' }, nodes: [], edges: [],
  });
  expect(readFileSync(fleet, 'utf8')).toBe(fleetText);
  expect(readFileSync(seats, 'utf8')).toBe('[]');

  output.mockClear();
  writeFileSync(seats, JSON.stringify({ privateDetail: 'withheld-marker' }));
  expect(await cmdGraph(['status', '--fleet', fleet, '--seats', seats, '--json'])).toBe(1);
  const text = String(output.mock.calls[0]![0]);
  expect(JSON.parse(text)).toMatchObject({ complete: false, sources: { seats: 'invalid' } });
  expect(text).not.toContain('withheld-marker');
  expect(text).not.toContain(root);
});
