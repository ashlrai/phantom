import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { parseFleetReviewPickArgs, readFleetReviewPick, type FleetReviewPickDeps } from '../src/mcp/fleet-review-pick.js';

const repo = 'example/phantom';
const now = Date.parse('2026-11-14T16:00:00Z');
function sources(): FleetReviewPickDeps {
  return {
    now: vi.fn(() => now),
    gh: vi.fn(async () => ({ ok: true, stderr: '/synthetic/private/stderr', stdout: JSON.stringify([
      { number: 101, title: 'Review example', headRefName: 'bridge/example', headRefOid: 'a'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: new Date(now).toISOString() },
    ]) })),
    readClaimedTsv: vi.fn(async () => ({ state: 'healthy' as const, text: '' })),
    inspectBusWork: vi.fn(() => ({ source: 'available' as const, claims: [] })),
    readBoard: vi.fn(() => ({ schema: 'fleet.coordination.v1' as const, state: 'known' as const, claims: [], messages: [], proposals: [], expiredClaims: 0 })),
    listWorkers: vi.fn(async () => ({ v: 1 as const, generatedAt: new Date(now).toISOString(), sourceState: 'healthy' as const, workers: [], leaders: [], orchestratorAgents: 0 })),
  };
}
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function connect(reviewPick: FleetReaders['reviewPick']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createFleetServer({ reviewPick }).connect(st);
  const client = new Client({ name: 'review-example', version: '1.0.0' });
  clients.push(client);
  await client.connect(ct);
  return client;
}
function body(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

describe('fleet_review_pick MCP boundary (374)', () => {
  it.each(['root', 'path', 'cwd', 'runsDir', 'timeoutMs'])('rejects unknown %s before dispatch', async key => {
    expect(parseFleetReviewPickArgs({ [key]: '/synthetic/private' })).toBeNull();
    const read = vi.fn();
    const client = await connect(read);
    await expect(client.callTool({ name: 'fleet_review_pick', arguments: { [key]: '/synthetic/private' } })).rejects.toMatchObject({ code: -32602 });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{ repo: 'bad' }, { repo: null }, { repo: '/synthetic/private' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '1' }, { limit: null }])('reports invalid values without collection: %j', async args => {
    const deps = sources();
    const client = await connect(input => readFleetReviewPick(input, deps));
    expect(body(await client.callTool({ name: 'fleet_review_pick', arguments: args }))).toMatchObject({ status: 'invalid' });
    for (const reader of Object.values(deps)) expect(reader).not.toHaveBeenCalled();
  });

  it('advertises the strict read-only tool and returns the real pick through dispatch', async () => {
    const deps = sources();
    const client = await connect(input => readFleetReviewPick(input, deps));
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_review_pick');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    const result = body(await client.callTool({ name: 'fleet_review_pick', arguments: { repo, limit: 5 } }));
    expect(result).toMatchObject({ schema: 'fleet.review-pick.v1', picked: { repo, pr: 101, head: 'bridge/example', head_sha: 'a'.repeat(40), owner: 'none' } });
    expect(deps.gh).toHaveBeenCalledWith(expect.arrayContaining(['--repo', repo, '--limit', '5']));
    expect(JSON.stringify(result)).not.toContain('/synthetic/');
  });

  it('uses the default repository and limit', async () => {
    const deps = sources();
    await readFleetReviewPick({}, deps);
    expect(deps.gh).toHaveBeenCalledWith(expect.arrayContaining(['--repo', 'ashlrai/phantom', '--limit', '100']));
  });

  it('withholds the pick when one ownership source fails and recovers on the same connection', async () => {
    const deps = sources();
    const healthy = deps.readBoard;
    deps.readBoard = () => { throw new Error('/synthetic/private/board'); };
    const client = await connect(input => readFleetReviewPick(input, deps));
    const result = body(await client.callTool({ name: 'fleet_review_pick', arguments: { repo } }));
    expect(result).toMatchObject({ picked: null, reason: 'ownership source unavailable', source: { unavailable: ['coordination'] } });
    expect(JSON.stringify(result)).not.toContain('/synthetic/');
    deps.readBoard = healthy;
    expect(body(await client.callTool({ name: 'fleet_review_pick', arguments: { repo } }))).toMatchObject({ picked: { owner: 'none' } });
  });

  it('bounds the whole read even when gh never settles', async () => {
    vi.useFakeTimers();
    const deps = sources();
    deps.gh = () => new Promise(() => {});
    const pending = readFleetReviewPick({ repo }, { ...deps, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject({ schema: 'fleet.review-pick.v1', picked: null, reason: 'review-pick read timed out', source: { prs: 'unavailable' } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes paths embedded in public PR prose', async () => {
    vi.stubEnv('HOME', '/synthetic/home');
    const deps = sources();
    deps.gh = async () => ({ ok: true, stderr: '/synthetic/private/stderr', stdout: JSON.stringify([
      { number: 101, title: 'Review /synthetic/home/private', headRefName: 'bridge/example', headRefOid: 'a'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: new Date(now).toISOString() },
    ]) });
    const result = await readFleetReviewPick({ repo }, deps);
    expect(result).toMatchObject({ picked: { title: 'Review ~/private' } });
    expect(JSON.stringify(result)).not.toContain('/synthetic/');
  });

  it('scrubs public output and never returns thrown messages or stderr', async () => {
    const deps = sources();
    deps.gh = async () => { throw new Error('/synthetic/private/failure'); };
    expect(JSON.stringify(await readFleetReviewPick({ repo }, deps))).not.toContain('/synthetic/');
    deps.now = () => { throw new Error('/synthetic/private/clock'); };
    expect(await readFleetReviewPick({ repo }, deps)).toMatchObject({ picked: null, reason: 'review-pick read unavailable' });
  });
});
