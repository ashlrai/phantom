/**
 * fleet-desktop-errors-cli.test.ts — `ashlr fleet desktop-errors` output
 * (RQ-PHX-DESKTOPCRASHREPORT100). Empty ledger message, grouped text and
 * --json output, arg validation, and the generated registry's loader.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDesktopErrors } from '../src/cli/fleet-desktop-errors.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { recordDesktopError, type DesktopErrorInput } from '../src/core/verse/desktop-error-report.js';

const dir = () => mkdtemp(join(tmpdir(), 'fleet-desktop-errors-'));

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { out.push(String(line ?? '')); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; });
  const code = await fn();
  return { code, out: out.join('\n'), err: err.join('') };
}

const crash = (over: Partial<DesktopErrorInput> = {}): DesktopErrorInput => ({
  surface: 'route:fleet',
  message: 'Cannot read properties of undefined',
  stack: 'TypeError: boom\n    at FleetView.render (~/app/FleetView.tsx:10:2)',
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('fleet desktop-errors', () => {
  it('prints the empty message and exits 0 when no ledger exists', async () => {
    const result = await capture(() => cmdFleetDesktopErrors([], { runsDir: join(tmpdir(), 'no-such-runs-dir') }));
    expect(result.code).toBe(0);
    expect(result.out).toBe('No desktop errors recorded.');
  });

  it.each([[[]], [['--json']]])('reports an unreadable ledger as an error %j', async (args) => {
    const runsDir = await dir();
    await mkdir(join(runsDir, 'desktop', 'errors.jsonl'), { recursive: true });
    const result = await capture(() => cmdFleetDesktopErrors(args, { runsDir }));
    expect(result).toEqual({ code: 1, out: '', err: 'error: unable to read desktop errors\n' });
  });

  it('groups two crashes in text output', async () => {
    const runsDir = await dir();
    const now = Date.now();
    await recordDesktopError(runsDir, crash(), now - 3 * 3_600_000);
    await recordDesktopError(runsDir, crash(), now - 60_000);
    await recordDesktopError(runsDir, crash({ surface: 'pane:diff-pane', message: 'Diff exploded' }), now - 2 * 3_600_000);
    const result = await capture(() => cmdFleetDesktopErrors([], { runsDir }));
    expect(result.code).toBe(0);
    const rows = result.out.split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('route:fleet');
    expect(rows[0]).toContain('x2');
    expect(rows[0]).toContain(new Date(now - 60_000).toISOString());
    expect(rows[0]).toContain('Cannot read properties of undefined');
    expect(rows[1]).toContain('pane:diff-pane');
    expect(rows[1]).toContain('x1');
    expect(rows[1]).toContain('Diff exploded');
  });

  it('emits the same groups under --json', async () => {
    const runsDir = await dir();
    const now = Date.now();
    await recordDesktopError(runsDir, crash(), now - 60_000);
    await recordDesktopError(runsDir, crash({ surface: 'dock-helper:fleet-workspace-auto-open', message: 'helper died' }), now - 30_000);
    const result = await capture(() => cmdFleetDesktopErrors(['--json'], { runsDir }));
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out) as { v: number; errors: Array<Record<string, unknown>> };
    expect(payload.v).toBe(1);
    expect(payload.errors).toHaveLength(2);
    expect(payload.errors[0]).toMatchObject({ surface: 'dock-helper:fleet-workspace-auto-open', count: 1, message: 'helper died' });
    expect(payload.errors[1]).toMatchObject({ surface: 'route:fleet', count: 1 });
  });

  it('honours --since and refuses bad arguments', async () => {
    const runsDir = await dir();
    const now = Date.now();
    await recordDesktopError(runsDir, crash(), now - 2 * 3_600_000);
    const outside = await capture(() => cmdFleetDesktopErrors(['--since', '1h'], { runsDir }));
    expect(outside.out).toBe('No desktop errors recorded.');
    const inside = await capture(() => cmdFleetDesktopErrors(['--since', '3h'], { runsDir }));
    expect(inside.out).toContain('route:fleet');
    expect((await capture(() => cmdFleetDesktopErrors(['--since'], { runsDir }))).code).toBe(2);
    expect((await capture(() => cmdFleetDesktopErrors(['--since', 'tomorrow'], { runsDir }))).code).toBe(2);
    expect((await capture(() => cmdFleetDesktopErrors(['--bogus'], { runsDir }))).code).toBe(2);
    expect((await capture(() => cmdFleetDesktopErrors(['--help'], { runsDir }))).code).toBe(0);
  });

  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['desktop-errors']!()).cmdFleetDesktopErrors).toBe(cmdFleetDesktopErrors);
  });
});
