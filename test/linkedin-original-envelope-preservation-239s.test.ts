/**
 * RQ-PHX-LINKEDINORIGINAL239S: original PR #4423 exporter-envelope recovery.
 * The original drop spec wrote `{ id, threadId, from: { name, profileUrl? },
 * receivedAt, text }` files with `handled/<id>.handled` suppression markers;
 * master kept the newer bounded flat reader (`{ id, from, text, at,
 * threadUrl? }` + `answered/<id>`). These tests pin the merged contract:
 * both envelopes read through `readUnifiedInbox`'s fixed
 * `<runsDir>/comms/linkedin/` layout, both marker kinds suppress, malformed
 * original envelopes degrade only their own source, and reads stay
 * side-effect free with no send action. Hermetic: temp dirs, fake values.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { LINKEDIN_DROP_MAX_FILE_BYTES, readLinkedInDrop } from '../src/core/comms/linkedin-drop.js';
import { readUnifiedInbox, type UnifiedInboxItem } from '../src/core/comms/unified-inbox.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
let root: string, runsDir: string, busRoot: string, base: string, inbox: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linkedin-original-envelope-'));
  runsDir = join(root, 'runs');
  busRoot = join(root, 'bus');
  base = join(runsDir, 'comms', 'linkedin');
  inbox = join(base, 'inbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(busRoot, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Original #4423 exporter envelope. */
const original = (over: Record<string, unknown> = {}) => ({
  id: 'li-orig-1',
  threadId: 'thread-fake-1',
  from: { name: 'Example Person', profileUrl: 'https://www.linkedin.com/in/example-person' },
  receivedAt: '2026-11-04T12:00:00Z',
  text: 'Hello from the original exporter',
  ...over,
});
/** Current flat drop envelope. */
const flat = (over: Record<string, unknown> = {}) => ({
  id: 'li-flat-1',
  from: 'Flat Sender',
  text: 'flat drop text',
  at: '2026-11-05T09:30:00Z',
  ...over,
});
const put = (name: string, body: unknown) =>
  writeFileSync(join(inbox, name), typeof body === 'string' ? body : JSON.stringify(body));
const inboxRead = () => readUnifiedInbox({ runsDir, busRoot, now: () => NOW });
const linkedinItems = (items: UnifiedInboxItem[]) => items.filter(i => i.source === 'linkedin');

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

