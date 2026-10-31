import { describe, expect, it } from 'vitest';

import {
  VERSE_SEARCH_MAX_SCAN_CHARS,
  searchSessions,
} from '../src/core/verse/session-search.js';
import type { VerseEvent, VerseSession } from '../src/core/verse/types.js';

const at = '2026-01-01T00:00:00.000Z';
const now = (): Date => new Date(at);

function session(id: string): VerseSession {
  return {
    id, title: `Session ${id}`, projectPath: `/fake/${id}`, engine: 'claude',
    accountId: 'fake', seatId: 'fake', model: 'fake', nativeSessionId: null,
    createdAt: at, updatedAt: at, status: 'idle', turnCount: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
    lastError: null,
  };
}

function message(text: string, seq = 1, type: 'user-message' | 'assistant-message' = 'user-message'): VerseEvent {
  return { seq, at, type, turnId: 'fake', text };
}

function search(logs: Record<string, VerseEvent[]>, query: string) {
  return searchSessions({
    sessions: Object.keys(logs).map(session),
    readEvents: (id) => logs[id],
    query,
    now,
  });
}

describe('session search scan budget', () => {
  it('does not match text beyond an oversized message prefix', () => {
    const text = `${'x'.repeat(VERSE_SEARCH_MAX_SCAN_CHARS)} forbidden phrase`;
    const result = search({ a: [message(text)] }, '"forbidden phrase"');
    expect(result.hits).toEqual([]);
    expect(result.scannedSessions).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('uses only the remaining prefix for matching, scoring, and snippets', () => {
    const prefix = 'needle sk-ant-api03-FAKE';
    const filler = 'x'.repeat(VERSE_SEARCH_MAX_SCAN_CHARS - prefix.length);
    const result = search({ a: [message(filler, 1), message(`${prefix}FAKEFAKEFAKEFAKE needle outside`, 2)] }, 'needle');
    expect(result.truncated).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ seq: 2, snippet: '[Match in scanned message prefix]', score: 1.1 });
    expect(result.hits[0].snippet).not.toContain('outside');
    expect(result.hits[0].snippet).not.toContain('FAKE');
  });

  it('does not match a phrase split by the boundary', () => {
    const prefix = 'token ';
    const filler = 'x'.repeat(VERSE_SEARCH_MAX_SCAN_CHARS - prefix.length);
    const result = search({ a: [message(filler, 1), message(`${prefix}refresh`, 2)] }, '"token refresh"');
    expect(result.hits).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('distinguishes an exact final message from omitted later events or sessions', () => {
    const filler = 'x'.repeat(VERSE_SEARCH_MAX_SCAN_CHARS - 6);
    const complete = search({ a: [message(filler), message('needle', 2)] }, 'needle');
    expect(complete.hits).toHaveLength(1);
    expect(complete.truncated).toBe(false);
    const events = search({ a: [message(filler), message('needle', 2), message('needle later', 3)] }, 'needle');
    expect(events.hits.map((hit) => hit.seq)).toEqual([2]);
    expect(events.truncated).toBe(true);
    const read: string[] = [];
    const sessions = searchSessions({
      sessions: [session('b'), session('a')],
      readEvents: (id) => { read.push(id); return id === 'a' ? [message(filler), message('needle', 2)] : [message('needle later')]; },
      query: 'needle', now,
    });
    expect(read).toEqual(['a']);
    expect(sessions.scannedSessions).toBe(1);
    expect(sessions.hits.map((hit) => hit.sessionId)).toEqual(['a']);
    expect(sessions.truncated).toBe(true);
  });

  it('preserves ranking, stable ordering, hit limits, scrubbing, and unreadable log tolerance', () => {
    const sessions = ['c', 'bad', 'b', 'a'].map(session);
    const result = searchSessions({
      sessions,
      readEvents: (id) => {
        if (id === 'bad') throw new Error('unreadable fake log');
        if (id === 'a') return Array.from({ length: 4 }, (_, i) => message(`needle sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE ${i}`, i + 1));
        return [message('needle', 1, id === 'c' ? 'assistant-message' : 'user-message')];
      },
      query: 'needle', now,
    });
    expect(result.scannedSessions).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.hits.map((hit) => [hit.sessionId, hit.seq])).toEqual([
      ['a', 4], ['a', 3], ['a', 2], ['b', 1], ['c', 1],
    ]);
    expect(result.hits[0].snippet).toContain('[REDACTED]');
    expect(result.hits[0].snippet).not.toContain('FAKEFAKE');
  });
});
