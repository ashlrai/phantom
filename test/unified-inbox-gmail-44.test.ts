/** Unified comms inbox, gmail source: one item per saved archive plan that is over its unread target. Hermetic: fake plans and temp dirs. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUnifiedInbox, type UnifiedInbox } from '../src/core/comms/unified-inbox.js';
import { gmailArchivePlanLatestPath, GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, type GmailArchivePlanEntry } from '../src/core/comms/gmail-archive-plan-latest.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
let root: string, runsDir: string, busRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unified-inbox-gmail-'));
  runsDir = join(root, 'runs'); mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  busRoot = join(root, 'bus'); mkdirSync(busRoot, { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const plan = (over: Partial<GmailArchivePlanEntry> = {}): GmailArchivePlanEntry => ({
  inbox: 'work@example.test', at: '2026-11-09T11:00:00Z', unread: 120, target: 100, archiveCount: 20,
  topSenders: [{ sender: 'a@example.test', count: 9 }, { sender: 'b@example.test', count: 4 }], ...over,
});
const withPlans = (plans: GmailArchivePlanEntry[]): Promise<UnifiedInbox> => readUnifiedInbox({
  runsDir, busRoot, now: () => NOW,
  readGmailPlans: () => ({ schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, plans }),
});

describe('unified inbox gmail source', () => {
  it('lists an over-target inbox as a non-blocking warn item', async () => {
    const inbox = await withPlans([plan()]);
    const item = inbox.items.find(i => i.source === 'gmail');
    expect(item).toMatchObject({
      id: 'gmail:work@example.test', kind: 'gmail-over-target', severity: 'warn', blocking: false,
      title: 'work@example.test: 120 unread, target 100',
      detail: 'archive plan proposes 20; top senders: a@example.test (9), b@example.test (4)',
      since: '2026-11-09T11:00:00Z', expiresAt: null, act: ['phm fleet gmail-archive-plan'],
    });
    expect(inbox.sources.gmail).toEqual({ state: 'healthy', pending: 1 });
  });

  it('lists nothing for an inbox at or under target', async () => {
    const inbox = await withPlans([plan({ unread: 100 }), plan({ inbox: 'home@example.test', unread: 3 })]);
    expect(inbox.items.filter(i => i.source === 'gmail')).toEqual([]);
    expect(inbox.sources.gmail).toEqual({ state: 'healthy', pending: 0 });
  });

  it('is high severity at twice the target, warn just below', async () => {
    const inbox = await withPlans([plan({ unread: 200 }), plan({ inbox: 'home@example.test', unread: 199 })]);
    const sev = Object.fromEntries(inbox.items.map(i => [i.id, i.severity]));
    expect(sev).toMatchObject({ 'gmail:work@example.test': 'high', 'gmail:home@example.test': 'warn' });
  });

  it('never treats a zero target as high', async () => {
    const inbox = await withPlans([plan({ unread: 5, target: 0 })]);
    expect(inbox.items[0]?.severity).toBe('warn');
  });

  it('reports a missing plan file as missing', async () => {
    const inbox = await readUnifiedInbox({ runsDir, busRoot, now: () => NOW });
    expect(inbox.sources.gmail).toEqual({ state: 'missing', pending: 0 });
  });

  it('reports a corrupt plan file as degraded and still lists the other sources', async () => {
    mkdirSync(join(runsDir, 'comms'), { recursive: true });
    writeFileSync(gmailArchivePlanLatestPath(runsDir), '{not json');
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => NOW,
      readNeeds: () => ({ status: 'available', items: [{ id: 'nm-1', text: 'fake needs-you line' }] } as never),
    });
    expect(inbox.sources.gmail).toEqual({ state: 'degraded', pending: 0 });
    expect(Object.keys(inbox.sources).sort()).toEqual(['bus', 'drafts', 'gmail', 'imessage', 'needs-you']);
    expect(inbox.items.map(i => i.id)).toContain('needs-you:nm-1');
  });

  it('treats a throwing reader as degraded-or-missing, never throwing', async () => {
    const inbox = await readUnifiedInbox({ runsDir, busRoot, now: () => NOW, readGmailPlans: () => { throw new Error('boom'); } });
    expect(inbox.sources.gmail.pending).toBe(0);
  });

  it('keeps ranking deterministic: high before warn, same order every read', async () => {
    const plans = [plan({ inbox: 'a@example.test', unread: 110 }), plan({ inbox: 'b@example.test', unread: 250 })];
    const first = (await withPlans(plans)).items.map(i => i.id);
    expect(first).toEqual((await withPlans([...plans].reverse())).items.map(i => i.id));
    expect(first[0]).toBe('gmail:b@example.test');
  });

  it('scrubs and single-lines sender text', async () => {
    const inbox = await withPlans([plan({ topSenders: [{ sender: 'x@example.test\nsecond line', count: 2 }] })]);
    expect(inbox.items[0]?.detail).not.toMatch(/\n/);
  });
});
