/**
 * RQ-PHX-SLACKJOURNALVALID439S -- readSlackJournal must structurally validate
 * each persisted row against the metadata contract the writer (`sanitize`)
 * produces. A corrupted row -- bad JSON, missing/invalid required `at` or
 * `decision`, or a present-but-malformed optional identity/ts/bus field --
 * marks the read `degraded` and is skipped, instead of silently becoming an
 * ordinary ignored event with an empty `at`. Valid rows (including legacy
 * ingested rows with no `bus` and ignored rows with legitimately absent
 * optionals) still project; the read stays bounded, newest-first, read-only
 * and copies only whitelisted metadata -- never message bodies.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readSlackJournal, slackJournalPath, SLACK_JOURNAL_MAX_BYTES } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-journal-valid439s-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VALID = {
  at: '2026-11-15T12:00:00.000Z', envelopeId: 'env-439s', eventId: 'Ev0FAKE439S',
  channelId: 'C0FAKE439S', authorId: 'U0FAKE439S',
  messageTs: '1763304000.000100', threadTs: '1763304000.000100',
  decision: 'ingested', bus: 'posted',
};

function writeJournal(runsDir: string, lines: readonly string[]): void {
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  writeFileSync(slackJournalPath(runsDir), `${lines.join('\n')}\n`, { mode: 0o600 });
}

function journalDir(lines: readonly string[]): string {
  const runsDir = join(root(), 'runs');
  writeJournal(runsDir, lines);
  return runsDir;
}

const row = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...VALID, ...overrides });

describe('slack journal evidence validation (439s)', () => {
  it('returns ok for a clean journal and preserves newest-first order', () => {
    const older = row({ at: '2026-11-15T11:00:00.000Z', messageTs: '1763300400.000100', threadTs: '1763300400.000100' });
    const runsDir = journalDir([older, row({ at: '2026-11-15T12:00:00.000Z' })]);
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[0]!.at).toBe('2026-11-15T12:00:00.000Z');
    expect(journal.entries[1]!.at).toBe('2026-11-15T11:00:00.000Z');
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a bare array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['missing decision', row({ decision: undefined })],
    ['unknown decision', row({ decision: 'maybe' })],
    ['non-string decision', row({ decision: 7 })],
    ['missing at', row({ at: undefined })],
    ['non-string at', row({ at: 1763304000 })],
    ['unparseable at', row({ at: 'not-a-date' })],
    ['empty at', row({ at: '' })],
  ])('marks degraded and skips the row: %s', (_name, bad) => {
    const runsDir = journalDir([row(), bad]);
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('degraded');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({ decision: 'ingested', bus: 'posted' });
  });

  it.each([
    ['messageTs', { messageTs: 'not-a-ts' }],
    ['messageTs non-string', { messageTs: 1763304000 }],
    ['threadTs', { threadTs: 'x'.repeat(300) }],
    ['threadTs non-string', { threadTs: { ts: '1.2' } }],
    ['bus outcome', { bus: 'queued' }],
    ['bus non-string', { bus: 1 }],
    ['authorId non-string', { authorId: 42 }],
    ['channelId non-string', { channelId: ['C0FAKE439S'] }],
    ['eventId empty', { eventId: '' }],
    ['reason non-string', { reason: { code: 1 } }],
    ['envelopeId control char', { envelopeId: 'env\nbad' }],
  ])('marks degraded on malformed optional field %s', (_name, overrides) => {
    const runsDir = journalDir([row(overrides)]);
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('degraded');
    expect(journal.entries).toHaveLength(0);
  });

  it('preserves a valid legacy ingested row with no bus field', () => {
    const legacy = JSON.stringify({
      at: '2026-11-13T09:00:00.000Z', envelopeId: 'env-old', eventId: 'Ev0OLD',
      channelId: 'C0FAKE439S', authorId: 'U0FAKE439S', decision: 'ingested',
    });
    const runsDir = journalDir([legacy]);
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries[0]).toMatchObject({ decision: 'ingested', channelId: 'C0FAKE439S' });
    expect(journal.entries[0]).not.toHaveProperty('bus');
    expect(journal.entries[0]).not.toHaveProperty('messageTs');
  });

  it('preserves valid ignored rows with legitimately absent optional fields', () => {
    const ignored = JSON.stringify({ at: '2026-11-15T12:30:00.000Z', decision: 'ignored', reason: 'foreign-team' });
    const bare = JSON.stringify({ at: '2026-11-15T12:31:00.000Z', decision: 'ignored' });
    const runsDir = journalDir([ignored, bare]);
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[0]).toMatchObject({ decision: 'ignored' });
    expect(journal.entries[0]).not.toHaveProperty('reason');
    expect(journal.entries[0]).not.toHaveProperty('bus');
    expect(journal.entries[1]).toMatchObject({ decision: 'ignored', reason: 'foreign-team' });
  });

  it('never copies arbitrary fields or message bodies into entries', () => {
    const marker = 'FAKE-BODY-MARKER-439S';
    const dirty = row({ text: marker, displayName: 'FAKE-NAME-439S', nested: { secret: marker } });
    const runsDir = journalDir([dirty]);
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(1);
    expect(JSON.stringify(journal.entries)).not.toContain(marker);
    expect(journal.entries[0]).not.toHaveProperty('text');
    expect(journal.entries[0]).not.toHaveProperty('displayName');
    expect(journal.entries[0]).not.toHaveProperty('nested');
  });

  it('readSlackRequestTrace reports sources.journal=degraded through a real on-disk journal', () => {
    const stateRoot = join(root(), 'state');
    mkdirSync(stateRoot, { mode: 0o700 });
    const runsDir = journalDir([row({ decision: 'bogus' })]);
    const trace = readSlackRequestTrace({ runsDir, stateRoot, now: () => new Date('2026-11-15T13:00:00.000Z') });
    expect(trace.sources.journal).toBe('degraded');
    expect(trace.rows).toHaveLength(0);
  });

  it('readSlackRequestTrace still reports sources.journal=ok for a clean journal', () => {
    const stateRoot = join(root(), 'state');
    mkdirSync(stateRoot, { mode: 0o700 });
    const runsDir = journalDir([row()]);
    const trace = readSlackRequestTrace({ runsDir, stateRoot, now: () => new Date('2026-11-15T13:00:00.000Z') });
    expect(trace.sources.journal).toBe('ok');
    expect(trace.rows).toHaveLength(1);
    // A row without a requestId has no reply identity: uncertain/unverified, not unanswered.
    expect(trace.rows[0]).toMatchObject({ outcome: 'uncertain', ingress: 'posted', evidence: 'unverified' });
  });

  it('round-trips a valid requestId and degrades the row on a malformed one', () => {
    const good = 'ab'.repeat(32);
    const ok = readSlackJournal({ runsDir: journalDir([row({ requestId: good }), row({ at: '2026-11-15T12:01:00.000Z' })]) });
    expect(ok.state).toBe('ok');
    expect(ok.entries.map((e) => e.requestId)).toEqual([undefined, good]);
    for (const bad of ['short', 'AB'.repeat(32), 7, null, 'g'.repeat(64)]) {
      expect(readSlackJournal({ runsDir: journalDir([row({ requestId: bad })]) }).state).toBe('degraded');
    }
  });

  it('preserves missing and truncated behavior', () => {
    const missingDir = join(root(), 'runs');
    expect(readSlackJournal({ runsDir: missingDir })).toEqual({ state: 'missing', entries: [] });

    const truncatedDir = join(root(), 'runs2');
    mkdirSync(join(truncatedDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    writeFileSync(slackJournalPath(truncatedDir), 'x'.repeat(SLACK_JOURNAL_MAX_BYTES + 1), { mode: 0o600 });
    expect(readSlackJournal({ runsDir: truncatedDir })).toEqual({ state: 'degraded', entries: [] });
  });

  it('a corrupted newest row does not hide valid older rows, and stays newest-first', () => {
    const runsDir = journalDir([
      row({ at: '2026-11-15T10:00:00.000Z' }),
      '{corrupt',
      row({ at: '2026-11-15T11:00:00.000Z' }),
    ]);
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('degraded');
    expect(journal.entries.map((e) => e.at)).toEqual(['2026-11-15T11:00:00.000Z', '2026-11-15T10:00:00.000Z']);
  });
});
