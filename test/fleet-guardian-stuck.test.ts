import { afterEach, describe, expect, it } from 'vitest';
import { buildGuardianStuck, cmdFleetGuardianStuck } from '../src/cli/fleet-guardian-stuck.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date('2026-11-06T12:00:00Z');
const old = '2026-11-06T10:59:59Z';
const original = process.env.ASHLR_RUNS_DIR;
afterEach(() => { if (original === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = original; });

async function run(raw: string | null, args: string[] = []) {
  const logs: string[] = []; const errors: string[] = []; let path = '';
  const code = await cmdFleetGuardianStuck(args, { now: () => now, output: { log: s => logs.push(s), error: s => errors.push(s) }, readFile: p => { path = p; if (raw === null) throw new Error('missing'); return raw; } });
  return { code, logs, errors, path };
}

describe('fleet guardian-stuck', () => {
  it('reports old red entries without jobs with attempts and revert status', async () => {
    const result = await run(JSON.stringify({ repos: {
      'o/a': { state: 'red', red_first: old, attempts: 3, cur_job: '', revert_status: 'pending' },
      'o/b': { state: 'red', red_since: old, reverted: false },
    } }), ['--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.logs[0]!).stuck).toEqual([
      { repo: 'o/a', redSince: old, redMinutes: 60, attempts: 3, revertStatus: 'pending' },
      { repo: 'o/b', redSince: old, redMinutes: 60, attempts: null, revertStatus: 'not reverted' },
    ]);
    const text = await run(JSON.stringify({ 'o/a': { state: 'red', red_first: old } }));
    expect(text.logs[0]).toContain('no current job, attempts unknown, revert unknown');
  });
  it('returns healthy for green, recent, exactly 60 minutes, active, invalid job and future entries', async () => {
    const raw = JSON.stringify({
      green: { state: 'green', red_first: old }, recent: { state: 'red', red_first: '2026-11-06T11:30:00Z' },
      boundary: { state: 'red', red_first: '2026-11-06T11:00:00Z' }, active: { state: 'red', red_first: old, cur_job: 'RQ-1' },
      malformed: { state: 'red', red_first: old, cur_job: 42 }, future: { state: 'red', red_first: '2026-11-07T00:00:00Z' },
    });
    expect(await run(raw)).toMatchObject({ code: 0, logs: ['No stuck guardian entries.'] });
  });
  it('does not silently truncate after 200 repos', () => {
    const entries = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`r${i}`, { state: 'green' }]));
    entries.r200 = { state: 'red', red_first: old } as never;
    expect(buildGuardianStuck(JSON.stringify(entries), now, '/s')?.stuck.map(r => r.repo)).toEqual(['r200']);
  });
  it('fails for unread and invalid state, and rejects bad arguments', async () => {
    expect((await run(null, ['--json'])).code).toBe(1);
    expect(JSON.parse((await run('{', ['--json'])).logs[0]!).source.status).toBe('invalid');
    expect((await run('{}', ['--bad'])).code).toBe(2);
    expect(buildGuardianStuck('{"repos":[]}', now, '/s')).toBeNull();
  });
  it('uses ASHLR_RUNS_DIR and is registered', async () => {
    process.env.ASHLR_RUNS_DIR = '/tmp/guardian-test';
    expect((await run('{}')).path).toBe('/tmp/guardian-test/guardian/state.json');
    expect((await FLEET_SUBCOMMAND_LOADERS['guardian-stuck']!()).cmdFleetGuardianStuck).toBe(cmdFleetGuardianStuck);
  });
});
