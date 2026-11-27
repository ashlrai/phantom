import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { busHoplogPath } from '../src/core/fleet/bus-hoplog.js';
import { cmdFleetBusHops } from '../src/cli/fleet-bus-hops.js';

let root: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-hops-'));
  vi.stubEnv('ASHLR_HOME', root);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function writeLog(rows: unknown[]): void {
  const path = busHoplogPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
}

async function run(args: string[]) {
  const index = log.mock.calls.length;
  const code = await cmdFleetBusHops(args);
  return { code, out: log.mock.calls.slice(index).map(call => String(call[0])) };
}

describe('phm fleet bus-hops', () => {
  it('prints usage for --help without touching the store', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('phm fleet bus-hops');
    expect(out.join('\n')).toContain('fleet_bus_hops');
  });

  it('reports a missing hop log as verified-empty, never invented rows', async () => {
    const human = await run([]);
    expect(human.code).toBe(0);
    expect(human.out.join('\n')).toContain('No bus hop log');
    const json = await run(['--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ sourceState: 'missing', hops: null, matched: null, returnedHops: null });
  });

  it('reports an unreadable hop log distinctly and exits nonzero', async () => {
    mkdirSync(busHoplogPath(), { recursive: true, mode: 0o700 });
    const human = await run([]);
    expect(human.code).toBe(1);
    expect(human.out.join('\n')).toContain('unreadable');
    const json = await run(['--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ sourceState: 'unreadable', hops: null });
  });

  it('prints the newest hops oldest-first with the same fields fleet_bus_hops returns', async () => {
    writeLog([
      { id: 'h1', from: 'a', to: 'b', inputTokens: 10, outputTokens: 4 },
      { id: 'h2', from: 'b', to: 'group:ops:alerts', inputTokens: null, outputTokens: 0 },
      { id: 'h3', from: 'c', to: 'd' },
    ]);
    const json = await run(['--json']);
    expect(json.code).toBe(0);
    const result = JSON.parse(json.out[0]!);
    expect(result).toMatchObject({ sourceState: 'ok', matched: 3, returnedHops: 3, skippedRows: 0, truncated: false, limit: 20 });
    expect(result.hops).toEqual([
      { id: 'h1', from: 'a', to: 'b', inputTokens: 10, outputTokens: 4 },
      { id: 'h2', from: 'b', to: 'group:ops:alerts', inputTokens: null, outputTokens: 0 },
      { id: 'h3', from: 'c', to: 'd', inputTokens: null, outputTokens: null },
    ]);
    expect(result.usageSummary).toMatchObject({ hopCount: 3 });
    const human = await run([]);
    expect(human.code).toBe(0);
    const lines = human.out.join('\n');
    expect(lines).toContain('h1');
    expect(lines).toContain('in=10 out=4');
    expect(lines).toContain('in=unknown out=0');
    expect(lines).toContain('matched=3 returned=3');
  });

  it('applies --limit as the newest-N window with matched still counting the whole filtered tail', async () => {
    writeLog([1, 2, 3, 4, 5].map(n => ({ id: `h${n}`, from: 'a', to: 'b', inputTokens: n })));
    const { code, out } = await run(['--limit', '2', '--json']);
    expect(code).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.matched).toBe(5);
    expect(result.returnedHops).toBe(2);
    expect(result.hops.map((hop: { id: string }) => hop.id)).toEqual(['h4', 'h5']);
    expect(result.truncated).toBe(true);
  });

  it('narrows on --from, --to, --exclude-from, --id, --channel and --topic with the shared bus-read rules', async () => {
    writeLog([
      { id: 'dm', from: 'a', to: 'b' },
      { id: 'room', from: 'a', to: 'group:ops:alerts' },
      { id: 'other', from: 'c', to: 'group:ops:general' },
      { id: 'eng', from: 'a', to: 'group:eng:general' },
    ]);
    const ids = async (args: string[]) => {
      const { code, out } = await run([...args, '--json']);
      expect(code).toBe(0);
      const result = JSON.parse(out[0]!);
      return { matched: result.matched, ids: result.hops.map((hop: { id: string }) => hop.id) };
    };
    // No registry: refs keep exact-label matching, never widened.
    expect(await ids(['--from', 'a'])).toEqual({ matched: 3, ids: ['dm', 'room', 'eng'] });
    expect(await ids(['--to', 'b'])).toEqual({ matched: 1, ids: ['dm'] });
    expect(await ids(['--from', 'a', '--exclude-from', 'a'])).toEqual({ matched: 0, ids: [] });
    expect(await ids(['--exclude-from', 'a'])).toEqual({ matched: 1, ids: ['other'] });
    expect(await ids(['--id', 'room'])).toEqual({ matched: 1, ids: ['room'] });
    expect(await ids(['--channel', 'ops'])).toEqual({ matched: 2, ids: ['room', 'other'] });
    expect(await ids(['--topic', 'general'])).toEqual({ matched: 2, ids: ['other', 'eng'] });
    expect(await ids(['--channel', 'ops', '--topic', 'alerts'])).toEqual({ matched: 1, ids: ['room'] });
    // A filter that matches nothing is an honest empty page, not an error.
    expect(await ids(['--from', 'nobody'])).toEqual({ matched: 0, ids: [] });
  });

  it('rejects malformed flags before touching the store', async () => {
    for (const bad of [['--help', '--json'], ['--limit'], ['--limit', '--json'], ['--limit', '0'],
      ['--limit', '51'], ['--limit', '1.5'], ['--limit', 'abc'], ['--limit', '20', '--limit', '5'],
      ['--from'], ['--from', '--json'], ['--from', 'has space'], ['--from', ''],
      ['--from', 'a', '--from', 'b'], ['--to'], ['--exclude-from', 'x y'], ['--id'],
      ['--channel'], ['--channel', '--json'], ['--channel', 'Bad Room'], ['--channel', ''],
      ['--channel', 'a', '--channel', 'b'], ['--topic'], ['--topic', 'has space'],
      ['--topic', 'x'.repeat(33)], ['--topic', 'a', '--topic', 'b'],
      ['--json', '--json'], ['--unknown'], ['hops'], ['--from=a', '--from=b']]) {
      const { code, out } = await run(bad);
      expect(code, JSON.stringify(bad)).toBe(2);
      expect(JSON.parse(out[0]!)).toEqual({ status: 'invalid' });
    }
  });
});
