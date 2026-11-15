/**
 * Unified comms inbox (`phm comms inbox [--json]`): aggregates unresolved
 * needs-you lines, unanswered teammate texts, pending drafts and unclaimed bus
 * work into one prioritized list with deep links. Hermetic: every store lives
 * under a temp dir; no network, no model calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDraft } from '../src/core/cos/drafts.js';
import { readUnifiedInbox, UNIFIED_INBOX_MAX_ITEMS, type UnifiedInbox } from '../src/core/comms/unified-inbox.js';
import { markTeammateTextsAnswered, recordTeammateText } from '../src/core/comms/imessage-teammate-inbox.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { listNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';

let root: string, runsDir: string, busRoot: string, now: number;
const roots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unified-inbox-')); roots.push(root);
  runsDir = join(root, 'runs'); mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  busRoot = join(root, 'bus'); mkdirSync(busRoot, { recursive: true, mode: 0o700 });
  now = Date.parse('2026-11-07T12:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const read = (): Promise<UnifiedInbox> => readUnifiedInbox({ runsDir, busRoot, now: () => now });

function postWork(id: string, extra: { priority?: 'P0' | 'P1' | 'P2' | 'P3'; ttl?: number; kind?: string; at?: number } = {}) {
  const receipt = appendBusInbox({
    id, from: 'leader', to: 'worker', priority: extra.priority ?? 'P2',
    ttl: extra.ttl ?? 48 * 3_600_000, body: extra.kind === 'note' ? { kind: 'note', text: 'fake note' } : { kind: 'work', text: `fake work ${id}` },
  }, { root: busRoot, now: () => extra.at ?? now });
  expect(receipt.status).toBe('posted');
  return receipt;
}
/** Write a valid v2 inbox snapshot directly: each append rewrites the whole store, so bulk setup would take tens of seconds. */
function postWorkSnapshot(ids: string[]) {
  mkdirSync(join(busRoot, 'bus-inbox'), { recursive: true, mode: 0o700 });
  const rows = ids.map((id, i) => ({
    cursor: i + 1, receivedAt: now - i * 1000,
    envelope: { id, from: 'leader', to: 'worker', priority: 'P2', ttl: 48 * 3_600_000, body: { kind: 'work', text: `fake work ${id}` } },
  }));
  writeFileSync(join(busRoot, 'bus-inbox', 'messages.json'), JSON.stringify({ version: 2, highWater: ids.length, rows }), { mode: 0o600 });
}
function claim(id: string, leaseMs = 600_000, owner = 'worker') {
  const result = mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs, root: busRoot });
  expect(result.status).toBe('acquired');
  return result;
}

