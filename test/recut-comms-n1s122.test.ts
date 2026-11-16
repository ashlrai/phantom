import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';
import { teammateReplyGapFromInbox } from '../src/core/comms/teammate-reply-gap.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

const dirs: string[] = [];
const tempRuns = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'recut-comms-n1s122-'));
  dirs.push(dir);
  return dir;
};
const writeInbox = (runsDir: string, rows: unknown[]): void => {
  const dir = join(runsDir, 'imessage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'teammates.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
};
const textRow = (rowid: number, handle: string, at: string) => ({ v: 1, at, rowid, senderId: senderIdFor(handle), text: 'ping' });

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('teammateReplyGapFromInbox', () => {
  it('reports unknown when the inbox file is missing', () => {
    const gaps = teammateReplyGapFromInbox(NOW, tempRuns());
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ teammate: 'Teammates', state: 'unknown', unansweredCount: 0 });
  });
  it('is late for a teammate text past the warn window', () => {
    const runsDir = tempRuns();
    writeInbox(runsDir, [textRow(1, '+15550100', minutesAgo(9)), textRow(2, '+15550100', minutesAgo(3))]);
    const [gap] = teammateReplyGapFromInbox(NOW, runsDir);
    expect(gap).toMatchObject({ teammate: 'Teammate', unansweredCount: 2, oldestUnansweredMs: 9 * 60_000, state: 'late' });
  });
  it('clears once a text is marked answered', () => {
    const runsDir = tempRuns();
    writeInbox(runsDir, [textRow(7, '+15550100', minutesAgo(30)), { answered: 7 }]);
    const [gap] = teammateReplyGapFromInbox(NOW, runsDir);
    expect(gap).toMatchObject({ unansweredCount: 0, oldestUnansweredMs: 0, state: 'ok' });
  });
  it('uses the caller label and never leaks handles or text', () => {
    const runsDir = tempRuns();
    writeInbox(runsDir, [textRow(3, '+15550100', minutesAgo(7))]);
    const senderId = senderIdFor('+15550100');
    const [gap] = teammateReplyGapFromInbox(NOW, runsDir, { [senderId]: 'Dot' });
    expect(gap.teammate).toBe('Dot');
    expect(JSON.stringify(gap)).not.toMatch(/15550100|ping/);
  });
});
