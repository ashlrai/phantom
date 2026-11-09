import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTENT_LEDGER_SCHEMA, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { readOrdersView } from '../src/core/verse/fleet-orders-view.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 86_400_000;
let root: string;

function item(id: string, status: IntentStatus, ageMs: number, extra: Partial<IntentItem> = {}): IntentItem {
  const at = new Date(NOW - ageMs).toISOString();
  return {
    id, title: `Ship the example release ${id}`, source: 'secret-source-note', owner: 'owner', rq: [], prs: [], status,
    evidence: [{ at, kind: 'note', ref: 'ref', note: 'private evidence note' }],
    provenance: [{ source: '/Users/someone/private/path.md', date: null, verbatim: true, partial: false }],
    partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 7 * DAY, createdAt: at, updatedAt: at, ...extra,
  };
}

async function writeItems(items: IntentItem[]) {
  await mkdir(join(root, 'intent'), { recursive: true });
  await writeFile(join(root, 'intent', 'ledger.json'), JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items }));
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'orders-view-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('readOrdersView', () => {
  it('orders stale first, then open, merged, done; newest first within a group', async () => {
    await writeItems([
      item('done-old', 'shipped', 20 * DAY),
      item('done-new', 'verified', 1 * DAY),
      item('merged', 'merged', 2 * DAY),
      item('open-old', 'queued', 3 * DAY),
      item('open-new', 'in-progress', 1 * DAY),
      item('quiet-old', 'proposed', 30 * DAY),
      item('quiet-new', 'queued', 10 * DAY),
    ]);
    const view = await readOrdersView({ root, nowMs: NOW });
    expect(view.v).toBe(1);
    expect(view.observedAt).toBe(new Date(NOW).toISOString());
    expect(view.items.map(row => row.id)).toEqual(['quiet-new', 'quiet-old', 'open-new', 'open-old', 'merged', 'done-new', 'done-old']);
    expect(view.items.filter(row => row.stale).map(row => row.id)).toEqual(['quiet-new', 'quiet-old']);
    expect(view.summary).toMatchObject({ sourceQuality: 'readable', items: 7, shipped: 1, verified: 1, stale: 2 });
  });

  it('caps the list at 50 items but summarizes the whole ledger', async () => {
    await writeItems(Array.from({ length: 60 }, (_, i) => item(`o${i}`, 'queued', i * 1000)));
    const view = await readOrdersView({ root, nowMs: NOW });
    expect(view.items).toHaveLength(50);
    expect(view.summary.items).toBe(60);
    expect(view.items[0]!.id).toBe('o0');
  });

  it('caps titles at 200 characters, including in the summary stale list', async () => {
    await writeItems([item('long', 'queued', 30 * DAY, { title: 'x'.repeat(300) })]);
    const view = await readOrdersView({ root, nowMs: NOW });
    expect(view.items[0]!.title).toHaveLength(200);
    expect(view.summary.staleItems[0]!.title).toHaveLength(200);
  });

  it('projects only safe fields', async () => {
    await writeItems([item('a', 'merged', DAY, { rq: ['RQ-EXAMPLE-1'], prs: [{ repo: 'ashlrai/phantom', number: 7, url: 'https://example.test/7', state: 'merged' }] })]);
    const view = await readOrdersView({ root, nowMs: NOW });
    expect(view.items[0]).toEqual({
      id: 'a', title: 'Ship the example release a', status: 'merged', rq: ['RQ-EXAMPLE-1'],
      prs: [{ repo: 'ashlrai/phantom', number: 7, state: 'merged' }], lastTouchedAt: new Date(NOW - DAY).toISOString(), stale: false,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain('private evidence note');
    expect(text).not.toContain('/Users/someone');
    expect(text).not.toContain('secret-source-note');
    expect(text).not.toContain('example.test');
  });

  it('reports a missing ledger as missing with no items', async () => {
    const view = await readOrdersView({ root, nowMs: NOW });
    expect(view.summary.sourceQuality).toBe('missing');
    expect(view.items).toEqual([]);
  });

  it('reports an unreadable ledger as unavailable, not zero orders', async () => {
    await mkdir(join(root, 'intent', 'ledger.json'), { recursive: true });
    const view = await readOrdersView({ root, nowMs: NOW });
    expect(view.summary.sourceQuality).toBe('unavailable');
    expect(view.summary.countQuality).toBe('unknown');
    expect(view.items).toEqual([]);
  });
});
