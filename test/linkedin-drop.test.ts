import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLinkedInDrop, readLinkedInPending } from '../src/core/comms/linkedin-drop.js';
import { readUnifiedInbox } from '../src/core/comms/unified-inbox.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const message = { id: 'example-1', threadId: 'thread-1', from: { name: 'Example User', profileUrl: 'https://www.linkedin.com/in/example-user' }, receivedAt: '2026-11-04T12:00:00Z', text: 'Hello there' };
const raw = (value: unknown): string => JSON.stringify(value);
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'linkedin-drop-')); roots.push(root);
  const dir = join(root, 'inbound'); mkdirSync(dir);
  return { root, dir };
}

describe('LinkedIn drops', () => {
  it('strictly parses required fields and ISO dates', () => {
    expect(parseLinkedInDrop(raw(message))).toEqual(message);
    for (const value of [null, [], { ...message, id: '' }, { ...message, id: '../escape' }, { ...message, receivedAt: 'not a date' }, { ...message, receivedAt: '2026-02-30T12:00:00Z' }]) {
      expect(parseLinkedInDrop(raw(value))).toBeNull();
    }
  });
  it('strips controls and caps text in bytes', () => {
    const parsed = parseLinkedInDrop(raw({ ...message, text: `a\u0000\u0001${'é'.repeat(5000)}` }))!;
    expect(parsed.text).not.toContain('\u0000');
    expect(parsed.text).not.toContain('\u0001');
    expect(Buffer.byteLength(parsed.text)).toBeLessThanOrEqual(8192);
  });
  it('reports missing and degraded sources, deduplicates and honors markers', () => {
    const { root, dir } = setup();
    expect(readLinkedInPending({ dir: join(root, 'missing') }).sourceState).toBe('missing');
    writeFileSync(join(dir, 'good.json'), raw(message));
    writeFileSync(join(dir, 'duplicate.json'), raw(message));
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(readLinkedInPending({ dir })).toMatchObject({ sourceState: 'degraded', badFiles: 1, messages: [message] });
    mkdirSync(join(root, 'handled'));
    writeFileSync(join(root, 'handled', 'example-1.handled'), '');
    expect(readLinkedInPending({ dir }).messages).toEqual([]);
  });
  it('adds draft-only items and preserves other sources when a drop is broken', async () => {
    const { root, dir } = setup();
    const runsDir = join(root, 'runs'); mkdirSync(runsDir);
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'), '- fake decision\n');
    writeFileSync(join(dir, 'good.json'), raw(message));
    writeFileSync(join(dir, 'bad.json'), '{');
    const inbox = await readUnifiedInbox({ runsDir, busRoot: join(root, 'bus'), linkedinDir: dir });
    expect(inbox.sources.linkedin).toEqual({ state: 'degraded', pending: 1 });
    expect(inbox.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'linkedin:example-1', source: 'linkedin', kind: 'outside-message', detail: expect.stringContaining('Draft only: outside contact'), act: [] }), expect.objectContaining({ source: 'needs-you' })]));
  });
});
