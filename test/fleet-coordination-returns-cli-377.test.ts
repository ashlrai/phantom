import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'returns-cli-377-'));
  dirs.push(dir);
  const path = join(dir, 'board.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  return { path };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('fleet coordination returns CLI', () => {
  it('reads receipts from the local ledger as JSON', async () => {
    const options = fixture();
    const claimed = claimFleetWork({ repo: 'example/demo', task: 'Read returns', agent: 'test-agent' }, options);
    if (!claimed.ok) throw new Error('fixture claim failed');
    expect(returnFleetClaim({ id: claimed.value.claim.id, agent: 'test-agent', lease: claimed.value.lease,
      pr: 377, head: 'abc1234' }, options).ok).toBe(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetCoordination(['returns', '--json'])).toBe(0);
    const text = log.mock.calls[0]![0] as string;
    expect(JSON.parse(text)).toMatchObject({ state: 'known', unparsed: 0, returns: [
      { claimId: claimed.value.claim.id, repo: 'example/demo', result: 'VERIFIED', evidenceKind: 'pr',
        pr: 377, head: 'abc1234', from: 'test-agent' },
    ] });
    expect(text).not.toContain('lease');
  });
  it('returns exit 1 and an honest unknown when the reader fails', async () => {
    fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetCoordination(['returns', '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ state: 'unknown', returns: [], reason: expect.any(String) });
  });
  it.each([['returns', 'extra'], ['returns', '--pr', '1'], ['returns', '--json', '--json']])('rejects unsupported arguments %j', async (...args) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetCoordination(args)).toBe(2);
    expect(log).not.toHaveBeenCalled();
  });
});
