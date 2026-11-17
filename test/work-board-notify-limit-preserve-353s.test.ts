import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, boardNotifySnapshotPath } from '../src/core/fleet/work-board-notify.js';

const ID_A = 'RQ-PHX-FAKE-353-A';
const ID_B = 'RQ-PHX-FAKE-353-B';
const ID_C = 'RQ-PHX-FAKE-353-C';
const THREAD_A = 'T0FAKEWS/C0FAKECH/1700000000.000353';
const THREAD_B = 'T0FAKEWS/C0OTHERCH/1700000000.000354';
const THREAD_C = 'T0FAKEWS/C0FAKECH/1700000000.000355';
const DEP_A = 'fake-dep-353-a';
const DEP_B = 'fake-dep-353-b';
const DEP_C = 'fake-dep-353-c';
const MAPPED = '[slack]\nteam_id="T0FAKEWS"\n[[slack.map]]\ntopic="fake-topic"\nchannel="C0FAKECH"\n';
const MAPPED_BOTH = MAPPED + '[[slack.map]]\ntopic="other-topic"\nchannel="C0OTHERCH"\n';

describe('board notifier preserves out-of-page baselines across bounded reads (353s)', () => {
  let root: string, dir: string, cfg: string, now: number;
  const priv = (p: string) => { chmodSync(p, 0o700); return p; };
  // Default senders only: the real bus reply + slack note paths. The config
  // file and --limit are the single seams that change between passes.
  const run = async (toml: string | null, args: string[] = []) => {
    if (toml === null) rmSync(cfg, { force: true });
    else writeFileSync(cfg, toml, { mode: 0o600 });
    const log = vi.mocked(console.log);
    log.mockClear();
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...args, '--json'], {
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
  const noteFor = (itemId: string) => notes().find(e => e.body.inReplyTo === itemId);
  const ledgerRows = () => existsSync(boardNotifyLedgerPath(dir))
    ? readFileSync(boardNotifyLedgerPath(dir), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const snapshotItem = (id: string) => {
    try {
      const parsed = JSON.parse(readFileSync(boardNotifySnapshotPath(dir), 'utf8')) as { items?: Array<{ id: string; state: string }> };
      return parsed.items?.find(item => item.id === id);
    } catch { return undefined; }
  };
  const snapshotIds = () => {
    try {
      const parsed = JSON.parse(readFileSync(boardNotifySnapshotPath(dir), 'utf8')) as { items?: Array<{ id: string }> };
      return (parsed.items ?? []).map(item => item.id).sort();
    } catch { return []; }
  };

  beforeEach(() => {
    root = priv(mkdtempSync(join(tmpdir(), 'notify353-root-')));
    dir = priv(mkdtempSync(join(tmpdir(), 'notify353-state-')));
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

  it('a limit=1 page processes only its row, keeps every out-of-page baseline, and each update enqueues exactly once', async () => {
    // Three fake Slack requests; board order is newest-first, so C is the
    // only row a --limit 1 page can return. B's channel stays unmapped until
    // recovery, leaving its sender unavailable while out of page.
    post(ID_A, THREAD_A);
    post(ID_B, THREAD_B);
    post(ID_C, THREAD_C);
    const page = listWorkBoard({ root, now, limit: 1 });
    expect(page.truncated).toBe(true);
    expect(page.items.map(item => item.id)).toEqual([ID_C]);

    // First pass baselines the whole board; RECEIVED never notifies.
    let pass = await run(MAPPED);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'baselined', items: 3, planned: 0 });
    expect(snapshotIds()).toEqual([ID_A, ID_B, ID_C].sort());

    // Every item earns a BLOCKED reply through the real bus reply path.
    now += 60_000;
    block(ID_A, DEP_A);
    block(ID_B, DEP_B);
    block(ID_C, DEP_C);

    // The bounded pass sees only C: exactly one note is enqueued for the
    // in-page item, and the snapshot must retain A and B's RECEIVED
    // baselines — a truncated read is a projection, not proof they vanished.
    pass = await run(MAPPED, ['--limit', '1']);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, queued: 1, pending: 0 });
    expect(pass.report.deliveries).toEqual([
      { itemId: ID_C, state: 'BLOCKED', status: 'sent',
        evidence: 'slack-bus-note-enqueued', transport: 'unconfirmed', duplicate: false },
    ]);
    expect(JSON.stringify(pass.report)).not.toMatch(/delivered|slack-delivered/);
    const noteC = noteFor(ID_C);
    expect(noteC).toMatchObject({
      to: 'fake-topic', channel: 'slack', channel_ref: THREAD_C,
      body: { kind: 'note', thread: 'slack:T0FAKEWS:C0FAKECH:1700000000.000355', inReplyTo: ID_C },
    });
    expect(noteC!.body.text).toContain(`BLOCKED ${ID_C}`);
    expect(noteC!.body.text).toContain(DEP_C);
    expect(ledgerRows()).toHaveLength(1);
    expect(ledgerRows()[0]).toMatchObject({ itemId: ID_C, state: 'BLOCKED', channel: 'slack', thread: THREAD_C });
    expect(snapshotIds()).toEqual([ID_A, ID_B, ID_C].sort());
    expect(snapshotItem(ID_A)).toMatchObject({ state: 'RECEIVED' });
    expect(snapshotItem(ID_B)).toMatchObject({ state: 'RECEIVED' });
    expect(snapshotItem(ID_C)).toMatchObject({ state: 'BLOCKED' });
    expect(noteFor(ID_A)).toBeUndefined();
    expect(noteFor(ID_B)).toBeUndefined();

    // Expanding the page surfaces the preserved baselines: A delivers on
    // its own thread, B's unavailable sender keeps it pending — its update
    // was neither consumed nor duplicated.
    now += 60_000;
    pass = await run(MAPPED);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 2, planned: 2, sent: 1, queued: 1, pending: 1 });
    const noteA = noteFor(ID_A);
    expect(noteA).toMatchObject({
      to: 'fake-topic', channel: 'slack', channel_ref: THREAD_A,
      body: { kind: 'note', thread: 'slack:T0FAKEWS:C0FAKECH:1700000000.000353', inReplyTo: ID_A },
    });
    expect(noteA!.body.text).toContain(DEP_A);
    expect(noteFor(ID_B)).toBeUndefined();
    expect(ledgerRows()).toHaveLength(2);
    expect(ledgerRows().map(r => r.itemId).sort()).toEqual([ID_A, ID_C]);
    expect(snapshotItem(ID_B)).toMatchObject({ state: 'RECEIVED' });

    // Repeated bounded and full passes: no unchanged notice repeats; B's
    // pending update keeps retrying against its preserved baseline.
    pass = await run(MAPPED, ['--limit', '1']);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0, pending: 0 });
    expect(snapshotIds()).toEqual([ID_A, ID_B, ID_C].sort());
    now += 60_000;
    pass = await run(MAPPED);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 0, pending: 1 });
    expect(pass.report.deliveries).toEqual([
      { itemId: ID_B, state: 'BLOCKED', status: 'refused', evidence: 'none', transport: 'none' },
    ]);
    expect((pass.report.lines as string[]).some(line => line.includes(ID_B) && line.includes('unmapped-channel'))).toBe(true);
    expect(notes()).toHaveLength(2);
    expect(ledgerRows()).toHaveLength(2);

    // Recovery: once B's channel is mapped its original pending update
    // enqueues exactly once, on B's own thread, with its own dependency.
    now += 60_000;
    pass = await run(MAPPED_BOTH);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, queued: 1, pending: 0 });
    const noteB = noteFor(ID_B);
    expect(noteB).toMatchObject({
      to: 'other-topic', channel: 'slack', channel_ref: THREAD_B,
      body: { kind: 'note', thread: 'slack:T0FAKEWS:C0OTHERCH:1700000000.000354', inReplyTo: ID_B },
    });
    expect(noteB!.body.text).toContain(DEP_B);
    expect(notes()).toHaveLength(3);
    expect(ledgerRows()).toHaveLength(3);
    expect(ledgerRows().map(r => r.itemId).sort()).toEqual([ID_A, ID_B, ID_C]);

    // Steady state: nothing further posts, bounded or full.
    now += 60_000;
    pass = await run(MAPPED_BOTH);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0, pending: 0 });
    pass = await run(MAPPED_BOTH, ['--limit', '1']);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0, pending: 0 });
    expect(notes()).toHaveLength(3);
    expect(ledgerRows()).toHaveLength(3);

    // A dry run mutates nothing: snapshot, ledger and bus notes are
    // byte- and count-identical afterwards.
    const snapshotBefore = readFileSync(boardNotifySnapshotPath(dir));
    const ledgerBefore = readFileSync(boardNotifyLedgerPath(dir));
    const notesBefore = notes().length;
    pass = await run(MAPPED_BOTH, ['--dry-run']);
    expect(pass.report).toMatchObject({ status: 'dry-run', transitions: 0, planned: 0, dropped: [] });
    expect(notes()).toHaveLength(notesBefore);
    expect(readFileSync(boardNotifySnapshotPath(dir)).equals(snapshotBefore)).toBe(true);
    expect(readFileSync(boardNotifyLedgerPath(dir)).equals(ledgerBefore)).toBe(true);
  });
});