describe('readUnifiedInbox sources', () => {
  it('reports empty stores with per-source state', async () => {
    const inbox = await read();
    expect(inbox).toMatchObject({
      v: 1, total: 0, omitted: 0, items: [],
      sources: {
        'needs-you': { state: 'missing', pending: 0 },
        imessage: { state: 'missing', pending: 0 },
        drafts: { state: 'healthy', pending: 0 },
        bus: { state: 'missing', pending: 0 },
      },
    });
  });

  it('lists unresolved needs-you lines as blocking warn items with resolve links', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- restart the worker pool on mac-2\n- second fake item\n');
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'needs-you');
    expect(items).toHaveLength(2);
    const restart = items.find(i => i.title === 'restart the worker pool on mac-2')!;
    expect(restart).toMatchObject({
      kind: 'needs-you', severity: 'warn', blocking: true, priority: 'now',
      act: [expect.stringMatching(/^phm fleet needs-resolve nm-[0-9a-f]{12} --reply "<reply>"$/)],
    });
    expect(restart.id).toBe(`needs-you:${listNeedsMason({ runsDir }).find(i => i.text === restart.title)!.id}`);
    expect(inbox.sources['needs-you']).toEqual({ state: 'healthy', pending: 2 });
  });

  it('lists unanswered teammate texts, ranking decision requests above chatter', async () => {
    expect(recordTeammateText({ rowid: 41, handle: '+1555fake', text: 'thanks got it' }, runsDir, new Date(now - 5 * 60_000))).toBe(true);
    expect(recordTeammateText({ rowid: 42, handle: '+1555fake', text: 'Please approve the deploy?' }, runsDir, new Date(now - 60_000))).toBe(true);
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'imessage');
    expect(items).toHaveLength(2);
    const decision = items.find(i => i.id === 'imessage:teammate-42')!;
    expect(decision).toMatchObject({
      kind: 'teammate-text', severity: 'warn', blocking: false, title: 'Please approve the deploy?',
      act: ['phm fleet teammate-texts --answered 42', expect.stringContaining('bus-claim acquire --id imessage-teammate-42')],
    });
    expect(items.find(i => i.id === 'imessage:teammate-41')).toMatchObject({ severity: 'info', priority: 'this-week' });
    expect(inbox.items.indexOf(decision)).toBeLessThan(inbox.items.indexOf(items.find(i => i.id === 'imessage:teammate-41')!));
    markTeammateTextsAnswered([41, 42], runsDir, new Date(now));
    expect((await read()).items.filter(i => i.source === 'imessage')).toHaveLength(0);
  });

  it('lists pending drafts only, with show/approve/reject links and no body', async () => {
    const pending = await createDraft({ to: 'ops@example.com', subject: 'fake subject', body: 'fake body must not appear', source: 'outbox/fake.eml' }, runsDir);
    const decided = await createDraft({ to: 'other@example.com', subject: 'fake other', body: 'fake body', source: 'outbox/other.eml' }, runsDir);
    const { approveDraft } = await import('../src/core/cos/drafts.js');
    await approveDraft(decided.id, { runsDir });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'drafts');
    expect(items.map(i => i.id)).toEqual([`drafts:${pending.id}`]);
    expect(items[0]).toMatchObject({
      kind: 'draft-approval', severity: 'info', blocking: true, priority: 'now',
      title: 'Approve outbound email to ops@example.com',
      detail: 'fake subject · digest ' + pending.digest.slice(0, 12),
      act: [`phm drafts show ${pending.id}`, `phm drafts approve ${pending.id}`, `phm drafts reject ${pending.id}`],
    });
    expect(JSON.stringify(items)).not.toContain('must not appear');
  });

  it('lists live unclaimed work envelopes and hides claimed, completed, expired and non-work records', async () => {
    postWork('unclaimed', { priority: 'P1' });
    postWork('claimed'); claim('claimed');
    postWork('completed'); const done = claim('completed');
    expect(mutateBusWorkClaim({ action: 'complete', id: 'completed', token: done.token!, root: busRoot }).status).toBe('completed');
    postWork('expired', { ttl: 1, at: now - 10_000 });
    postWork('note', { kind: 'note' });
    const inbox = await read();
    const items = inbox.items.filter(i => i.source === 'bus');
    expect(items.map(i => i.id)).toEqual(['bus:unclaimed']);
    expect(items[0]).toMatchObject({
      kind: 'bus-work', severity: 'warn', priority: 'today',
      title: 'fake work unclaimed',
      act: ['phm fleet bus-claim acquire --id unclaimed --owner <label> --lease-ms 600000'],
    });
    expect(inbox.sources.bus).toEqual({ state: 'healthy', pending: 1 });
    // The inspection view never leaks fencing tokens or lease internals.
    const table = inspectBusWorkClaims(busRoot);
    expect(table.source).toBe('available');
    expect(table.claims).toHaveLength(2);
    expect(table.claims.every(c => !('token' in c) && !('leaseMs' in c) && !('ttl' in c))).toBe(true);
  });

  it('re-lists work whose claim lease has lapsed', async () => {
    postWork('stale'); claim('stale', 1_000);
    expect((await read()).items.filter(i => i.source === 'bus')).toHaveLength(0);
    now += 2_000;
    expect((await read()).items.filter(i => i.source === 'bus').map(i => i.id)).toEqual(['bus:stale']);
  });
});

