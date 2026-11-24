/** The Leader chat: MASON-INBOX entries + leader replies as one list (core/fleet/leader-chat.ts) and `phm leader thread|say`. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compose = vi.hoisted(() => vi.fn());
vi.mock('../src/core/agents/leader-network-runtime.js', () => ({ composeLeaderInbox: compose }));

import { buildLeaderChat, readLeaderChat } from '../src/core/fleet/leader-chat.js';
import { chatStateWords, leaderChatLine } from '../src/core/fleet/leader-chat-text.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { parseOutbox } from '../src/core/fleet/mason-outbox.js';
import { runLeaderCli } from '../src/cli/leader.js';

const REQ = 'a'.repeat(64);
const NOW = Date.parse('2026-11-17T15:00:00Z');
// Fixtures in the shapes the real writers produce.
const INBOX = {
  channel: '\n2026-11-17T14:30:00.000Z [src:phone id:phone-0123456789abcdef] Is the release green?\n',
  network: `\n## 2026-11-17 09:40 ET (Operator, bus) PRIORITY P0 [leader-network:${REQ}]\nShip the billing fix\n`,
  old: '\n2026-11-17T11:00:00.000Z [src:desktop id:desk-00000000000000aa] Old question nobody answered\n',
  malformed: '\n## not a dated heading\nstray block\n',
};
const OUTBOX = `# Outbox\n\n## 2026-11-17T14:50:00.000Z [leader-network:reply-${REQ}]\nLeader: billing fix is merging now\n`;

let runsDir: string;
function write(inbox: string, outbox?: string, acks: string[] = []): void {
  mkdirSync(join(runsDir, 'leader'), { recursive: true });
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  writeFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), inbox);
  if (outbox !== undefined) writeFileSync(join(runsDir, 'leader', 'MASON-OUTBOX.md'), outbox);
  writeFileSync(join(runsDir, 'queue', 'inbox-acks.jsonl'), acks.map(entryId => JSON.stringify({ entryId, status: 'acked' })).join('\n'));
}

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'leader-chat-')); compose.mockReset(); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('buildLeaderChat / readLeaderChat', () => {
  it('an empty thread is an empty list, not an error', async () => {
    const chat = await readLeaderChat({ runsDir, nowMs: NOW });
    expect(chat).toMatchObject({ v: 1, messages: [], skipped: { malformedInbox: 0 }, sources: { inbox: 'missing', replies: 'missing' } });
    expect(buildLeaderChat({ inbox: [], replies: [], acks: new Map(), nowMs: NOW }).messages).toEqual([]);
  });

  it('a received-but-unanswered message is received; past 2 hours it is flagged open', async () => {
    write(INBOX.old + INBOX.channel, undefined, ['phone-0123456789abcdef', 'desk-00000000000000aa']);
    const { messages } = await readLeaderChat({ runsDir, nowMs: NOW });
    expect(messages.map(m => [m.id, m.state, m.received])).toEqual([
      ['desk-00000000000000aa', 'open-over-2h', true],
      ['phone-0123456789abcdef', 'received', true],
    ]);
    expect(messages[1]).toMatchObject({ direction: 'to-leader', channel: 'phone', text: 'Is the release green?', ts: '2026-11-17T14:30:00.000Z' });
    expect(chatStateWords(messages[0]!, NOW)).toBe('received, no answer yet after 4 h');
  });

  it('a reply linked to its message marks it answered (leader-network heading or "re: <id>")', async () => {
    write(INBOX.network + INBOX.channel, `${OUTBOX}\n## 2026-11-17T14:55:00.000Z\nre: phone-0123456789abcdef yes, green\n`);
    const { messages } = await readLeaderChat({ runsDir, nowMs: NOW });
    expect(messages.map(m => [m.direction, m.state, m.replyTo ?? null])).toEqual([
      ['to-leader', 'answered', null],
      ['to-leader', 'answered', null],
      ['from-leader', 'reply', REQ],
      ['from-leader', 'reply', 'phone-0123456789abcdef'],
    ]);
    expect(messages[1]).toMatchObject({ id: REQ, ts: '2026-11-17T14:40:00.000Z', channel: 'bus', text: 'Ship the billing fix' });
    expect(parseOutbox(OUTBOX)[0]).toMatchObject({ replyTo: REQ });
  });

  it('an unlinked reply answers nothing; a message under 2 hours stays sent', () => {
    const chat = buildLeaderChat({ inbox: parseInbox(INBOX.channel), replies: [{ at: '2026-11-17T14:45:00Z', text: 'unrelated update' }], acks: new Map(), nowMs: NOW });
    expect(chat.messages.map(m => m.state)).toEqual(['sent', 'reply']);
  });

  it('a malformed inbox block is skipped and counted', async () => {
    write(INBOX.malformed + INBOX.channel + '\n2026-11-17T14:31:00.000Z [src:phone id:phone-ffffffffffffffff]  \n');
    const chat = await readLeaderChat({ runsDir, nowMs: NOW });
    expect(chat.messages.map(m => m.id)).toEqual(['phone-0123456789abcdef']);
    expect(chat.skipped.malformedInbox).toBe(2);
  });

  it('JSON order is stable: time, then inbox before replies on a tie, unknown times last', () => {
    const input = {
      inbox: parseInbox(INBOX.channel + '\n2026-11-17T14:30:00.000Z [src:desktop id:desk-0000000000000001] same minute\n'),
      replies: [{ at: '', text: 'undated note' }, { at: '2026-11-17 09:30', text: 'same minute reply' }, { at: '2026-11-17T14:00:00Z', text: 'earlier' }],
      acks: new Map(), nowMs: NOW,
    };
    const first = JSON.stringify(buildLeaderChat(input));
    expect(JSON.stringify(buildLeaderChat({ ...input, inbox: [...input.inbox] }))).toBe(first);
    const parsed = JSON.parse(first) as { messages: { text: string; ts: string | null }[] };
    expect(parsed.messages.map(m => m.text)).toEqual(['earlier', 'Is the release green?', 'same minute', 'same minute reply', 'undated note']);
    expect(parsed.messages.at(-1)!.ts).toBeNull();
    expect(Object.keys(JSON.parse(first) as object)).toEqual(['v', 'generatedAt', 'messages', 'skipped']);
    expect(buildLeaderChat({ ...input, limit: 2 }).messages.map(m => m.text)).toEqual(['same minute reply', 'undated note']);
  });
});

describe('phm leader thread / say', () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    return { out, err };
  }

  it('thread --legacy prints JSON by default and plain lines with --text', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    write(INBOX.network + INBOX.malformed, OUTBOX, []);
    const io = capture();
    expect(await runLeaderCli(['thread', '--legacy', '--limit', '5'])).toBe(0);
    const json = JSON.parse(io.out.join('\n')) as { messages: { state: string }[]; skipped: { malformedInbox: number } };
    expect(json.messages.map(m => m.state)).toEqual(['answered', 'reply']);
    expect(json.skipped.malformedInbox).toBe(1);
    io.out.length = 0;
    expect(await runLeaderCli(['thread', '--legacy', '--text'])).toBe(0);
    const text = io.out.join('\n');
    expect(text).toMatch(/You \(bus\) · answered/);
    expect(text).toMatch(/Leader re aaaaaaaaaaaaaaaa/);
    expect(text).toContain('(1 unreadable inbox block skipped)');
    vi.unstubAllEnvs();
  });

  it('thread --legacy --text on an empty inbox says how to start', async () => {
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
    const io = capture();
    expect(await runLeaderCli(['thread', '--legacy', '--text'])).toBe(0);
    expect(io.out.join('\n')).toContain('No messages yet. Say something: phm leader say');
    vi.unstubAllEnvs();
  });

  it('say writes through the verified inbox writer and returns the id', async () => {
    compose.mockResolvedValue({ ok: true, at: '2026-11-17T15:00:00.000Z', id: REQ });
    const io = capture();
    expect(await runLeaderCli(['say', 'ship', 'it'])).toBe(0);
    expect(compose).toHaveBeenCalledWith('ship it');
    expect(JSON.parse(io.out.at(-1)!)).toEqual({ ok: true, id: REQ, ts: '2026-11-17T15:00:00.000Z' });
    expect(await runLeaderCli(['say', '--text', 'again'])).toBe(0);
    expect(io.out.at(-1)).toBe(`Sent to the leader (${REQ}).`);
    expect(await runLeaderCli(['say', 'x', '--bogus'])).toBe(2);
    compose.mockResolvedValue({ ok: false, reason: 'local-owner is not verified' });
    expect(await runLeaderCli(['say', 'nope'])).toBe(1);
    expect(io.err.at(-1)).toContain('local-owner is not verified');
    expect(compose).toHaveBeenCalledTimes(3);
  });

  it('builds plain lines with an unknown time shown as unknown', () => {
    const line = leaderChatLine({ id: 'out-1', ts: null, direction: 'from-leader', channel: 'outbox', text: 'hi', state: 'reply' }, NOW);
    expect(line).toMatch(/^time unknown\s+Leader \[out-1\]/);
  });
});
