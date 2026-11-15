import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination, FLEET_COORDINATION_HELP } from '../src/cli/fleet-coordination.js';

let dir: string;
let ledger: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'return-replay-386s-'));
  ledger = join(dir, 'board.jsonl');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('ASHLR_HOME', dir);
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
const rawOutput = () => vi.mocked(console.log).mock.calls.at(-1)![0] as string;

describe('CLI return replay evidence', () => {
  it.each([
    {
      original: ['--blocked', 'fake dependency unavailable'], retry: ['--pr', '386', '--head', 'abcdef1234567'],
      body: 'dependency fake dependency unavailable', result: 'BLOCKED', kind: 'dependency', pr: null, head: null,
      absent: ['pr #386', 'abcdef1234567'],
    },
    {
      original: ['--pr', '386', '--head', 'abcdef1234567'], retry: ['--blocked', 'fake dependency unavailable'],
      body: 'pr #386 head abcdef1234567', result: 'VERIFIED', kind: 'pr', pr: 386, head: 'abcdef1234567',
      absent: ['dependency fake dependency unavailable'],
    },
  ])('retains the original $result receipt when retry evidence differs', async ({ original, retry, body, result, kind, pr, head, absent }) => {
    expect(await cmdFleetCoordination(['claim', '--repo', 'example/fictional', '--task', 'Fake work', '--agent', 'agent-alpha', '--json'])).toBe(0);
    const { claim, lease } = output().value;
    const base = ['return', claim.id, '--agent', 'agent-alpha', '--lease', lease];
    expect(await cmdFleetCoordination([...base, ...original, '--json'])).toBe(0);
    const firstRaw = rawOutput();
    const first = output();
    expect(first).toMatchObject({ ok: true, outcome: 'returned', claimId: claim.id, message: {
      id: `return-${claim.id}`, from: 'agent-alpha', to: 'all',
      body: `RESULT ${result} example/fictional claim ${claim.id} task "Fake work": ${body}`,
    } });
    expect(firstRaw).not.toContain(lease);
    const stored = readFileSync(ledger, 'utf8');
    const events = stored.trim().split('\n').map(line => JSON.parse(line));
    const receipts = events.filter(event => event.kind === 'post' && event.message.id === `return-${claim.id}`);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].message).toEqual(first.message);

    // A new command invocation reads the persisted ledger, with conflicting retry evidence.
    expect(await cmdFleetCoordination([...base, ...retry, '--json'])).toBe(0);
    const replayRaw = rawOutput();
    expect(output()).toEqual({ ok: true, outcome: 'already-returned', claimId: claim.id, message: first.message });
    expect(replayRaw).not.toContain(lease);
    for (const text of absent) expect(replayRaw).not.toContain(text);
    expect(readFileSync(ledger, 'utf8')).toBe(stored);

    expect(await cmdFleetCoordination(['returns', '--json'])).toBe(0);
    const returnsRaw = rawOutput();
    expect(output()).toMatchObject({ state: 'known', unparsed: 0, returns: [{
      claimId: claim.id, repo: 'example/fictional', result, evidenceKind: kind,
      evidence: body, pr, head, from: first.message.from, at: new Date(first.message.at).toISOString(),
      expiresAt: new Date(first.message.expiresAt).toISOString(),
    }] });
    expect(output().returns).toHaveLength(1);
    expect(returnsRaw).not.toContain(lease);
    for (const text of absent) expect(returnsRaw).not.toContain(text);
    expect(await cmdFleetCoordination(['board', '--json'])).toBe(0);
    expect(output()).toMatchObject({ state: 'known', claims: [], messages: [first.message] });
    expect(readFileSync(ledger, 'utf8')).toBe(stored);
    expect(FLEET_COORDINATION_HELP).toContain('evidence, not authority');
    expect(FLEET_COORDINATION_HELP).toContain('does not merge, verify or close anything');
  });
});
