/** RQ-PHX-ORDERSLACKVERIFY363: the Slack order → work-board result bridge.
 * A merged job cited by a Slack order becomes one `verified {artifact}`
 * result receipt on that order's existing work-board item, written through
 * postBusReply (the `ashlr fleet work-result` writer) once. Tmp dirs and
 * plainly fake ids only; no network, no Slack sends, no credentials. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { applyOrderResults, leaderNetworkItemResolver, orderResultsLedgerPath, planOrderResults,
  type OrderItemResolver } from '../src/core/fleet/order-result-bridge.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import { cmdFleetOrderResults } from '../src/cli/fleet-order-results.js';

const ITEM_ID = 'slack-owner-fake363item';
const REQUEST_ID = createHash('sha256').update(JSON.stringify(['slack', ITEM_ID])).digest('hex');
const JOB_ID = 'RQ-FAKE-363';
const PR_URL = 'https://github.com/ashlrai/phantom/pull/363';
const ENVELOPE: BusEnvelope = {
  id: ITEM_ID, from: 'mason', to: 'leader', priority: 'P0', ttl: 86_400_000,
  body: { kind: 'work' }, channel: 'slack', channel_ref: 'slack:TFAKE:CFAKE:1700000000.0001',
  sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true }, external: false,
};

let runsDir: string, busRoot: string;
const cleanups: string[] = [];
const mktemp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  cleanups.push(dir);
  return dir;
};
beforeEach(() => { runsDir = mktemp('order-results-363-runs-'); busRoot = mktemp('order-results-363-bus-'); });
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A Slack-order trace fixture: heading tag → requestId → durable route →
 * bus item → merged RQ job with a github pull URL. */
function seedSlackOrder(): void {
  mkdirSync(join(runsDir, 'leader'), { recursive: true });
  mkdirSync(join(runsDir, 'metrics'), { recursive: true });
  writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'),
    `\n## 2026-11-13 13:13 ET (Operator, slack) PRIORITY P0 [request-sha256:${'b'.repeat(64)}] [leader-network:${REQUEST_ID}]\nFake bridge order text.\n`);
  writeFileSync(join(runsDir, `${JOB_ID}.prompt`), `Serves Mason's Nov 13 13:13 order — fake bridge test.\n`);
  writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'),
    `${JSON.stringify({ job: JOB_ID, state: 'MERGED', url: PR_URL })}\n`);
  writeFileSync(join(runsDir, 'leader', 'network-state.json'), JSON.stringify({
    version: 1, startedAt: 1, lastMasonAt: 1,
    routes: { [REQUEST_ID]: { channel: 'slack', recipient: 'UFAKEOWNER',
      channelRef: ENVELOPE.channel_ref, receivedAt: 1, inbox: true, bus: true,
      fingerprint: 'f'.repeat(64), message: ENVELOPE } },
    digests: {},
  }));
  expect(appendBusInbox(ENVELOPE, { root: busRoot }).status).toBe('posted');
}

const trace = (order: Partial<OrderTraceV1['orders'][number]> = {}): OrderTraceV1 => ({
  v: 1, generatedAt: '2026-11-14T00:00:00.000Z',
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '2026-11-13 13:13', source: 'slack', requestId: REQUEST_ID, key: '11-13 13:13',
    jobs: [{ id: JOB_ID, lane: 'fake-lane', state: 'merged', url: PR_URL }], ...order }],
});
const resolved: OrderItemResolver = () => ITEM_ID;
const unresolved: OrderItemResolver = () => undefined;
const invoke = async (args: string[]) => {
  const out: string[] = [];
  const code = await cmdFleetOrderResults(args, { busRoot, output: line => out.push(line) });
  return { code, out: out.join('\n'), json: () => JSON.parse(out.join('')) as { apply: boolean; planned: unknown[]; written?: number; skipped?: number; failed?: number } };
};

describe('parseInbox [leader-network] tag', () => {
  it('parses requestId from a heading tag and leaves untagged headings exactly as before', () => {
    const tagged = parseInbox(`\n## 2026-11-13 13:13 ET (Operator, slack) PRIORITY P0 [request-sha256:${'b'.repeat(64)}] [leader-network:${'a'.repeat(64)}]\nFake order text.\n`);
    expect(tagged[0]).toMatchObject({ at: '2026-11-13 13:13', source: 'slack', priority: 'P0',
      requestId: 'a'.repeat(64), text: 'Fake order text.' });
    const plain = parseInbox('\n## 2026-11-13 13:13 ET (Operator, slack) PRIORITY P0\nFake order text.\n');
    expect(plain[0]).toEqual({ at: '2026-11-13 13:13', source: 'slack', priority: 'P0', text: 'Fake order text.' });
    expect('requestId' in plain[0]!).toBe(false);
  });
});

