import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTeammateLatency, summarizeTeammateLatency } from '../src/core/comms/teammate-reply-latency.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const text = (rowid: number, minsAgo: number, body = 'zebra please check the build?') =>
  ({ v: 1, at: iso(minsAgo * MIN), rowid, senderId: 'imessage:fake0000', text: body });
const answer = (rowid: number, minsAgo: number) => ({ v: 1, answered: rowid, at: iso(minsAgo * MIN) });

describe('summarizeTeammateLatency', () => {
  it('pairs texts with answered markers and computes odd-count stats', () => {
    const s = summarizeTeammateLatency(
      [text(1, 100), answer(1, 97), text(2, 90), answer(2, 80), text(3, 60), answer(3, 59)],
      { now: NOW },
    );
    expect(s).toMatchObject({ texts: 3, answered: 3, unanswered: 0, medianMinutes: 3, maxMinutes: 10, p90Minutes: 10, withinTarget: 2, oldestUnanswered: null });
  });

  it('averages the middle two for an even count', () => {
    const s = summarizeTeammateLatency(
      [text(1, 100), answer(1, 98), text(2, 90), answer(2, 84), text(3, 60), answer(3, 58), text(4, 50), answer(4, 40)],
      { now: NOW },
    );
    expect(s.answered).toBe(4);
    expect(s.medianMinutes).toBe(4);
    expect(s.p90Minutes).toBe(10);
  });

  it('excludes texts outside the window', () => {
    const s = summarizeTeammateLatency([text(1, 25 * 60), text(2, 10)], { now: NOW });
    expect(s.texts).toBe(1);
    expect(s.oldestUnanswered?.rowid).toBe(2);
    expect(summarizeTeammateLatency([text(1, 25 * 60)], { now: NOW, windowMs: 48 * 3_600_000 }).texts).toBe(1);
  });

  it('counts acks and code chunks as ignorable, not unanswered', () => {
    const s = summarizeTeammateLatency(
      [text(1, 30, 'thanks'), text(2, 20, 'patch 1/3 is this ok?'), text(3, 10)],
      { now: NOW },
    );
    expect(s).toMatchObject({ texts: 3, ignorable: 2, unanswered: 1 });
  });

  it('reports the oldest unanswered text with its intent', () => {
    const s = summarizeTeammateLatency(
      [text(5, 14, 'please approve the release?'), text(6, 3), text(7, 40), answer(7, 39)],
      { now: NOW },
    );
    expect(s.unanswered).toBe(2);
    expect(s.oldestUnanswered).toEqual({ rowid: 5, ageMinutes: 14, intent: 'leader' });
  });

  it('never leaks text or sender ids', () => {
    const json = JSON.stringify(summarizeTeammateLatency([text(1, 5, 'zebra please help?')], { now: NOW }));
    expect(json).not.toContain('zebra');
    expect(json).not.toContain('imessage:');
  });
});

describe('readTeammateLatency', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const setup = (content?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tmlat-'));
    dirs.push(dir);
    if (content !== undefined) {
      mkdirSync(join(dir, 'imessage'), { recursive: true });
      writeFileSync(join(dir, 'imessage', 'teammates.jsonl'), content, { mode: 0o600 });
    }
    return dir;
  };

  it('missing file gives zero counts', () => {
    const s = readTeammateLatency({ runsDir: setup(), now: () => NOW });
    expect(s).toMatchObject({ sourceState: 'missing', texts: 0, answered: 0, medianMinutes: null });
  });

  it('malformed lines degrade but valid rows still count', () => {
    const body = `${JSON.stringify(text(1, 10))}\n{not json\n`;
    const s = readTeammateLatency({ runsDir: setup(body), now: () => NOW });
    expect(s).toMatchObject({ sourceState: 'degraded', texts: 1, unanswered: 1 });
  });
});
