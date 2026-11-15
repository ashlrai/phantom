/** markLinkedInAnswered: the owner's one write into the LinkedIn drop folder. Fake ids, temp dirs. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkedInDropDir, markLinkedInAnswered, readLinkedInDrop } from '../src/core/comms/linkedin-drop.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'linkedin-answered-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

const answered = () => join(linkedInDropDir(runsDir), 'answered');

describe('markLinkedInAnswered', () => {
  it('marks once, then reports already', () => {
    const now = () => new Date('2026-11-09T12:00:00.000Z');
    expect(markLinkedInAnswered(runsDir, 'fake-msg-1', now)).toBe('marked');
    expect(readFileSync(join(answered(), 'fake-msg-1'), 'utf8').trim()).toBe('2026-11-09T12:00:00.000Z');
    expect(statSync(join(answered(), 'fake-msg-1')).mode & 0o777).toBe(0o600);
    expect(statSync(answered()).mode & 0o777).toBe(0o700);
    expect(markLinkedInAnswered(runsDir, 'fake-msg-1', () => new Date('2030-01-01T00:00:00.000Z'))).toBe('already');
    expect(readFileSync(join(answered(), 'fake-msg-1'), 'utf8').trim()).toBe('2026-11-09T12:00:00.000Z');
  });

  it.each(['../x', '', 'a'.repeat(81), 'a/b', '.hidden', '-x'])('rejects id %j and writes nothing', id => {
    expect(markLinkedInAnswered(runsDir, id)).toBe('invalid');
    expect(existsSync(join(runsDir, 'comms'))).toBe(false);
    expect(readdirSync(runsDir)).toEqual([]);
  });

  it('accepts an 80-char id', () => {
    expect(markLinkedInAnswered(runsDir, 'a'.repeat(80))).toBe('marked');
  });

  it('removes the message from readLinkedInDrop', () => {
    const inbox = join(linkedInDropDir(runsDir), 'inbox');
    mkdirSync(inbox, { recursive: true });
    for (const id of ['fake-msg-1', 'fake-msg-2']) {
      writeFileSync(join(inbox, `${id}.json`), JSON.stringify({ id, from: 'Fake Person', text: 'hello', at: '2026-11-09T10:00:00Z', threadUrl: 'https://www.linkedin.com/messaging/thread/fake' }));
    }
    expect(readLinkedInDrop({ runsDir }).messages.map(m => m.id)).toEqual(['fake-msg-1', 'fake-msg-2']);
    expect(markLinkedInAnswered(runsDir, 'fake-msg-1')).toBe('marked');
    expect(readLinkedInDrop({ runsDir }).messages.map(m => m.id)).toEqual(['fake-msg-2']);
  });
});