describe('planOrderResults', () => {
  it('plans one verified {artifact} result for a merged job with a github pull URL', () => {
    const plan = planOrderResults(trace(), resolved);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ key: `${REQUEST_ID}:${JOB_ID}`, requestId: REQUEST_ID,
      itemId: ITEM_ID, jobId: JOB_ID, artifact: PR_URL, body: { verified: { artifact: PR_URL } } });
  });
  it.each([['queued'], ['launched'], ['published']] as const)('plans nothing for a %s job', state => {
    expect(planOrderResults(trace({ jobs: [{ id: JOB_ID, lane: 'fake-lane', state, url: PR_URL }] }), resolved)).toEqual([]);
  });
  it('plans nothing for a non-PR url', () => {
    expect(planOrderResults(trace({ jobs: [{ id: JOB_ID, lane: 'fake-lane', state: 'merged', url: 'https://example.com/fake' }] }), resolved)).toEqual([]);
  });
  it('plans nothing for a non-Slack source', () => {
    expect(planOrderResults(trace({ source: 'Phantom desktop' }), resolved)).toEqual([]);
  });
  it('plans nothing when the item cannot be resolved', () => {
    expect(planOrderResults(trace(), unresolved)).toEqual([]);
  });
});

describe('leaderNetworkItemResolver', () => {
  it('resolves the stored envelope id and refuses a route whose key does not recompute', () => {
    mkdirSync(join(runsDir, 'leader'), { recursive: true });
    writeFileSync(join(runsDir, 'leader', 'network-state.json'), JSON.stringify({ version: 1, startedAt: 1, lastMasonAt: 1,
      routes: { [REQUEST_ID]: { channel: 'slack', recipient: 'UFAKEOWNER', channelRef: 'slack:T:C:1.1',
          receivedAt: 1, inbox: true, bus: true, fingerprint: 'f'.repeat(64), message: ENVELOPE },
        ['c'.repeat(64)]: { channel: 'slack', recipient: 'UFAKEOWNER', channelRef: 'slack:T:C:1.1',
          receivedAt: 1, inbox: true, bus: true, fingerprint: 'f'.repeat(64), message: ENVELOPE } },
      digests: {} }));
    const resolve = leaderNetworkItemResolver(runsDir);
    expect(resolve(REQUEST_ID)).toBe(ITEM_ID);
    // The second route's key is not the hash of its stored envelope id.
    expect(resolve('c'.repeat(64))).toBeUndefined();
    expect(resolve('d'.repeat(64))).toBeUndefined();
  });
});

describe('ashlr fleet order-results', () => {
  it('dry run lists the plan and writes nothing', async () => {
    seedSlackOrder();
    const run = await invoke(['--runs-dir', runsDir]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`${ITEM_ID}: verified artifact=${PR_URL}`);
    expect(run.out).toContain('dry run: 1 results');
    expect(existsSync(orderResultsLedgerPath(runsDir))).toBe(false);
    const page = listBusInboxAfter(0, 100, { root: busRoot });
    expect(page.status === 'ok' ? page.messages.map(m => m.envelope.id) : []).toEqual([ITEM_ID]);
  });
  it('--apply writes one receipt, twice applies write once, and the item shows verified evidence', async () => {
    seedSlackOrder();
    const first = await invoke(['--apply', '--json', '--runs-dir', runsDir]);
    expect(first.code).toBe(0);
    expect(first.json()).toMatchObject({ apply: true, written: 1, skipped: 0, failed: 0 });
    const second = await invoke(['--apply', '--json', '--runs-dir', runsDir]);
    expect(second.json()).toMatchObject({ apply: true, written: 0, skipped: 1, failed: 0 });
    const rows = readFileSync(orderResultsLedgerPath(runsDir), 'utf8').split('\n').filter(l => l.includes('"written"'));
    expect(rows).toHaveLength(1);
    const page = listBusInboxAfter(0, 100, { root: busRoot });
    const replies = page.status === 'ok' ? page.messages.filter(m => m.envelope.id.startsWith('order-result-')) : [];
    expect(replies).toHaveLength(1);
    expect(replies[0]!.envelope.body).toEqual({ verified: { artifact: PR_URL }, inReplyTo: ITEM_ID });
    // The board's own evidence reader now proves the item VERIFIED — what board-notify reads.
    expect(collectBusWorkItemEvidence(ITEM_ID, { root: busRoot, now: Date.now() }).evidence.verified)
      .toMatchObject({ artifact: PR_URL, source: `bus-reply:${replies[0]!.envelope.id}` });
  });
  it('a writer failure writes no ledger row', async () => {
    seedSlackOrder();
    rmSync(join(busRoot, 'bus-inbox', 'messages.json'));
    const run = await invoke(['--apply', '--json', '--runs-dir', runsDir]);
    expect(run.code).toBe(0);
    expect(run.json()).toMatchObject({ apply: true, written: 0, skipped: 0, failed: 1 });
    expect(existsSync(orderResultsLedgerPath(runsDir))).toBe(false);
  });
  it('applyOrderResults counts a contended lock as nothing written', async () => {
    seedSlackOrder();
    const planned = planOrderResults(trace(), resolved);
    const counts = await applyOrderResults(runsDir, planned, { busRoot });
    expect(counts).toEqual({ written: 1, skipped: 0, failed: 0 });
  });
});
