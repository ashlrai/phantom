import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace, readSlackTraceClaimsState } from '../src/cli/fleet-slack-trace.js';
import { readClaimThreadBindingsState } from '../src/core/fleet/claim-notice-send.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { SlackRequestTraceRead } from '../src/core/agents/slack-request-trace.js';

const at = '2025-11-07T17:00:00.000Z';
const thread = '1700000000.000100';
const channel = 'C0FAKE0001';
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 };
const trace: SlackRequestTraceRead = { asOf: at, rows: [{ at, channelId: channel, threadTs: thread, messageTs: thread, ingress: 'posted', outcome: 'answered' }], sources: { journal: 'ok', sends: 'ok' }, counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 } };
const dir = mkdtempSync(join(tmpdir(), 'slack-claim-health-'));
const path = join(dir, 'bindings.jsonl');
afterEach(() => { vi.restoreAllMocks(); rmSync(path, { force: true, recursive: true }); });

async function run(args: string[], readClaimsState: () => ReturnType<typeof readSlackTraceClaimsState>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackTrace(args, { readTrace: () => trace, readClaimsState });
  const output = log.mock.calls.map(call => String(call[0])).join('\n');
  log.mockRestore();
  return { code, output };
}
const reader = (current: FleetBoard) => () => readSlackTraceClaimsState({ readBoard: () => current, readBindings: () => readClaimThreadBindingsState(path) });

it('distinguishes known empty sources from an unknown board and corrupt bindings', async () => {
  const empty = await run(['--work-state', '--json'], reader(board));
  expect(empty.code).toBe(0);
  expect(JSON.parse(empty.output)).toMatchObject({ asOf: at, claimSources: { board: 'ok', bindings: 'ok' }, rows: [{ state: 'RECEIVED' }] });
  const unknown = await run(['--work-state', '--json'], reader({ ...board, state: 'unknown' }));
  expect(unknown.code).toBe(1);
  expect(JSON.parse(unknown.output)).toMatchObject({ claimSources: { board: 'unavailable', bindings: 'ok' }, rows: [{ state: 'RECEIVED', stateMissing: expect.arrayContaining(['ownership source unavailable: board']) }] });
  writeFileSync(path, '{bad json');
  const corrupt = await run(['--work-state'], reader(board));
  expect(corrupt.code).toBe(1);
  expect(corrupt.output).toContain('board=ok bindings=unavailable');
  expect(corrupt.output).toContain('ownership source unavailable: bindings');
  expect(corrupt.output).toContain('does not prove current runtime reachability');
  expect(corrupt.output).toContain(at);
});

it('keeps thrown reader details private and only changes verification with work-state', async () => {
  const broken = () => { throw new Error('private-path private-request'); };
  const flagged = await run(['--work-state', '--json'], broken);
  expect(flagged.code).toBe(1);
  expect(JSON.parse(flagged.output)).toMatchObject({ claimSources: { board: 'unavailable', bindings: 'unavailable' }, rows: [{ state: 'RECEIVED' }] });
  expect(flagged.output).not.toContain('private');
  const plain = await run(['--json'], broken);
  expect(plain.code).toBe(0);
  expect(JSON.parse(plain.output)).not.toHaveProperty('claimSources');
});

it('joins a named durable claim using the real binding reader', async () => {
  const claim = { id: 'claim-fake', repo: 'fake/repo', agent: 'fake-agent', task: 'fake', claimedAt: 1, expiresAt: 2 };
  writeFileSync(path, JSON.stringify({ v: 1, claimId: claim.id, repo: claim.repo, threadKey: `slack:T0FAKE0001:${channel}:${thread}` }) + '\n');
  const result = await run(['--work-state', '--json'], reader({ ...board, claims: [claim] }));
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output)).toMatchObject({ claimSources: { board: 'ok', bindings: 'ok' }, rows: [{ state: 'ASSIGNED' }] });
});
