import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet-entry.js';

const dirs: string[] = [];
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-coordination-recut64-'));
  dirs.push(dir);
  return join(dir, 'coordination.jsonl');
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('ashlr fleet coordination (recut of PR #948)', () => {
  it('answers --help through the fleet dispatcher without touching the ledger', async () => {
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['coordination', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet coordination'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Claims coordinate only'));
  });
  it('claims work and reports the board through the real command path', async () => {
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const last = () => JSON.parse(log.mock.calls.at(-1)![0]);
    expect(await cmdFleet(['coordination', 'claim', '--repo', 'ashlrai/phantom', '--task', 'Recovered verb', '--agent', 'devin', '--json'])).toBe(0);
    expect(last()).toMatchObject({ ok: true, value: { claim: { repo: 'ashlrai/phantom', agent: 'devin' } } });
    expect(await cmdFleet(['coordination', 'board', '--json'])).toBe(0);
    expect(last()).toMatchObject({ state: 'known', claims: [{ task: 'Recovered verb' }] });
  });
  it('refuses malformed sub-arguments with exit 2', async () => {
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleet(['coordination', 'bogus'])).toBe(2);
    expect(await cmdFleet(['coordination', 'claim', '--agent', 'x'])).toBe(2);
  });
});
