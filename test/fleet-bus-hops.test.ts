import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusHop, busHoplogPath } from '../src/core/fleet/bus-hoplog.js';
import { readFleetBusHops } from '../src/core/fleet/bus-hops.js';
import { cmdFleetBusHops } from '../src/cli/fleet-bus-hops.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-hops-'));
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const hop = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  ({ id, from, to, ...extra });

describe('phm fleet bus-hops', () => {
  it('reports a verified-empty log as no hops, never unknown', async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((text: string) => { out.push(text); });
    try {
      expect(await cmdFleetBusHops([])).toBe(0);
      expect(out[0]).toBe('No bus hops recorded.');
      const view = readFleetBusHops();
      expect(view).toMatchObject({ sourceState: 'missing', hops: null, matched: null, logBytes: null });
    } finally { log.mockRestore(); }
  });

  it('lists seeded hops oldest-first with usage and honest unknown tokens', async () => {
    expect(appendBusHop(hop('m-1', 'devin', 'leaders', { inputTokens: 120, outputTokens: 30 }))).toBe(true);
    expect(appendBusHop(hop('m-2', 'leaders', 'devin'))).toBe(true);
    expect(appendBusHop(hop('m-3', 'claude', 'devin', { inputTokens: 7 }))).toBe(true);
    const view = readFleetBusHops();
    expect(view.sourceState).toBe('ok');
    expect(view.hops).toEqual([
      { id: 'm-1', from: 'devin', to: 'leaders', inputTokens: 120, outputTokens: 30 },
      { id: 'm-2', from: 'leaders', to: 'devin', inputTokens: null, outputTokens: null },
      { id: 'm-3', from: 'claude', to: 'devin', inputTokens: 7, outputTokens: null },
    ]);
    expect(view.matched).toBe(3);
    expect(view.returnedHops).toBe(3);
    expect(view.usageSummary).toMatchObject({ hopCount: 3,
      input: { knownSamples: 2, unknownSamples: 1 },
      output: { knownSamples: 1, unknownSamples: 2 } });
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((text: string) => { out.push(text); });
    try {
      expect(await cmdFleetBusHops(['--json'])).toBe(0);
      const printed = JSON.parse(out[0]!);
      expect(printed).toMatchObject({ sourceState: 'ok', matched: 3, returnedHops: 3 });
      expect(printed.hops).toHaveLength(3);
      expect(out[0]).not.toContain('body');
    } finally { log.mockRestore(); }
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((value: string) => { lines.push(String(value)); });
    try {
      expect(await cmdFleetBusHops([])).toBe(0);
      expect(lines[0]).toContain('m-1  devin → leaders  in=120 out=30');
      expect(lines[0]).toContain('m-2  leaders → devin  in=unknown out=unknown');
      expect(lines.join('\n')).toContain('3 of 3 matched hops');
    } finally { spy.mockRestore(); }
  });

  it('applies the same from/to/exclude-from/id/limit filters the MCP read shares', async () => {
    appendBusHop(hop('m-1', 'devin', 'leaders', { inputTokens: 1 }));
    appendBusHop(hop('m-2', 'claude', 'devin', { inputTokens: 2 }));
    appendBusHop(hop('m-3', 'devin', 'claude', { inputTokens: 3 }));
    expect(readFleetBusHops({ from: 'devin' }).hops?.map(h => h.id)).toEqual(['m-1', 'm-3']);
    expect(readFleetBusHops({ to: 'devin' }).hops?.map(h => h.id)).toEqual(['m-2']);
    expect(readFleetBusHops({ excludeFrom: 'devin' }).hops?.map(h => h.id)).toEqual(['m-2']);
    expect(readFleetBusHops({ from: 'devin', excludeFrom: 'devin' }).hops).toEqual([]);
    expect(readFleetBusHops({ id: 'm-2' }).hops?.map(h => h.id)).toEqual(['m-2']);
    expect(readFleetBusHops({ id: 'm-9' }).matched).toBe(0);
    expect(readFleetBusHops({ limit: 2 }).hops?.map(h => h.id)).toEqual(['m-2', 'm-3']);
    // The CLI refuses malformed filters before touching the store.
    for (const bad of [['--limit'], ['--limit', '0'], ['--limit', '51'], ['--limit', 'abc'],
      ['--from'], ['--from', '--json'], ['--id', 'has space'], ['--unknown'], ['--json', '--json'],
      ['--limit', '2', '--limit', '3']]) {
      expect(await cmdFleetBusHops(bad)).toBe(2);
    }
    expect(await cmdFleetBusHops(['--help'])).toBe(0);
  });

  it('reports an unreadable log as unknown, never an empty page', async () => {
    // A present hop file that fails the private-file custody check reads
    // 'unreadable': the CLI says unknown and exits 1 rather than claiming none.
    mkdirSync(join(root, 'fleet', 'bus'), { recursive: true, mode: 0o700 });
    writeFileSync(busHoplogPath(), '{"id":"m-1","from":"a","to":"b"}\n', { mode: 0o644 });
    chmodSync(busHoplogPath(), 0o644);
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((text: string) => { out.push(text); });
    try {
      expect(await cmdFleetBusHops([])).toBe(1);
      expect(out[0]).toBe('Bus hops unknown.');
      expect(readFleetBusHops().sourceState).toBe('unreadable');
    } finally { log.mockRestore(); }
  });
});
