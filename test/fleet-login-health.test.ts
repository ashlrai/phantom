import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetLoginHealth, readLoginHealth } from '../src/cli/fleet-login-health.js';

afterEach(() => vi.restoreAllMocks());
const row = (event: string, hour: number, extra = {}) => ({ event, lane: 'codex', ts: `2026-11-02T${String(hour).padStart(2, '0')}:00:00Z`, ...extra });
const reader = (...rows: unknown[]) => vi.fn(async () => rows.map(r => JSON.stringify(r)).join('\n'));

it('selects the newest expired hold by time and requires a later nonempty finish on the same lane', async () => {
  const read = reader(
    row('finish', 5, { empty: false }),
    row('autobackoff_hold', 3, { pattern: 'token_expired' }),
    row('autobackoff_hold', 1, { pattern: 'expired_old' }),
    row('autobackoff_hold', 4, { pattern: 'rate_limit' }),
    row('finish', 6, { empty: true }),
    row('autobackoff_hold', 7, { lane: 'other', pattern: 'EXPIRED' }),
    row('finish', 8, { empty: false }),
    row('finish', 9, { lane: 'other', empty: 'false' }),
    row('finish', 9, { lane: 'clean', empty: false }),
  );
  expect(await readLoginHealth(read)).toMatchObject({ status: 'ok', lanes: [
    { lane: 'clean', hold: null, recovered: null },
    { lane: 'codex', hold: { ts: row('', 3).ts, pattern: 'token_expired' }, recovered: true },
    { lane: 'other', recovered: false },
  ] });
  expect(read).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'));
});

it('a newer hold resets recovery; earlier and equal-time finishes do not recover it', async () => {
  expect(await readLoginHealth(reader(row('autobackoff_hold', 1, { pattern: 'expired' }),
    row('finish', 2, { empty: false }), row('autobackoff_hold', 3, { pattern: 'expired_again' }),
    row('finish', 3, { empty: false }), row('finish', 4)))).toMatchObject({ lanes: [{ recovered: false, hold: { pattern: 'expired_again' } }] });
});

it('distinguishes unreadable and damaged metrics from an observed empty file', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const unread = vi.fn(async (): Promise<string> => { throw new Error('private error'); });
  expect(await cmdFleetLoginHealth(['--json'], unread)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual({ schema: 'fleet.login-health.v1', status: 'unknown', lanes: null });
  await cmdFleetLoginHealth([], unread);
  expect(output.mock.calls.at(-1)![0]).toBe('Login health: unknown');
  for (const text of ['{bad', 'null', JSON.stringify({ lane: 'codex', ts: 'bad' })]) {
    expect(await readLoginHealth(async () => text)).toMatchObject({ status: 'unknown', lanes: null });
  }
  expect(await readLoginHealth(async () => '')).toMatchObject({ status: 'ok', lanes: [] });
});

it('offers plain help and rejects unknown arguments without reading', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const read = reader();
  expect(await cmdFleetLoginHealth(['--help'], read)).toBe(0);
  expect(await cmdFleetLoginHealth(['--write'], read)).toBe(2);
  expect(await cmdFleetLoginHealth(['--json', '--json'], read)).toBe(2);
  expect(read).not.toHaveBeenCalled();
  expect(await cmdFleetLoginHealth([], reader(row('finish', 1, { empty: false })))).toBe(0);
});