describe('readUnifiedInbox ordering and bounds', () => {
  it('orders severity band first, then priority, then expiry', async () => {
    // info band: a teammate text (this-week) and a P2 work item expiring in 2 days.
    recordTeammateText({ rowid: 50, handle: '+1555fake', text: 'status?' }, runsDir, new Date(now - 60_000));
    postWork('slow-p2', { priority: 'P2', ttl: 48 * 3_600_000 });
    // warn band: needs-you (blocking → now) and P1 work (warn → today).
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    postWork('patient-p1', { priority: 'P1', ttl: 72 * 3_600_000 });
    // high band: P0 work expiring in an hour (now) — tops the list.
    postWork('hot-p0', { priority: 'P0', ttl: 3_600_000 });
    const inbox = await read();
    expect(inbox.total).toBe(5);
    const ids = inbox.items.map(i => i.id);
    expect(ids[0]).toBe('bus:hot-p0');                                   // high band
    expect(ids[1]).toMatch(/^needs-you:nm-[0-9a-f]{12}$/);               // warn band, now
    expect(ids[2]).toBe('bus:patient-p1');                               // warn band, today
    expect(ids[3]).toBe('bus:slow-p2');                                  // info band, finite expiry first
    expect(ids[4]).toBe('imessage:teammate-50');                         // info band, no expiry
    expect(inbox.items.map(i => i.priority)).toEqual(['now', 'now', 'today', 'this-week', 'this-week']);
  });

  it('caps the items array and reports the omitted remainder', async () => {
    postWorkSnapshot(Array.from({ length: UNIFIED_INBOX_MAX_ITEMS + 5 }, (_, i) => `bulk-${String(i).padStart(4, '0')}`));
    const inbox = await read();
    expect(inbox.items).toHaveLength(UNIFIED_INBOX_MAX_ITEMS);
    expect(inbox.total).toBe(UNIFIED_INBOX_MAX_ITEMS + 5);
    expect(inbox.omitted).toBe(5);
  });
});

describe('phm comms inbox cli', () => {
  const setupCli = () => {
    const command = createCommsInboxCommand({ runsDir, busRoot });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = () => log.mock.calls.map(c => String(c[0]));
    const json = () => JSON.parse(lines().at(-1)!) as UnifiedInbox;
    return { command, lines, json };
  };

  it('prints the unified JSON report for `inbox --json`', async () => {
    const { command, json } = setupCli();
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake needs-you line\n');
    postWork('cli-work', { priority: 'P1' });
    expect(await command(['--json'])).toBe(0);
    const report = json();
    expect(report.v).toBe(1);
    expect(report.total).toBe(2);
    expect(report.items.map(i => i.source).sort()).toEqual(['bus', 'needs-you']);
    expect(report.items.every(i => i.act.length > 0)).toBe(true);
  });

  it('prints a prioritized human view for bare `inbox`', async () => {
    const { command, lines } = setupCli();
    expect(await command([])).toBe(0);
    expect(lines().at(-1)).toBe('Nothing pending.');
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- restart the worker pool\n');
    expect(await command([])).toBe(0);
    const out = lines().join('\n');
    expect(out).toContain('[now] needs-you  restart the worker pool');
    expect(out).toContain('phm fleet needs-resolve');
    expect(out).toContain('1 pending');
  });

  it('keeps read/post and help while refusing malformed unified invocations', async () => {
    const { command, lines } = setupCli();
    expect(await command(['--help'])).toBe(0);
    expect(lines().at(-1)).toContain('phm comms inbox [--json]');
    for (const args of [['--json', '--json'], ['unified'], ['--limit', '5'], ['bogus', '--json']]) {
      expect(await command(args)).toBe(2);
      expect(JSON.parse(lines().at(-1)!)).toEqual({ status: 'invalid' });
    }
    expect(await command(['read', '--json'])).toBe(0);
    expect(JSON.parse(lines().at(-1)!)).toEqual({ sourceState: 'missing', entries: [] });
  });
});
