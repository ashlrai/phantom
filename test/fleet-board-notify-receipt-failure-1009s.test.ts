import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, readBoardNotifySnapshot } from '../src/core/fleet/work-board-notify.js';

const failure = vi.hoisted(() => ({ path: '', enabled: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
    if (failure.enabled && args[0] === failure.path) throw new Error('injected ledger failure');
    return fs.appendFileSync(...args);
  } };
});

it('reports an unrecorded receipt while preserving enqueue evidence and retrying once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notify1009-root-'));
  const dir = mkdtempSync(join(tmpdir(), 'notify1009-state-'));
  chmodSync(root, 0o700); chmodSync(dir, 0o700);
  const cfg = join(dir, 'network.toml');
  writeFileSync(cfg, '[slack]\nteam_id="T0FAKEWS"\n[[slack.map]]\ntopic="fake-topic"\nchannel="C0FAKECH"\n');
  let now = Date.now();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const run = async (json = false) => {
    log.mockClear();
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...(json ? ['--json'] : [])],
      { now: () => now, killed: false, readConfig: () => loadAgentNetworkConfig({ path: cfg }) })).toBe(0);
    return log.mock.calls.map(c => String(c[0])).join('\n');
  };
  const notes = () => {
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    return page.status === 'ok' ? page.messages.filter(m => m.envelope.from === 'work-board-notify') : [];
  };
  try {
    expect(appendBusInbox({ id: 'fake-item', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
      channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
      sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true }, external: false,
      body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    await run();
    const baseline = readBoardNotifySnapshot(dir);
    now += 60_000;
    expect(postBusReply('fake-item', 'fake-block', { blocked: { dependency: 'fake-dependency' } },
      { root, now: () => now }).outcome).toBe('posted');
    failure.path = boardNotifyLedgerPath(dir); failure.enabled = true;
    const report = JSON.parse(await run(true));
    expect(report).toMatchObject({ sent: 0, queued: 1, pending: 1, deliveries: [{ status: 'unavailable',
      reason: 'ledger-append-failed', evidence: 'slack-bus-note-enqueued', transport: 'unconfirmed', duplicate: false }] });
    expect(notes()).toHaveLength(1);
    expect(readBoardNotifySnapshot(dir)).toEqual(baseline);
    const human = await run();
    expect(human).toContain('unavailable; sender evidence: queued for slack drain');
    expect(human).toContain('notification receipt unrecorded, pending retry');
    expect(human).toContain('ledger-append-failed');
    expect(notes()).toHaveLength(1);
    failure.enabled = false;
    const retry = JSON.parse(await run(true));
    expect(retry).toMatchObject({ sent: 1, queued: 1, pending: 0, deliveries: [{ status: 'duplicate', duplicate: true }] });
    expect(notes()).toHaveLength(1);
    expect(readFileSync(failure.path, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readBoardNotifySnapshot(dir)).not.toEqual(baseline);
  } finally {
    failure.enabled = false;
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
afterEach(() => vi.restoreAllMocks());
