import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetReviewPick, type FleetReviewPickDeps } from '../src/mcp/fleet-review-pick.js';

const repo = 'example/phantom';
const t0 = Date.parse('2026-11-12T22:27:00Z');
const t1 = Date.parse('2026-11-13T13:13:00Z');
const SHA_A = 'a'.repeat(40);
const SHA_A2 = 'c'.repeat(40);
const SHA_B = 'b'.repeat(40);
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.useRealTimers();
});

const pr = (number: number, head: string, sha: string) => ({
  number, title: `Review ${number}`, headRefName: head, headRefOid: sha,
  isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-13T12:00:00Z',
});
const openPrs = (...rows: ReturnType<typeof pr>[]) => ({ ok: true, stderr: '', stdout: JSON.stringify(rows) });

it('re-reads open PRs on every call: closed PRs are never re-offered and empty lists pick null', async () => {
  let now = t0;
  let ghResult = openPrs(pr(101, 'bridge/a', SHA_A));
  const ghCalls: string[][] = [];
  const deps: FleetReviewPickDeps = {
    timeoutMs: 10_000,
    now: () => now,
    gh: async args => {
      ghCalls.push([...args]);
      return ghResult;
    },
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    listWorkers: async () => ({ v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
  };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createFleetServer({ reviewPick: args => readFleetReviewPick(args, deps) }).connect(st);
  client = new Client({ name: 'review-closed-return', version: '1' });
  await client.connect(ct);
  const call = async () => {
    const result = await client!.callTool({ name: 'fleet_review_pick', arguments: { repo } });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  };
  const expectOpenPrRead = () => {
    const args = ghCalls.at(-1)!;
    expect(args).toContain('--state');
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args).toContain(repo);
  };

  const first = await call();
  expect(first).toMatchObject({
    schema: 'fleet.review-pick.v1', as_of: new Date(t0).toISOString(), repo,
    source: { prs: 'read', unavailable: [] },
    picked: { repo, pr: 101, head: 'bridge/a', head_sha: SHA_A, owner: 'none' },
  });
  expect(first.picked.owner).toBe('none');
  expectOpenPrRead();

  now = t1;
  ghResult = openPrs(pr(202, 'bridge/b', SHA_B));
  const second = await call();
  expect(second).toMatchObject({
    as_of: new Date(t1).toISOString(),
    picked: { repo, pr: 202, head: 'bridge/b', head_sha: SHA_B, owner: 'none' },
  });
  expect(second.picked.pr).not.toBe(first.picked.pr);
  expect(second.picked.head_sha).not.toBe(first.picked.head_sha);
  expectOpenPrRead();

  ghResult = openPrs();
  const empty = await call();
  expect(empty).toMatchObject({ as_of: new Date(t1).toISOString(), picked: null, reason: 'no open PRs', unowned_candidates: 0 });
  expectOpenPrRead();

  ghResult = openPrs(pr(101, 'bridge/a-v2', SHA_A2));
  const reopened = await call();
  expect(reopened).toMatchObject({
    as_of: new Date(t1).toISOString(),
    picked: { repo, pr: 101, head: 'bridge/a-v2', head_sha: SHA_A2, owner: 'none' },
  });
  expectOpenPrRead();

  expect(ghCalls).toHaveLength(4);
  expect(first.picked).toMatchObject({ pr: 101, head_sha: SHA_A });
  expect(second.picked.head_sha).toBe(SHA_B);
});
