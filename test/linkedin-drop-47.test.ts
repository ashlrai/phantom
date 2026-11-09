/** LinkedIn drop reader. Hermetic: temp runs dir, plainly fake values. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LINKEDIN_DROP_MAX_FILE_BYTES, readLinkedInDrop } from '../src/core/comms/linkedin-drop.js';

let runsDir: string, inbox: string, answered: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'linkedin-drop-'));
  inbox = join(runsDir, 'comms', 'linkedin', 'inbox');
  answered = join(runsDir, 'comms', 'linkedin', 'answered');
  mkdirSync(inbox, { recursive: true }); mkdirSync(answered, { recursive: true });
});
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

const msg = (over: Record<string, unknown> = {}) => ({ id: 'm1', from: 'Ada Fake', text: 'Hello there', at: '2026-11-09T10:00:00Z', ...over });
const put = (name: string, body: unknown) => writeFileSync(join(inbox, name), typeof body === 'string' ? body : JSON.stringify(body));

describe('readLinkedInDrop', () => {
  it('reads a healthy message', () => {
    put('a.json', msg({ threadUrl: 'https://www.linkedin.com/messaging/thread/abc/' }));
    const r = readLinkedInDrop({ runsDir });
    expect(r).toEqual({ sourceState: 'healthy', skipped: 0, messages: [
      { id: 'm1', from: 'Ada Fake', text: 'Hello there', at: '2026-11-09T10:00:00.000Z', threadUrl: 'https://www.linkedin.com/messaging/thread/abc/' }] });
  });

  it('reports a missing folder as missing', () => {
    expect(readLinkedInDrop({ runsDir: join(runsDir, 'nope') })).toEqual({ sourceState: 'missing', messages: [], skipped: 0 });
  });

  it('skips a malformed file and degrades', () => {
    put('a.json', msg()); put('b.json', '{not json'); put('c.json', msg({ id: '../x' }));
    const r = readLinkedInDrop({ runsDir });
    expect(r.sourceState).toBe('degraded');
    expect(r.skipped).toBe(2);
    expect(r.messages.map(m => m.id)).toEqual(['m1']);
  });

  it('skips an oversize file', () => {
    put('a.json', msg({ text: 'x'.repeat(LINKEDIN_DROP_MAX_FILE_BYTES + 1) }));
    expect(readLinkedInDrop({ runsDir })).toMatchObject({ sourceState: 'degraded', messages: [], skipped: 1 });
  });

  it('hides an answered message', () => {
    put('a.json', msg()); put('b.json', msg({ id: 'm2' }));
    writeFileSync(join(answered, 'm1'), '');
    const r = readLinkedInDrop({ runsDir });
    expect(r.sourceState).toBe('healthy');
    expect(r.messages.map(m => m.id)).toEqual(['m2']);
  });

  it('scrubs secrets, single-lines and caps text; drops non-linkedin urls', () => {
    put('a.json', msg({ text: `key sk-test-FAKEFAKEFAKE\nsecond line ${'y'.repeat(900)}`, threadUrl: 'https://evil.example.test/x' }));
    const [m] = readLinkedInDrop({ runsDir }).messages;
    expect(m?.text).not.toContain('FAKEFAKEFAKE');
    expect(m?.text).not.toContain('\n');
    expect(m?.text.length).toBeLessThanOrEqual(500);
    expect(m?.threadUrl).toBeUndefined();
  });
});
