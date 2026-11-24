import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimNoticeSlackSender } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { claimFleetWork, postFleetMessage, readFleetBoard, releaseFleetClaim,
  type FleetCoordinationResult } from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination failed: ${result.error}`);
  return result.value;
}
interface Row { envelope: { id: string; channel_ref: string; body: { text: string; thread: string; inReplyTo: string } } }

it('keeps real cross-repository transitions in their source threads across reloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-cross-repo-495s-'));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  const root = join(dir, 'runs');
  const bus = join(dir, 'bus');
  const ledger = join(dir, 'coordination.jsonl');
  const paths = claimNoticePaths(root);
  const refs = ['T000FAKE/C000FAKE/1700000000.000001', 'slack:T000FAKE:C000FAKE:1700000000.000002'];
  const canonical = ['slack:T000FAKE:C000FAKE:1700000000.000001', refs[1]!];
  const config: AgentNetworkConfig = { path: 'synthetic', state: 'ok', teamIdentities: [],
    slack: { bridgeId: 'slack', teamId: 'T000FAKE', map: [{ topic: 'fleet.claims', channel: 'C000FAKE' }] } };
  let now = Date.parse('2026-11-16T00:00:00Z');
  const options = () => ({ path: ledger, now: now += 1000 });
  const pass = () => {
    now += 1000;
    return runClaimNoticePass({ ...claimNoticeFileDeps(root), readBoard: () => readFleetBoard({ path: ledger, now }),
      send: claimNoticeSlackSender(bus, () => config), now: () => now });
  };
  const rows = (): Row[] => (JSON.parse(readFileSync(join(bus, 'bus-inbox', 'messages.json'), 'utf8')) as { rows: Row[] }).rows;
  const sent = (): { key: string }[] => readFileSync(paths.sent, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  must(postFleetMessage({ from: 'fake-seed', to: 'all', body: 'seed', ttlMs: 1 }, options()));
  expect(await pass()).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
  const a = must(claimFleetWork({ repo: 'fake/alpha', task: 'alpha task', agent: 'owner-alpha' }, options()));
  const b = must(claimFleetWork({ repo: 'fake/beta', task: 'beta task', agent: 'owner-beta' }, options()));
  const claims = [a.claim, b.claim];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i]!;
    expect(appendClaimThreadBinding(paths.bindings, { claimId: claim.id, repo: claim.repo,
      threadKey: refs[i]!, pr: i + 1, head: 'abcdef1234567' }, now).ok).toBe(true);
  }
  const first = await pass();
  expect(first).toMatchObject({ status: 'completed', planned: 2, sent: 2, failed: 0 });
  const initial = rows();
  expect(initial).toHaveLength(2);
  expect(new Set(initial.map(row => row.envelope.id)).size).toBe(2);
  expect(sent()).toHaveLength(2);
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i]!;
    const key = JSON.stringify(['ASSIGNED', claim.id, 'abcdef1234567']);
    const id = `claim-notice-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
    const row = initial.find(item => item.envelope.id === id)!;
    expect(row.envelope).toMatchObject({ id, channel_ref: refs[i], body: { thread: canonical[i], inReplyTo: key } });
    expect(row.envelope.body.text).toContain(claim.repo);
    expect(row.envelope.body.text).toContain(claim.agent);
    expect(row.envelope.body.text).not.toContain(claims[1 - i]!.repo);
    expect(row.envelope.body.text).not.toContain(claims[1 - i]!.agent);
    expect(first.deliveries.find(d => d.dedupeKey === key)).toMatchObject({ receipt: `bus-note:${id}`, threadKey: refs[i] });
    expect(sent().some(entry => entry.key === key)).toBe(true);
  }
  const beforeBus = readFileSync(join(bus, 'bus-inbox', 'messages.json'));
  const beforeSent = readFileSync(paths.sent);
  expect(await pass()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
  expect(readFileSync(join(bus, 'bus-inbox', 'messages.json'))).toEqual(beforeBus);
  expect(readFileSync(paths.sent)).toEqual(beforeSent);
  must(releaseFleetClaim({ id: a.claim.id, agent: a.claim.agent, lease: a.lease }, options()));
  const transition = await pass();
  expect(transition).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
  expect(transition.deliveries[0]).toMatchObject({ state: 'RELEASED', threadKey: refs[0] });
  const after = rows();
  expect(after).toHaveLength(3);
  expect(sent()).toHaveLength(3);
  const added = after[2]!.envelope;
  expect(added).toMatchObject({ channel_ref: refs[0], body: { thread: canonical[0] } });
  expect(added.body.text).toContain('fake/alpha');
  expect(added.body.text).not.toContain('fake/beta');
  expect(transition.deliveries[0]!.receipt).toBe(`bus-note:${added.id}`);
  expect(sent()[2]!.key).toBe(added.body.inReplyTo);
  // A bus-note receipt proves durable enqueue only; no Slack transport runs here.
});
