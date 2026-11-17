import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath } from '../src/core/fleet/work-board-notify.js';

const THREAD = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const TOML = '[slack]\nteam_id="T0FAKEWS"\n[[slack.map]]\ntopic="fake-topic"\nchannel="C0FAKECH"\n';

describe('board notifier reports Slack enqueue, not delivery (350s)', () => {
  let root: string, dir: string, cfg: string, now: number;
  const priv = (p: string) => { chmodSync(p, 0o700); return p; };
  const run = async (flags: string[] = [], toml: string | null = TOML) => {
    writeFileSync(cfg, toml ?? '', { mode: 0o600 });
    const log = vi.mocked(console.log);
    log.mockClear();
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...flags], {
      now: () => now, killed: false, readConfig: () => loadAgentNetworkConfig({ path: toml === null ? join(dir, 'absent.toml') : cfg }),
    });
    return { code, out: log.mock.calls.map(c => String(c[0])) };
  };
  const post = (id: string, channelRef?: string) => expect(appendBusInbox({
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    ...(channelRef ? { channel: 'slack', channel_ref: channelRef,
      sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true }, external: false } : {}),
    body: { kind: 'work' },
  }, { root, now: () => now }).status).toBe('posted');
  const notes = () => {
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    return page.status === 'ok' ? page.messages.map(m => m.envelope).filter(e => e.from === 'work-board-notify') : [];
  };
  const block = (id: string) => expect(postBusReply(id, `fake-blocked-${id}`, { blocked: { dependency: 'fake-dependency' } },
    { root, now: () => now }).outcome).toBe('posted');

  beforeEach(() => {
    root = priv(mkdtempSync(join(tmpdir(), 'notify350-root-')));
    dir = priv(mkdtempSync(join(tmpdir(), 'notify350-state-')));
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

  it('default Slack sender: one queued note, JSON + human say enqueue and unconfirmed delivery, repeat adds nothing', async () => {
    post('fake-slack-item', THREAD);
    expect((await run(['--json'])).code).toBe(0); // baseline
    now += 60_000;
    block('fake-slack-item');

    const first = await run(['--json']);
    expect(first.code).toBe(0);
    const report = JSON.parse(first.out.at(-1)!);
    expect(report).toMatchObject({ status: 'completed', planned: 1, sent: 1, queued: 1, busPosted: 0, pending: 0 });
    expect(report.deliveries).toEqual([{ itemId: 'fake-slack-item', state: 'BLOCKED', status: 'sent',
      evidence: 'slack-bus-note-enqueued', transport: 'unconfirmed', duplicate: false }]);
    expect(JSON.stringify(report)).not.toMatch(/delivered|slack-delivered/);

    const queued = notes();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ to: 'fake-topic', channel: 'slack', channel_ref: THREAD,
      body: { kind: 'note', thread: 'slack:T0FAKEWS:C0FAKECH:1700000000.000001', inReplyTo: 'fake-slack-item' } });
    expect(readFileSync(boardNotifyLedgerPath(dir), 'utf8')).toContain(`bus-note:${queued[0]!.id}`);

    const human = await run();
    expect(human.out.join('\n')).toContain('planned=0 receipts=0 queued=0');
    expect(notes()).toHaveLength(1);

    // Human wording on a fresh enqueue.
    now += 60_000;
    post('fake-slack-item-2', THREAD);
    await run(); now += 60_000;
    block('fake-slack-item-2');
    const text = (await run()).out.join('\n');
    expect(text).toContain('queued for slack drain, transport delivery unconfirmed');
    expect(text).toContain('queued=1');
    expect(text).not.toMatch(/^posted|delivered|sent=/m);
    expect(notes()).toHaveLength(2);
  });

  it('unmapped channel stays pending and claims neither queued nor delivered', async () => {
    const other = 'T0FAKEWS/C0OTHERCH/1700000000.000002';
    post('fake-unmapped', other);
    await run(['--json']); now += 60_000;
    block('fake-unmapped');
    const result = await run(['--json']);
    const report = JSON.parse(result.out.at(-1)!);
    expect(report).toMatchObject({ planned: 1, sent: 0, queued: 0, busPosted: 0, pending: 1 });
    expect(report.deliveries[0]).toMatchObject({ status: 'refused', evidence: 'none', transport: 'none' });
    expect(notes()).toHaveLength(0);
    const human = (await run()).out.join('\n');
    expect(human).toContain('refused');
    expect(human).toContain('unmapped-channel');
    expect(human).not.toMatch(/queued for|^posted|delivered/m);
  });

  it('without a [slack] map there is no sender: no-sender, nothing queued', async () => {
    post('fake-nomap', THREAD);
    await run(['--json'], null); now += 60_000;
    block('fake-nomap');
    const report = JSON.parse((await run(['--json'], null)).out.at(-1)!);
    expect(report).toMatchObject({ sent: 0, queued: 0, pending: 1 });
    expect(report.deliveries[0]).toMatchObject({ status: 'no-sender', evidence: 'none' });
    expect(notes()).toHaveLength(0);
  });

  it('bus-native item: durable reply is described as posted to the bus, not queued for Slack', async () => {
    post('fake-bus-item');
    await run(['--json']); now += 60_000;
    block('fake-bus-item');
    const report = JSON.parse((await run(['--json'])).out.at(-1)!);
    expect(report).toMatchObject({ sent: 1, queued: 0, busPosted: 1, pending: 0 });
    expect(report.deliveries[0]).toMatchObject({ evidence: 'bus-reply-posted', transport: 'bus-durable' });
    expect(notes()).toHaveLength(0);
  });

  it('injected senders are never promoted to confirmed Slack delivery', async () => {
    post('fake-injected', THREAD);
    const log = vi.mocked(console.log);
    const go = (flags: string[]) => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...flags], {
      now: () => now, killed: false,
      senders: { slack: () => ({ status: 'sent', receipt: 'fake-slack-receipt' }) },
    });
    await go(['--json']); now += 60_000;
    block('fake-injected');
    log.mockClear();
    await go(['--json']);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report).toMatchObject({ sent: 1, queued: 0, busPosted: 0 });
    expect(report.deliveries[0]).toMatchObject({ evidence: 'sender-receipt', transport: 'unconfirmed' });
  });
});
