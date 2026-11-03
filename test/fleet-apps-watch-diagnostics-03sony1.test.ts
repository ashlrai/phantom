import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetAppsWatch } from '../src/cli/fleet-apps-watch.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

it('publishes changed normalized diagnostics, coalesces repeats, and reports recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-diagnostics-'));
  let output = '', clock = 0, calls = 0;
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output += s; return true; }) as never);
  const rows = [
    { outcome: 'unavailable', attempted: true, launched: false, observedRunning: false, reason: 'deadline' },
    { outcome: 'launch-failed', attempted: true, launched: false, observedRunning: false },
    { outcome: 'launch-failed', attempted: true, launched: false, observedRunning: false },
    { outcome: 'launched', attempted: true, launched: true, observedRunning: true },
  ];
  try {
    const code = await cmdFleetAppsWatch(['Phantom', '--duration-ms', '400', '--interval-ms', '100', '--max-consecutive-failures', '5', '--root', root, '--bus', '--jsonl'], {
      now: () => clock, sleep: async ms => { clock += ms; },
      runChild: async () => { const row = rows[calls++]!; return { code: row.observedRunning ? 0 : 1, stdout: JSON.stringify({ ok: row.observedRunning, apps: [{ app: 'Phantom', ...row }] }) }; },
    });
    expect(code).toBe(0);
    const local = output.trim().split('\n').map(line => JSON.parse(line));
    const page = listBusInboxAfter(0, 100, { root });
    if (page.status !== 'ok') throw new Error(page.status);
    const bus = page.messages.map(row => row.envelope.body);
    expect(bus).toHaveLength(4);
    expect(bus).toMatchObject([
      { diagnostics: [{ outcome: 'unavailable', reason: 'deadline' }] },
      { diagnostics: [{ outcome: 'launch-failed' }] },
      { diagnostics: [{ outcome: 'launched', launched: true }] },
      { lastDiagnostics: [{ outcome: 'launched', launched: true }] },
    ]);
    expect(local.at(-1).lastDiagnostics).toEqual((bus.at(-1) as { lastDiagnostics: unknown }).lastDiagnostics);
    expect(calls).toBe(4);
  } finally { write.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it('replaces malformed diagnostics with unknown and never forwards arbitrary text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-diagnostics-'));
  let output = '', clock = 0, calls = 0;
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output += s; return true; }) as never);
  try {
    await cmdFleetAppsWatch(['Phantom', '--duration-ms', '200', '--interval-ms', '100', '--max-consecutive-failures', '3', '--root', root, '--bus', '--jsonl'], {
      now: () => clock, sleep: async ms => { clock += ms; },
      runChild: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, apps: [{ app: 'Phantom', observedRunning: false, attempted: true, launched: false, outcome: calls++ ? 'arbitrary-marker' : 'timeout', reason: 'arbitrary-marker', message: 'arbitrary-marker' }] }) }),
    });
    const page = listBusInboxAfter(0, 100, { root });
    if (page.status !== 'ok') throw new Error(page.status);
    expect(output).not.toContain('arbitrary-marker');
    expect(JSON.stringify(page.messages)).not.toContain('arbitrary-marker');
    expect(JSON.parse(output.trim().split('\n').at(-1)!).lastDiagnostics).toEqual([{ app: 'Phantom', outcome: 'unknown', attempted: true, launched: false }]);
  } finally { write.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
