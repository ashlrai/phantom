/** Unified inbox, linkedin source. Hermetic: seams and temp dirs. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUnifiedInbox } from '../src/core/comms/unified-inbox.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
let root: string, runsDir: string, busRoot: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'unified-inbox-linkedin-'));
  runsDir = join(root, 'runs'); mkdirSync(runsDir, { recursive: true });
  busRoot = join(root, 'bus'); mkdirSync(busRoot, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const needs = () => ({ status: 'available', items: [{ id: 'nm-1', text: 'fake needs-you line' }] }) as never;

describe('unified inbox linkedin source', () => {
  it('lists linkedin items ranked with the rest', async () => {
    const inbox = await readUnifiedInbox({
      runsDir, busRoot, now: () => NOW, readNeeds: needs,
      readLinkedIn: () => ({ sourceState: 'healthy', skipped: 0, messages: [{ id: 'm1', from: 'Ada Fake', text: 'Hi', at: '2026-11-09T11:00:00.000Z' }] }),
    });
    expect(inbox.sources.linkedin).toEqual({ state: 'healthy', pending: 1 });
    const item = inbox.items.find(i => i.source === 'linkedin');
    expect(item).toMatchObject({
      id: 'linkedin:m1', kind: 'linkedin-message', severity: 'info', blocking: false,
      title: 'LinkedIn from Ada Fake: Hi', act: ['phm drafts list --status pending'],
    });
    expect(inbox.items.map(i => i.id)).toContain('needs-you:nm-1');
    expect(inbox.items.findIndex(i => i.id === 'needs-you:nm-1')).toBeLessThan(inbox.items.findIndex(i => i.id === 'linkedin:m1'));
  });

  it('reports a missing drop folder as missing', async () => {
    const inbox = await readUnifiedInbox({ runsDir, busRoot, now: () => NOW });
    expect(inbox.sources.linkedin).toEqual({ state: 'missing', pending: 0 });
  });

  it('a throwing seam reports unavailable and the other sources still list', async () => {
    const inbox = await readUnifiedInbox({ runsDir, busRoot, now: () => NOW, readNeeds: needs, readLinkedIn: () => { throw new Error('boom'); } });
    expect(inbox.sources.linkedin).toEqual({ state: 'unavailable', pending: 0 });
    expect(inbox.items.map(i => i.id)).toContain('needs-you:nm-1');
  });
});
