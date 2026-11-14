import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination, FLEET_COORDINATION_HELP } from '../src/cli/fleet-coordination.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'return-cli-375-'));
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', join(dir, 'board.jsonl'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);
async function claim(task = 'CLI return') {
  expect(await cmdFleetCoordination(['claim', '--repo', 'ashlrai/phantom', '--task', task, '--agent', 'test-agent', '--json'])).toBe(0);
  return output().value;
}
describe('coordination return CLI', () => {
  it.each([
    ['--tests', 'passed', '--artifact', 'report'], ['--pr', '375'], ['--pr', '375', '--head', 'not-hex'],
    ['--head', 'abcdef1'], ['--pr', '-1', '--head', 'abcdef1'], [], ['--tests', 'passed', '--ttl-seconds', '604801'],
  ])('rejects invalid result arguments %j with exit 2', async (...args: string[]) => {
    expect(await cmdFleetCoordination(['return', 'claim-1', '--agent', 'test-agent', '--lease', 'fake-lease', ...args])).toBe(2);
  });
  it('requires the lease', async () => {
    expect(await cmdFleetCoordination(['return', 'claim-1', '--agent', 'test-agent', '--tests', 'passed'])).toBe(2);
  });
  it('returns successfully and preserves claim, release and board parsing', async () => {
    const first = await claim();
    const args = ['return', first.claim.id, '--agent', 'test-agent', '--lease', first.lease, '--pr', '375', '--head', 'abcdef1', '--json'];
    expect(await cmdFleetCoordination(args)).toBe(0);
    expect(output()).toMatchObject({ ok: true, outcome: 'returned' });
    expect(await cmdFleetCoordination(args)).toBe(0);
    expect(output().outcome).toBe('already-returned');
    const second = await claim('Release smoke');
    expect(await cmdFleetCoordination(['release', second.claim.id, '--agent', 'test-agent', '--lease', second.lease, '--json'])).toBe(0);
    expect(await cmdFleetCoordination(['board', '--json'])).toBe(0);
    expect(output()).toMatchObject({ claims: [], messages: [{ id: `return-${first.claim.id}` }] });
  });
  it('returns exit 1 for a missing claim and documents the authority boundary', async () => {
    await claim();
    expect(await cmdFleetCoordination(['return', 'missing', '--agent', 'test-agent', '--lease', 'fake', '--blocked', 'upstream', '--json'])).toBe(1);
    expect(output().outcome).toBe('not-found');
    expect(FLEET_COORDINATION_HELP).toContain('evidence, not authority');
    expect(FLEET_COORDINATION_HELP).toContain('does not merge, verify or close anything');
    expect(FLEET_COORDINATION_HELP).toContain('lease fences only release');
  });
});
