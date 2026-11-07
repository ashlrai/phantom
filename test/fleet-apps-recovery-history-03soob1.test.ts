import { mkdtempSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetAppsHistory } from '../src/cli/fleet-apps-history.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const id = '12345678-1234-4123-8123-123456789abc';
const otherId = '12345678-1234-4123-8123-123456789abd';
const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'history-')); roots.push(dir); return dir; }
function append(dir: string, n: number, body: unknown, from = 'apps-watch') {
  expect(appendBusInbox({ id: `test-${n}`, from, to: 'leaders', priority: 'P2', ttl: 86400000, body }, { root: dir }).status).toBe('posted');
}
const observation = { kind: 'apps-watch.observation.v1', invocationId: id, cycle: 1, healthy: false, recoveries: 0, consecutiveFailures: 1, totalFailedCycles: 1, observedState: [{ app: 'Phantom', observedRunning: null }], diagnostics: [{ app: 'Phantom', outcome: 'unknown' }] };
const summary = { kind: 'apps-watch.summary.v1', invocationId: id, apps: ['Phantom'], outcome: 'failed', cycles: 1, recoveries: 0, consecutiveFailures: 1, totalFailedCycles: 1, lastObservedState: null, lastDiagnostics: null };
async function run(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { const code = await cmdFleetAppsHistory(args); return { code, output: log.mock.calls[0]?.[0] as string | undefined }; }
  finally { log.mockRestore(); error.mockRestore(); }
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('fleet apps-history', () => {
  it('projects events and resumes over unrelated and invalid rows without changing the bus', async () => {
    const dir = root();
    append(dir, 1, { secret: 'do-not-print' }, 'other');
    append(dir, 2, { ...observation, path: '/private/path' });
    append(dir, 3, { ...observation, healthy: true, diagnostics: [{ app: 'Phantom', outcome: 'bad' }] });
    append(dir, 4, { ...summary, invocationId: otherId });
    append(dir, 5, summary);
    const file = join(dir, 'bus-inbox', 'messages.json'), before = readFileSync(file, 'utf8');
    const first = await run(['--root', dir, '--limit', '1', '--invocation-id', id, '--json']);
    expect(first.code).toBe(0);
    const page = JSON.parse(first.output!);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ cursor: 2, observedState: [{ app: 'Phantom', observedRunning: null }] });
    expect(first.output).not.toContain('/private/path');
    const second = await run(['--root', dir, '--after', String(page.nextCursor), '--invocation-id', id, '--json']);
    const next = JSON.parse(second.output!);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]).toMatchObject({ cursor: 5, outcome: 'failed', lastObservedState: null });
    expect(next.nextCursor).toBe(5);
    expect(next.hasMore).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((await run(['--root', dir, '--after', '5'])).output).toContain('"events":[]');
  });
  it('handles empty, unavailable and invalid requests and registers the verb', async () => {
    const dir = root();
    expect(JSON.parse((await run(['--root', dir])).output!).events).toEqual([]);
    chmodSync(dir, 0o755);
    expect((await run(['--root', dir])).code).toBe(1);
    chmodSync(dir, 0o700);
    for (const args of [['--limit', '0'], ['--after', '-1'], ['--after', '9007199254740992'], ['--invocation-id', 'bad'], ['--json', '--json']]) expect((await run(args)).code).toBe(2);
    expect((await FLEET_SUBCOMMAND_LOADERS['apps-history']!()).cmdFleetAppsHistory).toBe(cmdFleetAppsHistory);
  });
});
