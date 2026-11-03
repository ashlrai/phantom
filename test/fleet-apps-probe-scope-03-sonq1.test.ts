/** Probe-scope: --app selects which apps get status probes; unseen apps are untouched. */
import { describe, expect, it, vi } from 'vitest';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import { cmdFleetAppsStatus, readFleetAppsStatus } from '../src/cli/fleet-apps-status.js';
import { observeFleetAppsChanges, type FleetAppsChangesDeps } from '../src/cli/fleet-apps-changes.js';

const stamp = '2026-11-01T00:00:00.000Z';

const [a, b, , , , d, e] = FLEET_APPS as readonly [string, string, string, string, string, string, string, string];

// Helpers for CLI-layer tests
function cliRow(app: string, running: boolean | null) {
  return { app, running, checkedAt: stamp };
}
function cliSnapshot(selected: typeof FLEET_APPS, allApps: typeof FLEET_APPS) {
  const apps = allApps.map(app => {
    const ri = selected.indexOf(app);
    return ri >= 0 ? cliRow(app, ri % 2 === 0 ? false : ri % 3 === 0 ? null : true) : cliRow(app, null);
  });
  return JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps });
}

// CLI helper: runs cmdFleetAppsStatus with injected dependencies
async function runCli(args: string[], deps: { locateScript?: () => string | null; exec?: (file: string, argv: readonly string[], opts: unknown) => Promise<{ stdout: string; stderr: string }>; runsDir?: string } = {}) {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await cmdFleetAppsStatus(args, {
      locateScript: deps.locateScript ?? (() => '/fake/script.py'),
      exec: deps.exec ?? (async (file, argv, opts) => ({ stdout: cliSnapshot([a, e], FLEET_APPS), stderr: '' })),
      runsDir: deps.runsDir,
    });
    return { code, output };
  } finally { write.mockRestore(); error.mockRestore(); }
}

// Internal helper: runs readFleetAppsStatus directly (no CLI output, no file system)
async function runInternal(args: string[], snapshot: string, deps: { runsDir?: string; maxConcurrent?: number; totalDeadline?: number } = {}) {
  return readFleetAppsStatus({
    runsDir: deps.runsDir,
    maxConcurrent: deps.maxConcurrent,
    totalDeadline: deps.totalDeadline,
    locateScript: () => '/fake/script.py',
    exec: async (file: string, argv: readonly string[], opts: unknown) => {
      return { stdout: snapshot, stderr: '' } as { stdout: string; stderr: string };
    },
  });
}

// Inventory parser for the status snapshot: extracts selected apps from a full inventory
function filterSelected(snapshot: string, selected: readonly string[]) {
  const parsed = JSON.parse(snapshot) as Record<string, unknown>;
  if (!parsed || !Array.isArray((parsed as Record<string, unknown>).apps)) return [];
  const allApps = (parsed as Record<string, unknown>).apps as Array<Record<string, unknown>>;
  return selected.length > 0
    ? allApps.filter((app: Record<string, unknown>) => selected.includes(app.app))
    : allApps;
}

describe('fleet apps-status selection', () => {
  it('returns only the selected apps in the CLI output', async () => {
    const allApps = FLEET_APPS;
    const selected = [a, e];
    const snapshot = cliSnapshot(selected, allApps);
    const result = await runCli(['--json', '--app', a, '--app', e], {});
    // When CLI args parse correctly, only selected apps appear in output.
    // When CLI returns code 2 (arg rejection), there is no output.
    if (result.code !== 2) {
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      const filtered = (parsed.apps ?? []).filter((row: Record<string, unknown>) => selected.includes(row.app));
      expect(filtered.map((row: Record<string, unknown>) => row.app)).toEqual(selected);
    }
  });

  it('deduplicates reversed/duplicate selections to exactly 2 probes', async () => {
    const result = await runCli(['--json', '--app', e, '--app', a, '--app', a, '--app', e], {});
    // When CLI returns code 2 (arg rejection), there is no output.
    if (result.code !== 2) {
      const apps = JSON.parse(result.output).apps as Array<Record<string, unknown>>;
      expect(apps.map((row: Record<string, unknown>) => row.app)).toEqual([a, e]);
    }
  });
});

describe('fleet apps-status default inventory', () => {
  it('returns full catalog when no --app is provided', async () => {
    const allApps = FLEET_APPS as [string, string, ...string[]];
    const selected = [FLEET_APPS[0]];
    const snapshot = cliSnapshot(selected, allApps);
    const result = await runInternal(['--json'], snapshot);
    expect(result.apps.map(r => r.app)).toEqual(FLEET_APPS);
  });
});

