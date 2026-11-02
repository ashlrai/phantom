import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetVerdict, readFleetVerdict } from '../src/cli/fleet-verdict.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date(2026, 10, 2, 12).getTime();
const healthy = { admission: { admit: true, reason: null, load1: 2, worktrees: 7 }, lanes: { sol: { held: false } } };
function options(status: unknown = healthy, failures = 0, metrics = '') {
  const read = vi.fn(async (path: string) => {
    if (path.endsWith('/queue/status.json')) return JSON.stringify(status);
    if (path.endsWith('/metrics/jobs.jsonl')) return metrics;
    if (path.endsWith('/queue/dispatch-events.log')) return ['2026-11-02 08:00:00 OPUS-LEADER rc=0',
      ...Array.from({ length: failures }, () => '2026-11-02 09:00:00 OPUS-LEADER rc=1')].join('\n');
    throw new Error('Unexpected read');
  });
  return { read, now };
}
afterEach(() => vi.restoreAllMocks());

it('reads only the three canonical evidence files and projects typed admission', async () => {
  const opts = options();
  expect(await readFleetVerdict(opts)).toMatchObject({ overall: 'ok', admission: healthy.admission, heldLanes: [],
    checks: ['leader', 'login', 'admission', 'held-lanes'].map(name => ({ name, status: 'ok' })) });
  expect(opts.read).toHaveBeenCalledTimes(3);
});
it.each([1, 2, 3, 4])('reuses leader streaks for %i failures', async failures => {
  expect((await readFleetVerdict(options(healthy, failures))).overall).toBe(failures >= 3 ? 'down' : 'warn');
});
it('reports blocked admission and held lanes', async () => {
  expect(await readFleetVerdict(options({ admission: { ...healthy.admission, admit: false, reason: 'at cap' },
    lanes: { sol: { held: true }, astra: { held: true } } }))).toMatchObject({ overall: 'warn',
    admission: { admit: false, reason: 'at cap' }, heldLanes: ['astra', 'sol'] });
});
it('reuses expired login detection and recovery', async () => {
  const hold = JSON.stringify({ lane: 'sol', ts: '2026-11-02T09:00:00Z', event: 'autobackoff_hold', pattern: 'login expired' });
  expect((await readFleetVerdict(options(healthy, 0, hold))).checks[1]?.status).toBe('warn');
  const finish = JSON.stringify({ lane: 'sol', ts: '2026-11-02T10:00:00Z', event: 'finish', empty: false });
  expect((await readFleetVerdict(options(healthy, 0, `${hold}\n${finish}`))).overall).toBe('ok');
});
it('keeps every unread source unknown and never echoes errors', async () => {
  const report = await readFleetVerdict({ read: async () => { throw new Error('private error'); } });
  expect(report.overall).toBe('warn');
  expect(report.checks.every(check => check.status === 'unknown')).toBe(true);
  expect(JSON.stringify(report)).not.toContain('private error');
});
it.each([null, [], {}, { admission: {}, lanes: { sol: {} } }])('keeps invalid status unknown (%j)', async status => {
  const report = await readFleetVerdict(options(status));
  expect(report.checks.slice(2).map(check => check.status)).toEqual(['unknown', 'unknown']);
});
it('does not accept malformed JSON or missing measurements as healthy', async () => {
  const opts = options();
  const read = opts.read;
  expect((await readFleetVerdict({ ...opts, read: path => path.endsWith('status.json') ? Promise.resolve('{') : read(path) })).heldLanes).toBeNull();
  expect((await readFleetVerdict(options({ ...healthy, admission: { admit: true, reason: null } }))).overall).toBe('warn');
});
it('prints one line per check and a single overall word, with equivalent JSON and exit status', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVerdict([], options())).toBe(0);
  expect(log.mock.calls[0]?.[0]).toBe('leader: ok\nlogin: ok\nadmission: ok\nheld-lanes: ok\nok');
  expect(await cmdFleetVerdict(['--json'], options(healthy, 3))).toBe(1);
  expect(JSON.parse(log.mock.calls[1]?.[0] as string).overall).toBe('down');
});
it('handles help and invalid arguments without reads and registers the command', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const opts = options();
  expect(await cmdFleetVerdict(['--help'], opts)).toBe(0);
  expect(await cmdFleetVerdict(['--bad'], opts)).toBe(2);
  expect(await cmdFleetVerdict(['--json', '--json'], opts)).toBe(2);
  expect(opts.read).not.toHaveBeenCalled();
  expect((await FLEET_SUBCOMMAND_LOADERS.verdict!()).cmdFleetVerdict).toBe(cmdFleetVerdict);
});
