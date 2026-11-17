import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'return-live-382s-'));
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', join(dir, 'board.jsonl'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);

it.each(['--artifact', '--tests'])('preserves a live claim after an oversized assembled %s receipt', async flag => {
  const repo = 'example/repo';
  const task = 'Review the local result';
  const agent = 'local-reviewer';
  expect(await cmdFleetCoordination(['claim', '--repo', repo, '--task', task, '--agent', agent, '--json'])).toBe(0);
  const { claim, lease } = output().value as { claim: { id: string; agent: string }; lease: string };
  expect(lease).toBeTruthy();
  vi.mocked(console.log).mockClear(); // Claim output intentionally delivers the lease to its owner.
  vi.mocked(console.error).mockClear();

  const kind = flag.slice(2);
  const prefix = `RESULT VERIFIED ${repo} claim ${claim.id} task "${task}": ${kind} `;
  const evidence = 'x'.repeat(4001 - prefix.length);
  expect(evidence.length).toBeLessThan(4000);
  expect((prefix + evidence).length).toBe(4001);
  const args = ['return', claim.id, '--agent', agent, '--lease', lease];
  expect(await cmdFleetCoordination([...args, flag, evidence, '--json'])).toBe(2);
  expect(output()).toMatchObject({ ok: false, outcome: 'invalid-input', claimId: claim.id });
  expect(await cmdFleetCoordination(['board', '--json'])).toBe(0);
  expect(output()).toMatchObject({ state: 'known', claims: [claim], messages: [] });
  expect(await cmdFleetCoordination(['returns', '--json'])).toBe(0);
  expect(output()).toMatchObject({ state: 'known', returns: [], unparsed: 0 });

  expect(await cmdFleetCoordination([...args, flag, 'checks passed', '--json'])).toBe(0);
  expect(output()).toMatchObject({ ok: true, outcome: 'returned', claimId: claim.id });
  expect(await cmdFleetCoordination(['board', '--json'])).toBe(0);
  expect(output()).toMatchObject({ state: 'known', claims: [], messages: [{ id: `return-${claim.id}` }] });
  expect(await cmdFleetCoordination(['returns', '--json'])).toBe(0);
  expect(output()).toMatchObject({ state: 'known', unparsed: 0, returns: [{ claimId: claim.id, repo, from: agent, evidenceKind: kind, evidence: `${kind} checks passed` }] });
  for (const call of [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]) {
    expect(JSON.stringify(call)).not.toContain(lease);
  }
});
