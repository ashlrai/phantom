/**
 * RQ-PHX-LINKEDINOWNERQUALIFY294S — executable qualification for EXISTING
 * owner PR #5326 (RQ-PHX-LINKEDINORIGINAL239S, observed head
 * e409e06ff151da2e639249120c2320377945f291; original source PR #4423 head
 * f2ebb56232ab98bc9a961c05745735e0e2c45ed4 / cited 6ff4d94d6b). The owner
 * extends the bounded flat drop reader with the original exporter envelope
 * `{ id, threadId, from: { name, profileUrl? }, receivedAt, text }` and the
 * `handled/<id>.handled` suppression marker alongside `answered/<id>`.
 *
 * The owner's own suite (test/linkedin-original-envelope-preservation-239s.test.ts)
 * already pins envelope parsing, pre-seeded marker suppression, malformed
 * degradation, bounds and read purity. This suite adds only the uncovered
 * combinations, all through the real `readUnifiedInbox` against real temp
 * `<runsDir>/comms/linkedin/` files:
 *
 *   - markers landing BETWEEN reads suppress on subsequent reads, and a fully
 *     suppressed source still reports healthy (suppression is not skipped);
 *   - an impossible `receivedAt` original envelope neither claims nor suppresses
 *     the id of a different valid message — the surviving item is provably the
 *     flat one;
 *   - repeated reads create no marker files and leave input bytes unchanged.
 *
 * The suite self-skips on trees without the owner envelope support (master
 * before #5326 merges): the flat reader rejects nested envelopes, so the
 * capability probe below yields zero messages there. Hermetic: temp dirs,
 * fake values, no network, no sends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readLinkedInDrop } from '../src/core/comms/linkedin-drop.js';
import { readUnifiedInbox, type UnifiedInboxItem } from '../src/core/comms/unified-inbox.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');

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

// Capability probe: does this tree's reader accept the original exporter
// envelope? Synchronous and side-effect free; the temp dir is removed below.
const OWNER_ENVELOPE = (() => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'linkedin-owner-probe-'));
  try {
    const probeInbox = join(probeRoot, 'comms', 'linkedin', 'inbox');
    mkdirSync(probeInbox, { recursive: true });
    writeFileSync(join(probeInbox, 'probe.json'), JSON.stringify(original()));
    return readLinkedInDrop({ runsDir: probeRoot }).messages.length === 1;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
})();

let root: string, runsDir: string, busRoot: string, base: string, inbox: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linkedin-owner-qualify-'));
  runsDir = join(root, 'runs');
  busRoot = join(root, 'bus');
  base = join(runsDir, 'comms', 'linkedin');
  inbox = join(base, 'inbox');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(busRoot, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

describe.skipIf(!OWNER_ENVELOPE)('LinkedIn owner qualification (PR #5326 head e409e06f)', () => {
  it('suppresses nested and flat items on SUBSEQUENT reads via handled then answered markers', async () => {
    put('orig.json', original());
    put('flat.json', flat());
    const first = await inboxRead();
    expect(first.sources.linkedin).toEqual({ state: 'healthy', pending: 2 });
    expect(linkedinItems(first.items).map(i => i.id).sort()).toEqual(['linkedin:li-flat-1', 'linkedin:li-orig-1']);

    // Original-contract marker lands after the first read.
    mkdirSync(join(base, 'handled'), { recursive: true });
    writeFileSync(join(base, 'handled', 'li-orig-1.handled'), '');
    const second = await inboxRead();
    expect(second.sources.linkedin).toEqual({ state: 'healthy', pending: 1 });
    expect(linkedinItems(second.items).map(i => i.id)).toEqual(['linkedin:li-flat-1']);

    // Current-contract marker via the real owner write path.
    const { markLinkedInAnswered } = await import('../src/core/comms/linkedin-drop.js');
    expect(markLinkedInAnswered(runsDir, 'li-flat-1', () => new Date('2026-11-13T12:30:00.000Z'))).toBe('marked');
    const third = await inboxRead();
    // Suppression is not degradation: zero pending reports healthy, not degraded.
    expect(third.sources.linkedin).toEqual({ state: 'healthy', pending: 0 });
    expect(linkedinItems(third.items)).toEqual([]);
  });

  it('an impossible receivedAt original neither claims nor suppresses a different valid message id', async () => {
    // Malformed original sorts first by filename; its id collides with a valid flat file.
    put('a-bad-orig.json', original({ id: 'li-same', receivedAt: '2026-02-30T12:00:00Z' }));
    put('b-flat.json', flat({ id: 'li-same', from: 'Flat Survivor', at: '2026-11-06T08:00:00Z' }));
    put('c-orig.json', original({ id: 'li-other', threadId: 'thread-fake-9' }));
    const result = await inboxRead();
    expect(result.sources.linkedin).toEqual({ state: 'degraded', pending: 2 });
    const items = linkedinItems(result.items);
    expect(items.map(i => i.id).sort()).toEqual(['linkedin:li-other', 'linkedin:li-same']);
    // The surviving li-same item is provably the flat message, not the malformed original.
    const same = items.find(i => i.id === 'linkedin:li-same');
    expect(same).toMatchObject({
      title: 'LinkedIn from Flat Survivor: flat drop text',
      since: '2026-11-06T08:00:00.000Z',
      kind: 'linkedin-message',
      act: ['phm drafts list --status pending'],
    });
    // The bad file only cost one skip; it suppressed nothing else.
    const drop = readLinkedInDrop({ runsDir });
    expect(drop).toMatchObject({ sourceState: 'degraded', skipped: 1 });
    expect(drop.messages.map(m => m.id).sort()).toEqual(['li-other', 'li-same']);
  });

  it('repeated reads create no markers and leave every input byte unchanged', async () => {
    put('orig.json', original());
    put('flat.json', flat());
    put('bad.json', '{not json');
    const before = snapshot(root);
    const first = await inboxRead();
    const second = await inboxRead();
    expect(snapshot(root)).toEqual(before);
    // Marker directories were never created by reading.
    expect(existsSync(join(base, 'handled'))).toBe(false);
    expect(existsSync(join(base, 'answered'))).toBe(false);
    for (const item of [...linkedinItems(first.items), ...linkedinItems(second.items)]) {
      for (const act of item.act) expect(act).not.toMatch(/send|approve|post|reply --apply/i);
    }
    expect(first.items).toEqual(second.items);
  });
});
