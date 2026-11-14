import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath } from '../src/core/fleet/work-board-notify.js';

const THREAD_A = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const THREAD_B = 'T0FAKEWS/C0OTHERCH/1700000000.000002';
const MAPPED = '[slack]\nteam_id="T0FAKEWS"\n[[slack.map]]\ntopic="fake-topic"\nchannel="C0FAKECH"\n';
const MAPPED_BOTH = MAPPED + '[[slack.map]]\ntopic="other-topic"\nchannel="C0OTHERCH"\n';
const UNMAPPED = '[slack]\nteam_id="T0FAKEWS"\n[[slack.map]]\ntopic="unrelated-topic"\nchannel="C0UNRELATED"\n';

describe('board notifier recovers a pending notice when the Slack map appears (352s)', () => {
  let root: string, dir: string, cfg: string, now: number;
  const priv = (p: string) => { chmodSync(p, 0o700); return p; };
  // Default senders only: the real bus reply + slack note paths. The config
  // file is the single seam that changes between passes.
  const run = async (toml: string | null) => {
    if (toml === null) rmSync(cfg, { force: true });
    else writeFileSync(cfg, toml, { mode: 0o600 });
    const log = vi.mocked(console.log);
    log.mockClear();
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], {
      now: () => now, killed: false,
      readConfig: () => loadAgentNetworkConfig({ path: cfg }),
    });
    return { code, report: JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, any> };
  };
  const post = (id: string, channelRef: string) => expect(appendBusInbox({
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel: 'slack', channel_ref: channelRef,
    sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true },
    external: false, body: { kind: 'work' },
  }, { root, now: () => now }).status).toBe('posted');
  const block = (id: string, dependency: string) => expect(postBusReply(id, `fake-blocked-${id}`,
    { blocked: { dependency } }, { root, now: () => now }).outcome).toBe('posted');
  const notes = () => {
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    return page.status === 'ok'
      ? page.messages.map(m => m.envelope).filter(e => e.from === 'work-board-notify')
      : [];
  };
  const ledgerRows = () => existsSync(boardNotifyLedgerPath(dir))
    ? readFileSync(boardNotifyLedgerPath(dir), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  // Board order is inbox order, not post order; compare deliveries by item.
  const byItem = (rows: any[]) => [...rows].sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));

  beforeEach(() => {
    root = priv(mkdtempSync(join(tmpdir(), 'notify352-root-')));
    dir = priv(mkdtempSync(join(tmpdir(), 'notify352-state-')));
    cfg = join(dir, 'agent-network.toml');
    now = Date.now();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('unavailable then unmapped then mapped config: one durable note per recovered item, honest receipts', async () => {
    // Two distinct slack-sourced requests; both baseline before any mapping exists.
    post('fake-slack-a', THREAD_A);
    post('fake-slack-b', THREAD_B);
    expect((await run(null)).report).toMatchObject({ status: 'baselined', items: 2 });

    now += 60_000;
    block('fake-slack-a', 'fake-dependency-a');
    block('fake-slack-b', 'fake-dependency-b');

    // Map unavailable (no [slack] config at all): no sender, both stay pending.
    const absent = await run(null);
    expect(absent.code).toBe(0);
    expect(absent.report).toMatchObject({ status: 'completed', planned: 2, sent: 0, queued: 0, pending: 2 });
    expect(byItem(absent.report.deliveries)).toEqual([
      { itemId: 'fake-slack-a', state: 'BLOCKED', status: 'no-sender', evidence: 'none', transport: 'none' },
      { itemId: 'fake-slack-b', state: 'BLOCKED', status: 'no-sender', evidence: 'none', transport: 'none' },
    ]);
    expect(notes()).toHaveLength(0);
    expect(ledgerRows()).toHaveLength(0);
    expect(JSON.stringify(absent.report)).not.toMatch(/delivered|slack-delivered/);

    // Valid config whose map lacks both source channels: sender exists but refuses.
    now += 60_000;
    const unmapped = await run(UNMAPPED);
    expect(unmapped.report).toMatchObject({ status: 'completed', planned: 2, sent: 0, queued: 0, pending: 2 });
    expect(unmapped.report.deliveries.every((d: any) => d.status === 'refused' && d.evidence === 'none')).toBe(true);
    expect(notes()).toHaveLength(0);
    expect(ledgerRows()).toHaveLength(0);

    // Map now covers item A's channel only: exactly one note, carrying the
    // original thread ref and blocker evidence; item B's update is not consumed.
    now += 60_000;
    const recovered = await run(MAPPED);
    expect(recovered.report).toMatchObject({ status: 'completed', planned: 2, sent: 1, queued: 1, pending: 1 });
    expect(byItem(recovered.report.deliveries)).toEqual([
      { itemId: 'fake-slack-a', state: 'BLOCKED', status: 'sent',
        evidence: 'slack-bus-note-enqueued', transport: 'unconfirmed', duplicate: false },
      { itemId: 'fake-slack-b', state: 'BLOCKED', status: 'refused', evidence: 'none', transport: 'none' },
    ]);
    expect(JSON.stringify(recovered.report)).not.toMatch(/delivered|slack-delivered/);

    const queued = notes();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      to: 'fake-topic', channel: 'slack', channel_ref: THREAD_A,
      body: { kind: 'note', thread: 'slack:T0FAKEWS:C0FAKECH:1700000000.000001', inReplyTo: 'fake-slack-a' },
    });
    expect(queued[0]!.body.text).toContain('BLOCKED fake-slack-a');
    expect(queued[0]!.body.text).toContain('fake-dependency-a');
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: 'fake-slack-a', state: 'BLOCKED', channel: 'slack',
      thread: THREAD_A, receipt: `bus-note:${queued[0]!.id}` });

    // Fresh invocation on the same disk state: item A is not re-noted, item B
    // is still pending and still refused — its update was not consumed.
    now += 60_000;
    const again = await run(MAPPED);
    expect(again.report).toMatchObject({ status: 'completed', planned: 1, sent: 0, queued: 0, pending: 1 });
    expect(again.report.deliveries).toEqual([
      { itemId: 'fake-slack-b', state: 'BLOCKED', status: 'refused', evidence: 'none', transport: 'none' },
    ]);
    expect(notes()).toHaveLength(1);
    expect(ledgerRows()).toHaveLength(1);

    // When B's channel is mapped too, B's own pending update delivers with its
    // own thread and dependency — recovery of A consumed nothing of B's.
    now += 60_000;
    const both = await run(MAPPED_BOTH);
    expect(both.report).toMatchObject({ status: 'completed', planned: 1, sent: 1, queued: 1, pending: 0 });
    const all = notes();
    expect(all).toHaveLength(2);
    const noteB = all.find(e => e.body.inReplyTo === 'fake-slack-b')!;
    expect(noteB).toMatchObject({ to: 'other-topic', channel: 'slack', channel_ref: THREAD_B,
      body: { kind: 'note', thread: 'slack:T0FAKEWS:C0OTHERCH:1700000000.000002' } });
    expect(noteB.body.text).toContain('fake-dependency-b');
    expect(ledgerRows()).toHaveLength(2);

    // Steady state: nothing further posts.
    now += 60_000;
    const steady = await run(MAPPED_BOTH);
    expect(steady.report).toMatchObject({ status: 'completed', planned: 0, sent: 0, pending: 0 });
    expect(notes()).toHaveLength(2);
    expect(ledgerRows()).toHaveLength(2);
  });
});