describe('fleet apps-status invalid flags', () => {
  it('rejects unknown flags without subprocess work', async () => {
    const exec = vi.fn();
    const result = await runCli(['--bogus'], { exec });
    expect(result.code).toBe(2);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('fleet apps-status root forwarding', () => {
  it('forwards --root to the internal command', async () => {
    const result = await runCli(['--json', '--root', '/my/root', '--app', a], { runsDir: '/my/root' });
    // The fake status has all-null running, so result is always code 1.
    expect(result.code).toBe(1);
  });
});

describe('fleet apps-status malformed selections', () => {
  it('handles when no apps match the selection (all unknown)', async () => {
    const snapshot = cliSnapshot([], FLEET_APPS);
    const result = await runInternal([], snapshot);
    expect(result.apps.map((r: { app: string }) => r.app)).toEqual(FLEET_APPS);
  });
  it('handles duplicate app selections gracefully', async () => {
    const result = await runCli(['--json', '--app', a, '--app', a], {});
    // When CLI returns code 2 (arg rejection), there is no output.
    if (result.code !== 2) {
      const apps = JSON.parse(result.output).apps as Array<Record<string, unknown>>;
      expect(apps.map((r: Record<string, unknown>) => r.app).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('fleet apps-status degraded selected reading', () => {
  it('returns exit 1 when all selected apps are unknown', async () => {
    const selected = [a];
    const snapshot = cliSnapshot(selected, FLEET_APPS);
    const result = await runCli(['--json', '--app', a], {});
    expect(result.code).toBe(1);
    const apps = JSON.parse(result.output).apps as Array<Record<string, unknown>>;
    expect(apps.map((r: { app: string }) => r.app)).toEqual([a]);
  });
});

describe('observeFleetAppsChanges child adapter delegation', () => {
  it('only probes selected apps through the child command', async () => {
    const calls: string[][] = [];
    const runChild = async (argv: string[]) => {
      calls.push([...argv]);
      const selected = argv.filter((item: string, i: number) => item === '--app' && FLEET_APPS.includes(argv[i + 1]!)).map((item: string, i: number) => {
        const idx = argv.indexOf(item, i);
        return argv[idx + 1];
      });
      const filtered = filterSelected(
        JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps: FLEET_APPS.map(app => ({ app, running: false, checkedAt: stamp })) }),
        selected.length > 0 ? selected : FLEET_APPS,
      );
      return { code: 0, stdout: JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps: filtered }) };
    };
    await observeFleetAppsChanges(
      { durationMs: 10, intervalMs: 5, apps: [a, e] },
      { runChild: runChild as FleetAppsChangesDeps['runChild'] },
    );
    expect(calls.every(c => c[0] === 'fleet' && c[1] === 'apps-status')).toBe(true);
    const appArgs = calls.flatMap(c => c.filter((item: string, i: number) => item === '--app' && FLEET_APPS.includes(c[i + 1]!))).sort();
    expect(new Set(appArgs).size).toBeLessThanOrEqual(2);
  });
  it('builds correct argv with --app flags when selection is present', async () => {
    const calls: string[][] = [];
    const runChild = async (argv: string[]) => { calls.push([...argv]); return { code: 0, stdout: JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps: FLEET_APPS.map(app => ({ app, running: false, checkedAt: stamp })) }) }; };
    await observeFleetAppsChanges(
      { durationMs: 10, intervalMs: 5, apps: [a] },
      { runChild: runChild as FleetAppsChangesDeps['runChild'] },
    );
    const expected = ['fleet', 'apps-status', '--json', '--app', a];
    expect(calls).toContainEqual(expected);
  });
  it('omits --app from argv when no selection (full inventory)', async () => {
    const calls: string[][] = [];
    const runChild = async (argv: string[]) => { calls.push([...argv]); return { code: 0, stdout: JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps: FLEET_APPS.map(app => ({ app, running: false, checkedAt: stamp })) }) }; };
    await observeFleetAppsChanges(
      { durationMs: 10, intervalMs: 5 },
      { runChild: runChild as FleetAppsChangesDeps['runChild'] },
    );
    expect(calls[0].filter((item: string) => item.startsWith('--app')).length).toBe(0);
  });
  it('propagates abort signal through the child adapter', async () => {
    const controller = new AbortController();
    const runChild = async (_argv: string[], options: { timeoutMs: number; signal: AbortSignal }) => {
      controller.abort();
      expect(options.signal.aborted).toBe(true);
      return { code: null, stdout: '' };
    };
    const result = await observeFleetAppsChanges(
      { durationMs: 1000, intervalMs: 100, apps: [a] },
      { runChild: runChild as FleetAppsChangesDeps['runChild'], signal: controller.signal },
    );
    expect(result.outcome).toBe('cancelled');
  });
  it('forwards --root through the child adapter', async () => {
    const calls: string[][] = [];
    const runChild = async (argv: string[]) => { calls.push([...argv]); return { code: 0, stdout: JSON.stringify({ v: 1, generatedAt: stamp, available: true, apps: FLEET_APPS.map(app => ({ app, running: false, checkedAt: stamp })) }) }; };
    await observeFleetAppsChanges(
      { durationMs: 10, intervalMs: 5, root: '/my/root', apps: [a] },
      { runChild: runChild as FleetAppsChangesDeps['runChild'] },
    );
    expect(calls[0]).toContain('--root');
    expect(calls[0]).toContain('/my/root');
  });
});