describe('original LinkedIn exporter envelope (PR #4423 recovery)', () => {
  it('surfaces a nested exporter message alongside a flat current message', async () => {
    put('orig.json', original());
    put('flat.json', flat({ threadUrl: 'https://www.linkedin.com/messaging/thread/fake-1' }));
    const inboxResult = await inboxRead();
    expect(inboxResult.sources.linkedin).toEqual({ state: 'healthy', pending: 2 });
    const items = linkedinItems(inboxResult.items);
    expect(items.map(i => i.id).sort()).toEqual(['linkedin:li-flat-1', 'linkedin:li-orig-1']);
    const orig = items.find(i => i.id === 'linkedin:li-orig-1');
    expect(orig).toMatchObject({
      kind: 'linkedin-message', severity: 'info', blocking: false,
      title: 'LinkedIn from Example Person: Hello from the original exporter',
      since: '2026-11-04T12:00:00.000Z',
      act: ['phm drafts list --status pending'],
    });
    // threadId/profileUrl are validated but have no public-shape field.
    expect(orig?.detail).toBeNull();
    const flatItem = items.find(i => i.id === 'linkedin:li-flat-1');
    expect(flatItem?.detail).toBe('https://www.linkedin.com/messaging/thread/fake-1');
  });

  it('shows a duplicated id once across envelope shapes', async () => {
    put('a.json', original({ id: 'li-dup' }));
    put('b.json', flat({ id: 'li-dup', from: 'Other Sender' }));
    const result = await inboxRead();
    expect(result.sources.linkedin).toEqual({ state: 'degraded', pending: 1 });
    expect(linkedinItems(result.items).map(i => i.id)).toEqual(['linkedin:li-dup']);
  });

  it('handled and answered markers each suppress only their own ids', async () => {
    put('a.json', original({ id: 'li-handled' }));
    put('b.json', flat({ id: 'li-answered' }));
    put('c.json', original({ id: 'li-open', threadId: 'thread-fake-3' }));
    mkdirSync(join(base, 'handled'), { recursive: true });
    writeFileSync(join(base, 'handled', 'li-handled.handled'), '');
    mkdirSync(join(base, 'answered'), { recursive: true });
    writeFileSync(join(base, 'answered', 'li-answered'), '');
    // A marker for an absent id suppresses nothing else.
    writeFileSync(join(base, 'handled', 'li-absent.handled'), '');
    const result = await inboxRead();
    expect(result.sources.linkedin).toEqual({ state: 'healthy', pending: 1 });
    expect(linkedinItems(result.items).map(i => i.id)).toEqual(['linkedin:li-open']);
  });

  it('degrades the linkedin source on malformed original envelopes while valid entries and other sources survive', async () => {
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] fake decision\n');
    put('good-orig.json', original());
    put('good-flat.json', flat());
    put('bad-json.json', '{not json');
    put('impossible-date.json', original({ id: 'li-bad-date', receivedAt: '2026-02-30T12:00:00Z' }));
    put('not-a-date.json', original({ id: 'li-bad-text', receivedAt: 'not a date' }));
    put('no-name.json', original({ id: 'li-bad-from', from: { profileUrl: 'https://www.linkedin.com/in/x' } }));
    put('no-thread.json', original({ id: 'li-bad-thread', threadId: '' }));
    const result = await inboxRead();
    expect(result.sources.linkedin).toEqual({ state: 'degraded', pending: 2 });
    expect(result.sources['needs-you'].state).toBe('healthy');
    expect(result.items.some(i => i.source === 'needs-you')).toBe(true);
    const ids = result.items.map(i => i.id);
    expect(ids).toContain('linkedin:li-orig-1');
    expect(ids).toContain('linkedin:li-flat-1');
    expect(ids.some(id => id.startsWith('linkedin:li-bad'))).toBe(false);
    expect(ids.some(id => id === 'linkedin:li-bad-from' || id === 'linkedin:li-bad-thread')).toBe(false);
  });

  it('keeps controls and text bounded for original envelopes', async () => {
    put('orig.json', original({ text: `lead\n${'z'.repeat(2000)}` }));
    const drop = readLinkedInDrop({ runsDir });
    expect(drop.messages).toHaveLength(1);
    expect(drop.messages[0]?.text.length).toBeLessThanOrEqual(500);
    expect(drop.messages[0]?.text).not.toContain('\n');
    const result = await inboxRead();
    const item = linkedinItems(result.items)[0];
    expect(item?.title.length).toBeLessThanOrEqual(160);
  });

  it('still refuses oversize files', async () => {
    put('big.json', original({ text: 'x'.repeat(LINKEDIN_DROP_MAX_FILE_BYTES + 1) }));
    put('ok.json', flat());
    const result = await inboxRead();
    expect(result.sources.linkedin).toEqual({ state: 'degraded', pending: 1 });
    expect(linkedinItems(result.items).map(i => i.id)).toEqual(['linkedin:li-flat-1']);
  });

  it('reads leave the temp tree unchanged and expose no send action', async () => {
    put('orig.json', original());
    put('flat.json', flat());
    mkdirSync(join(base, 'handled'), { recursive: true });
    writeFileSync(join(base, 'handled', 'li-orig-1.handled'), '');
    const before = snapshot(root);
    const result = await inboxRead();
    expect(snapshot(root)).toEqual(before);
    for (const item of linkedinItems(result.items)) {
      for (const act of item.act) expect(act).not.toMatch(/send|approve|post|reply --apply/i);
    }
  });
});
