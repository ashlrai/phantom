import { describe, expect, it, vi } from 'vitest';
import { cmdFleetReviewTake, type FleetReviewTakeDeps } from '../src/cli/fleet-review-take.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const repo = 'example/phantom';
const now = Date.parse('2026-11-14T16:00:00Z');
const lease = 'fake-release-lease';
const claim = { id: 'fake-claim', repo, task: `review ${repo}#10 example/review @${'a'.repeat(12)}`, agent: 'agent-one', claimedAt: now, expiresAt: now + 3600000 };
const empty: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 };
function deps(): FleetReviewTakeDeps {
  return {
    now: () => now,
    gh: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([{
      number: 10, title: 'Example review', headRefName: 'example/review', headRefOid: 'a'.repeat(40),
      isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
    }]) }),
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    readBoard: () => empty,
    listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
    claim: () => ({ ok: true, value: { claim, lease } }),
    release: () => ({ ok: true, value: { released: claim.id } }),
    readBoardAfter: () => ({ ...empty, claims: [claim] }),
  };
}
async function run(args: string[], overrides: FleetReviewTakeDeps = {}) {
  let stdout = '';
  let stderr = '';
  const code = await cmdFleetReviewTake(args, { ...deps(), ...overrides, stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  return { code, stdout, stderr };
}
const args = ['--agent', 'agent-one', '--repo', repo];

describe('fleet review-take CLI', () => {
  it('returns 0 with the JSON receipt and release lease on stdout only', async () => {
    const result = await run([...args, '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'fleet.review-take.v1', outcome: 'claimed', as_of: new Date(now).toISOString(),
      repo, pr: 10, head: 'example/review', head_sha: 'a'.repeat(40), title: 'Example review',
      owner: 'agent-one', claim: { id: claim.id, task: claim.task, expiresAt: claim.expiresAt }, lease,
      pick_reason: expect.stringContaining('no live claim'),
    });
    expect(Object.keys(JSON.parse(result.stdout).claim).sort()).toEqual(['expiresAt', 'id', 'task']);
  });

  it('prints one key/value per line, including lease, in text mode', async () => {
    const result = await run(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`lease: ${lease}\n`);
    expect(result.stdout).toContain(`claim.id: ${claim.id}\n`);
    expect(result.stdout.trim().split('\n').every(line => /^[\w.]+: .+/.test(line))).toBe(true);
  });

  it.each(['duplicate', 'unavailable'] as const)('returns 1 for a ledger %s', async error => {
    const result = await run([...args, '--json'], { claim: () => ({ ok: false, error }) });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: error, lease: null });
    expect(result.stderr).toBe('');
  });

  it('returns 1 for a conflict, names the foreign agent and uses our lease to release', async () => {
    const release = vi.fn(deps().release!);
    const result = await run([...args, '--json'], { release, readBoardAfter: () => ({ ...empty, claims: [{ ...claim, id: 'foreign', agent: 'agent-two' }] }) });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'conflict', owner: 'agent-two', lease: null });
    expect(release).toHaveBeenCalledWith({ id: claim.id, agent: 'agent-one', lease }, { path: undefined, now });
    expect(result.stderr).toBe('');
  });

  it('returns 1 for unavailable ownership without attempting a claim', async () => {
    const claimWriter = vi.fn(deps().claim!);
    const result = await run([...args, '--json'], { claim: claimWriter, readBoard: () => { throw new Error('fake unavailable'); } });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).outcome).toBe('unavailable');
    expect(claimWriter).not.toHaveBeenCalled();
  });

  it('returns 3 for an honest empty answer', async () => {
    const claimWriter = vi.fn(deps().claim!);
    const result = await run([...args, '--json'], { claim: claimWriter, gh: async () => ({ ok: true, stdout: '[]', stderr: '' }) });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'none', pr: null, claim: null, lease: null });
    expect(result.stderr).toBe('');
    expect(claimWriter).not.toHaveBeenCalled();
  });

  it('forwards root, limit, injected ledger path, clock and TTL', async () => {
    const gh = vi.fn(deps().gh!);
    const claimWriter = vi.fn(deps().claim!);
    const result = await run([...args, '--root', '/tmp/example-runs', '--limit', '7', '--ttl-seconds', '86400'], {
      gh, claim: claimWriter, ledgerPath: '/tmp/example-coordination.jsonl',
    });
    expect(result.code).toBe(0);
    expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['--limit', '7']));
    expect(claimWriter).toHaveBeenCalledWith({ repo, agent: 'agent-one', task: claim.task, ttlMs: 86400000 }, { path: '/tmp/example-coordination.jsonl', now });
  });

  it('documents the advisory scope and fenced release command in help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('grants no merge, push or dispatch authority');
    expect(result.stdout).toContain('ashlr fleet coordination release <claim-id> --agent <name> --lease <lease>');
  });

  it.each([
    [], ['--agent'], ['--repo', repo], [...args, '--repo', 'bad'], ['--agent', 'agent-one', '--repo', 'bad'],
    [...args, '--ttl-seconds', '0'], [...args, '--ttl-seconds', '86401'], [...args, '--ttl-seconds', '1.5'],
    [...args, '--unknown'], [...args, '--root', 'relative'], [...args, '--root'],
    [...args, '--limit', '501'], [...args, '--limit', '0'], ['--agent', 'bad name'],
    [...args, '--json', '--json'], [...args, '--agent', 'agent-two'],
  ])('returns 2 with stderr usage and no reads or writes for bad arguments %j', async (...badArgs) => {
    const gh = vi.fn(deps().gh!);
    const claimWriter = vi.fn(deps().claim!);
    const result = await run(badArgs, { gh, claim: claimWriter });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
    expect(result.stderr).not.toContain(lease);
    expect(gh).not.toHaveBeenCalled();
    expect(claimWriter).not.toHaveBeenCalled();
  });

  it('maps invalid-input from the coordination writer to usage exit 2', async () => {
    const result = await run(args, { claim: () => ({ ok: false, error: 'invalid-input' }) });
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toContain('Usage:');
  });
});
