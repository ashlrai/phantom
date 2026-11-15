import { mkdtempSync, rmSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { archivePlan, classifyGmailHeuristic, readEmlInbox, summarizeUpdateLine } from '../src/core/comms/gmail-eml-adapter.js';
import { EMAIL_DROP_MAX_BYTES } from '../src/core/comms/email-drop-bridge.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(name: string, content: string, time: number, dir: string): void {
  const path = join(dir, name); writeFileSync(path, content); utimesSync(path, time, time);
}
describe('saved Gmail messages', () => {
  it('classifies headers, deduplicates IDs, skips unsafe files, and plans oldest updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eml-')); dirs.push(dir);
    fixture('old.eml', 'From: news@example.test\nMessage-ID: <old@example.test>\nSubject: Old\nList-Unsubscribe:\n <mailto:list@example.test>\n\nUpdate', 1, dir);
    fixture('new.eml', 'From: digest@example.test\nMessage-ID: <new@example.test>\nSubject: New\n\nUpdate', 2, dir);
    fixture('person.eml', 'From: pat@example.test\nMessage-ID: <person@example.test>\nSubject: Help?\nAuto-Submitted: no\n\nPlease reply', 3, dir);
    fixture('duplicate.eml', 'From: pat@example.test\nMessage-ID: <person@example.test>\n\nDuplicate?', 0, dir);
    fixture('auto.eml', 'From: pat@example.test\nAuto-Submitted: auto-\n replied\n\nQuestion?', 4, dir);
    writeFileSync(join(dir, 'large.eml'), Buffer.alloc(EMAIL_DROP_MAX_BYTES + 1));
    symlinkSync(join(dir, 'person.eml'), join(dir, 'link.eml'));
    const messages = readEmlInbox(dir);
    expect(messages).toHaveLength(4);
    expect(messages[0]?.autoSubmitted).toBe('auto- replied');
    const classes = messages.map(m => classifyGmailHeuristic(m));
    expect(classes).toEqual(['reply', 'reply', 'update', 'update']);
    expect(archivePlan(messages, classes, 2)).toEqual({ unread: 4, target: 2, archiveCandidates: ['old@example.test', 'new@example.test'] });
    expect(summarizeUpdateLine(messages[2]!)).toBe('digest@example.test · New');
  });
});
