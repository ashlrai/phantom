import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';

let dir: string;
let ledger: string;
const now = 2_000_000;
const event = (kind: string, data: object) => ({ version: 1, kind, at: 1_000_000, ...data });
const claim = (id: string, expiresAt: number) => ({ id, repo: 'example/project', task: id, agent: 'agent-alpha', claimedAt: 1_000_000, expiresAt, leaseHash: 'a'.repeat(64) });
const message = (id: string, to: string, body: string) => ({ id, from: 'agent-beta', to, body, at: 1_000_000, expiresAt: 3_000_000 });
const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coord-observe-544s-'));
  ledger = join(dir, 'board.jsonl');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('ASHLR_HOME', dir);
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('coordination CLI observation', () => {
  it('repeats board, inbox and returns without writing expired claims or artifacts', async () => {
    const events = [
      event('claim', { claim: claim('expired', 1_500_000) }),
      event('claim', { claim: claim('live', 3_000_000) }),
      event('post', { message: message('targeted', 'agent-alpha', 'Targeted message') }),
      event('post', { message: message('other', 'agent-other', 'Other message') }),
      event('post', { message: message('return-expired', 'all', 'RESULT VERIFIED example/project claim expired task "expired": tests passed') }),
      event('assign', { proposal: { id: 'proposal', repo: 'example/project', task: 'next', to: 'agent-alpha', at: 1_000_000, expiresAt: 3_000_000, executionAuthorized: false } }),
    ];
    writeFileSync(ledger, events.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
    const before = readFileSync(ledger);
    const entries = readdirSync(dir);
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const sub of ['board', 'inbox', 'returns']) {
        const clock = vi.fn(() => now);
        const args = sub === 'inbox' ? [sub, '--agent', 'agent-alpha', '--json'] : [sub, '--json'];
        expect(await cmdFleetCoordination(args, { now: clock })).toBe(0);
        expect(clock).toHaveBeenCalledTimes(1);
        const result = output();
        expect(result.state).toBe('known');
        if (sub === 'board') {
          expect(result.expiredClaims).toBe(1);
          expect(result.claims).toMatchObject([{ id: 'live', agent: 'agent-alpha' }]);
          expect(result.messages.map((m: { id: string }) => m.id)).toEqual(['targeted', 'other', 'return-expired']);
        } else if (sub === 'inbox') {
          expect(result.messages.map((m: { id: string }) => m.id)).toEqual(['targeted', 'return-expired']);
          expect(result.proposals).toMatchObject([{ id: 'proposal', to: 'agent-alpha' }]);
        } else {
          expect(result.asOf).toBe(new Date(now).toISOString());
          expect(result.returns).toMatchObject([{ claimId: 'expired', temporal: 'current', evidenceKind: 'tests' }]);
        }
        expect(readFileSync(ledger)).toEqual(before);
        expect(readdirSync(dir)).toEqual(entries);
        expect(readFileSync(ledger, 'utf8')).not.toMatch(/"kind":"(?:release|reap)"/);
      }
    }
  });

  it.each(['board', 'inbox', 'returns'])('reports unavailable ledger safely for %s', async sub => {
    writeFileSync(ledger, 'invalid\n', { mode: 0o600 });
    const before = readFileSync(ledger);
    const args = sub === 'inbox' ? [sub, '--agent', 'agent-alpha', '--json'] : [sub, '--json'];
    expect(await cmdFleetCoordination(args, { now: () => now })).toBe(1);
    expect(output()).toMatchObject({ state: 'unknown' });
    expect(JSON.stringify(output())).not.toMatch(/ENOENT|EACCES|Invalid ledger|board\.jsonl/);
    expect(console.error).not.toHaveBeenCalled();
    expect(readFileSync(ledger)).toEqual(before);
    expect(readdirSync(dir)).toEqual(['board.jsonl']);
  });
});
