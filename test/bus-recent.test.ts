import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdBusRecent } from '../src/cli/bus-recent.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { BUS_RECENT_SCHEMA, formatBusRecentText, readBusRecent, type BusRecent } from '../src/core/fleet/bus-recent.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), NOW = T0 + 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Said = [at: number, from: string, to: string, text: string];
function store(said: Said[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'bus-recent-'));
  roots.push(root);
  said.forEach(([at, from, to, text], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: 'P2', ttl: 86_400_000, body: { text } }, { root, now: () => at }).status).toBe('posted'));
  return root;
}
const read = (root: string, since?: string, before?: string): BusRecent => {
  const r = readBusRecent({ since, before }, { root, now: () => NOW });
  if (!r.ok) throw new Error(r.error);
  return r.result;
};

describe('phm bus recent', () => {
  it('an empty bus reads "No messages yet." with a schema id and an as_of time', () => {
    const none = read(store());
    expect(none).toEqual({ schema: BUS_RECENT_SCHEMA, as_of: '2026-11-18T12:01:00.000Z', messages: [] });
    expect(formatBusRecentText(none)).toBe('No messages yet.');
  });

  it('a busy bus lists every message newest first, by routing label, in stable key order', () => {
    const busy = read(store([[T0, 'leader', 'claude', 'please look at the build'], [T0 + 1_000, 'claude', 'leader', 'on it?'], [T0 + 2_000, 'claude', 'RQ-ONE', 'start the docs']]));
    expect(busy.messages!.map(m => `${m.from}>${m.to}`)).toEqual(['claude>RQ-ONE', 'claude>leader', 'leader>claude']);
    expect(Object.keys(busy.messages![0]!)).toEqual(['at', 'from', 'to', 'kind', 'summary']);
    expect(Object.keys(busy)).toEqual(['schema', 'as_of', 'messages']);
  });

  it('a message to an agent the map does not draw is still listed', () => {
    expect(read(store([[T0, 'claude', 'someone', 'hello there']])).messages).toMatchObject([{ from: 'claude', to: 'someone', summary: 'hello there' }]);
  });

  it('cuts each summary to 100 characters on one line', () => {
    const [m] = read(store([[T0, 'leader', 'claude', `${'word '.repeat(60)}\nend`]])).messages!;
    expect(m!.summary.length).toBeLessThanOrEqual(100);
    expect(m!.summary.endsWith('…')).toBe(true);
    expect(m!.summary).not.toContain('\n');
  });

  it('--since drops older messages and a bad one is a usage error', () => {
    const root = store([[T0 - 600_000, 'leader', 'claude', 'old news'], [T0, 'leader', 'claude', 'fresh']]);
    expect(read(root, '5m').messages).toHaveLength(1);
    expect(read(root, '1h').messages).toHaveLength(2);
    expect(readBusRecent({ since: 'soon' }, { root, now: () => NOW })).toEqual({ ok: false, error: '--since takes 10m, 2h, 1d, epoch ms or an ISO time.' });
    expect(readBusRecent({ before: 'soon' }, { root, now: () => NOW })).toEqual({ ok: false, error: '--before takes 10m, 2h, 1d, epoch ms or an ISO time.' });
  });

  it('--before keeps only messages received strictly before its cutoff, composing with --since into one window', () => {
    const root = store([[T0 - 600_000, 'leader', 'claude', 'old news'], [T0, 'leader', 'claude', 'first'], [T0 + 1_000, 'claude', 'leader', 'second'], [T0 + 2_000, 'claude', 'codex', 'third']]);
    // before at T0+1500 drops the T0+2000 row; the T0+1000 row stays.
    expect(read(root, undefined, new Date(T0 + 1_500).toISOString()).messages!.map(m => m.summary)).toEqual(['second', 'first']);
    // A message stamped exactly at the cutoff drops — adjacent windows never double-count it.
    expect(read(root, undefined, String(T0 + 2_000)).messages!.map(m => m.summary)).toEqual(['second', 'first']);
    // [since, before): since after T0 keeps only the second row inside the window.
    expect(read(root, new Date(T0 + 500).toISOString(), new Date(T0 + 1_500).toISOString()).messages!.map(m => m.summary)).toEqual(['second']);
    // An inverted window is an honest empty page, not an error.
    expect(read(root, new Date(T0 + 2_000).toISOString(), new Date(T0 + 1_000).toISOString()).messages).toEqual([]);
  });

  it('the shared phm messages filters narrow the digest too', () => {
    const root = store([[T0, 'leader', 'claude', 'please look at the build'], [T0 + 1_000, 'claude', 'leader', 'on it?'], [T0 + 2_000, 'claude', 'codex', 'RQ-ONE-1 shipped']]);
    const kind = readBusRecent({ kind: 'ask' }, { root, now: () => NOW });
    expect(kind.ok && kind.result.messages!.map(m => m.summary)).toEqual(['on it?']);
    const from = readBusRecent({ from: 'claude' }, { root, now: () => NOW });
    expect(from.ok && from.result.messages).toHaveLength(2);
    const job = readBusRecent({ job: 'RQ-ONE-1' }, { root, now: () => NOW });
    expect(job.ok && job.result.messages!.map(m => m.summary)).toEqual(['RQ-ONE-1 shipped']);
    const byId = readBusRecent({ id: 'm1' }, { root, now: () => NOW });
    expect(byId.ok && byId.result.messages!.map(m => m.summary)).toEqual(['on it?']);
    // --to decides on the recipient's routing label.
    const to = readBusRecent({ to: 'claude' }, { root, now: () => NOW });
    expect(to.ok && to.result.messages!.map(m => m.summary)).toEqual(['please look at the build']);
    const toLeader = readBusRecent({ to: 'leader' }, { root, now: () => NOW });
    expect(toLeader.ok && toLeader.result.messages!.map(m => m.summary)).toEqual(['on it?']);
    expect(readBusRecent({ with: 'codex' }, { root, now: () => NOW }))
      .toEqual({ ok: false, error: '--with takes the other agent and needs --agent.' });
  });

  it('the body-kind filter keeps only bodies carrying that discriminator', () => {
    const root = store();
    const post = (id: string, at: number, body: Record<string, unknown>) =>
      expect(appendBusInbox({ id, from: 'claude', to: 'leader', priority: 'P2', ttl: 86_400_000, body },
        { root, now: () => at }).status).toBe('posted');
    post('k1', T0, { text: 'kindless mail' });
    post('k2', T0 + 1_000, { kind: 'note', text: 'a note' });
    post('k3', T0 + 2_000, { kind: 'work.post', jobId: 'RQ-BKR', title: 'ship it', repo: 'a/b',
      provider: 'devin', claimKeys: ['repo:a/b'] });
    const notes = readBusRecent({ bodyKind: 'note' }, { root, now: () => NOW });
    expect(notes.ok && notes.result.messages!.map(m => m.summary)).toEqual(['a note']);
    const posts = readBusRecent({ bodyKind: 'work.post' }, { root, now: () => NOW });
    expect(posts.ok && posts.result.messages).toHaveLength(1);
    // A discriminator no body carries is an honest empty page; a malformed
    // value is refused like every other bus read's body-kind filter.
    const none = readBusRecent({ bodyKind: 'wake' }, { root, now: () => NOW });
    expect(none.ok && none.result.messages).toEqual([]);
    expect(readBusRecent({ bodyKind: 'has space' }, { root, now: () => NOW }))
      .toEqual({ ok: false, error: '--body-kind takes a body kind (printable, 1-128 chars).' });
  });

  it('the CLI: help exits 0, a bad flag exits 2', async () => {
    const lines: string[] = [];
    expect(await cmdBusRecent(['--help'], t => lines.push(t))).toBe(0);
    expect(lines[0]).toContain('phm bus recent');
    expect(await cmdBusRecent(['--nope'], () => {}, t => lines.push(t))).toBe(2);
    expect(await cmdBusRecent(['--since', '5m', '--since', '1h'], () => {}, () => {})).toBe(2);
    expect(await cmdBusRecent(['--kind', 'ask', '--kind', 'reply'], () => {}, () => {})).toBe(2);
    expect(await cmdBusRecent(['--from'], () => {}, () => {})).toBe(2);
  });
});
