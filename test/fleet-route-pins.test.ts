import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetRoutePins, routePins } from '../src/cli/fleet-route-pins.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ASHLR_RUNS_DIR;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'route-pins-'));
  dirs.push(root);
  const q = join(root, 'queue');
  mkdirSync(join(q, 'run'), { recursive: true });
  writeFileSync(join(q, 'PINNED'), 'RQ-A\nRQ-B\n\nRQ-C\nRQ-D\nRQ-A\n');
  writeFileSync(join(q, 'ready.tsv'), 'READY\tRQ-A\tclaude-api\tmid\tphantom\ttitle\nREADY\tRQ-B\tcodex\tmid\tphantom\ttitle\n');
  writeFileSync(join(q, 'router-queue.md'), '- READY RQ-C src=leader pool=devin repo=phantom\n- READY RQ-D src=leader pool=codex repo=phantom\n');
  writeFileSync(join(q, 'run', 'RQ-A.line'), 'RQ-A\t1\tclaude-api\tx\n');
  writeFileSync(join(q, 'run', 'RQ-B.line'), 'RQ-B\t1\tdevin\tx\n');
  writeFileSync(join(q, 'run', 'RQ-C.line'), 'RQ-C\t1\tdevin\tx\n');
  return root;
}

async function run(args: string[], root: string) {
  process.env.ASHLR_RUNS_DIR = root;
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const code = await cmdFleetRoutePins(args);
  return { code, lines: out.mock.calls.map(c => String(c[0])) };
}

describe('fleet route-pins', () => {
  it('is registered', () => expect(FLEET_SUBCOMMAND_LOADERS['route-pins']).toBeTypeOf('function'));

  it('prints kept, moved and not-launched with a kept rate', async () => {
    const { code, lines } = await run([], fixture());
    expect(code).toBe(0);
    expect(lines).toEqual([
      'RQ-A kept claude-api',
      'RQ-B moved codex -> devin',
      'RQ-C kept devin',
      'RQ-D not-launched',
      'kept rate 67% (2/3)',
    ]);
  });

  it('emits JSON and honors ASHLR_RUNS_DIR', async () => {
    const { lines } = await run(['--json'], fixture());
    const report = JSON.parse(lines[0]!);
    expect(report).toMatchObject({ schema: 'fleet.route-pins.v1', kept: 2, moved: 1, notLaunched: 1, keptRate: 0.667 });
    expect(report.pins[1]).toEqual({ id: 'RQ-B', state: 'moved', queued: 'codex', launched: 'devin' });
  });

  it('reports no rate when nothing launched and tolerates missing files', async () => {
    const report = await routePins({ pinned: 'RQ-X\n', readyTsv: null, routerQueue: null, runLine: async () => null });
    expect(report.keptRate).toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'route-pins-'));
    dirs.push(root);
    const { code, lines } = await run([], root);
    expect(code).toBe(0);
    expect(lines).toEqual(['No pinned jobs.', 'kept rate n/a']);
  });

  it('prefers ready.tsv over router-queue.md and rejects bad args', async () => {
    const report = await routePins({
      pinned: 'RQ-A', readyTsv: 'READY\tRQ-A\tcodex\tmid\tphantom\tt\n',
      routerQueue: '- READY RQ-A pool=devin', runLine: async () => 'RQ-A\t1\tcodex',
    });
    expect(report.pins[0]!.state).toBe('kept');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetRoutePins(['--bogus'])).toBe(2);
  });

  it('never reads outside queue/run for hostile ids', async () => {
    const runLine = vi.fn(async () => null);
    const report = await routePins({ pinned: '../../etc/passwd\nRQ-OK', readyTsv: null, routerQueue: null, runLine });
    expect(runLine).toHaveBeenCalledExactlyOnceWith('RQ-OK');
    expect(report.pins).toHaveLength(1);
  });
});
