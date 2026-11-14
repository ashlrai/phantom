import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetReviewPick, type FleetReviewPickDeps } from '../src/mcp/fleet-review-pick.js';

const repo = 'example/phantom';
const first = Date.parse('2026-11-12T22:29:00Z');
const second = Date.parse('2026-11-13T13:13:00Z');
const privateText = '/synthetic/private/diagnostic';
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.useRealTimers();
});

it('timestamps failures and recovers with current evidence on the same MCP connection', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(first);
  let now = first;
  let resolveOld!: (value: { ok: boolean; stdout: string; stderr: string }) => void;
  const oldRead = new Promise<{ ok: boolean; stdout: string; stderr: string }>(resolve => { resolveOld = resolve; });
  const pr = (number: number, head: string) => ({ ok: true, stderr: privateText, stdout: JSON.stringify([
    { number, title: 'Review', headRefName: head, headRefOid: 'a'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: new Date(second).toISOString() },
  ]) });
  const deps: FleetReviewPickDeps = {
    timeoutMs: 10,
    now: () => now,
    gh: () => oldRead,
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    listWorkers: async () => ({ v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
  };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createFleetServer({ reviewPick: args => readFleetReviewPick(args, deps) }).connect(st);
  client = new Client({ name: 'review-recovery', version: '1' });
  await client.connect(ct);
  const call = async () => {
    const result = await client!.callTool({ name: 'fleet_review_pick', arguments: { repo } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const pending = call();
  await vi.advanceTimersByTimeAsync(10);
  const failed = await pending;
  expect(failed).toMatchObject({ as_of: new Date(first).toISOString(), picked: null, reason: 'review-pick read timed out', source: { prs: 'unavailable', unavailable: ['claimed-tsv', 'bus-work-claims', 'coordination', 'live-workers'] } });
  now = second;
  deps.gh = async () => pr(202, 'bridge/current');
  const recovered = await call();
  expect(recovered).toMatchObject({ as_of: new Date(second).toISOString(), picked: { repo, pr: 202, head: 'bridge/current', head_sha: 'a'.repeat(40), owner: 'none' } });
  resolveOld(pr(101, 'bridge/old'));
  await vi.advanceTimersByTimeAsync(0);
  expect(failed.picked).toBeNull();
  expect((await call()).picked.pr).toBe(202);
  deps.readClaimedTsv = async () => ({ state: 'healthy', get text(): string { throw new Error(privateText); } });
  const readerFailure = await call();
  expect(readerFailure).toMatchObject({ as_of: new Date(second).toISOString(), picked: null, reason: 'review-pick read unavailable', source: { prs: 'unavailable' } });
  deps.readClaimedTsv = async () => ({ state: 'healthy', text: '' });
  deps.now = () => { throw new Error(privateText); };
  const clockFailure = await call();
  expect(clockFailure).toMatchObject({ as_of: new Date(first + 10).toISOString(), picked: null, reason: 'review-pick read unavailable', source: { prs: 'unavailable' } });
  deps.now = () => Number.NaN;
  const invalidClock = await call();
  expect(invalidClock).toMatchObject({ picked: null, reason: 'review-pick read unavailable' });
  expect(new Date(invalidClock.as_of).toISOString()).toBe(invalidClock.as_of);
  expect(JSON.stringify([failed, recovered, readerFailure, clockFailure, invalidClock])).not.toContain(privateText);
});
