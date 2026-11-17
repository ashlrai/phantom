/**
 * RQ-PHX-RECUTCOMMSC464 — recut coverage for the merged LinkedIn drop contract
 * (PR #5326, preserving the #4423 original exporter envelope alongside the flat
 * drop contract). Complements test/linkedin-original-envelope-preservation-239s.test.ts:
 * markers suppress by id across both envelope shapes, the one write path
 * (markLinkedInAnswered) takes a message out of the next read, and fractional
 * original timestamps canonicalize to milliseconds. Temp dirs, fake values.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markLinkedInAnswered,
  readLinkedInDrop,
} from
  '../src/core/comms/linkedin-drop.js';

let root: string, runsDir: string, base: string, inbox: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recut-comms-c464-'));
  runsDir = join(root, 'runs');
  base = join(runsDir, 'comms', 'linkedin');
  inbox = join(base, 'inbox');
  mkdirSync(inbox, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const original = (over: Record<string, unknown> = {}) => ({
  id: 'li-orig-c464',
  threadId: 'thread-fake-c464',
  from: { name: 'Example Sender', profileUrl: 'https://www.linkedin.com/in/example-sender' },
  receivedAt: '2026-11-04T08:15:30.5Z',
  text: 'original exporter text',
  ...over,
});
const flat = (over: Record<string, unknown> = {}) => ({
  id: 'li-flat-c464',
  from: 'Flat Sender',
  text: 'flat drop text',
  at: '2026-11-05T09:30:00Z',
  ...over,
});
const put = (name: string, body: unknown) => writeFileSync(join(inbox, name), JSON.stringify(body));

describe('recut c464: merged LinkedIn envelope contract', () => {
  it('canonicalizes a fractional original receivedAt to milliseconds', () => {
    put('orig.json', original());
    const drop = readLinkedInDrop({ runsDir });
    expect(drop).toMatchObject({ sourceState: 'healthy', skipped: 0 });
    expect(drop.messages).toHaveLength(1);
    expect(drop.messages[0]).toMatchObject({
      id: 'li-orig-c464', from: 'Example Sender', at: '2026-11-04T08:15:30.500Z',
    });
  });

  it('suppresses by id across shapes: answered hides an original, handled hides a flat', () => {
    put('orig.json', original());
    put('flat.json', flat({ id: 'li-flat-c464' }));
    mkdirSync(join(base, 'answered'), { recursive: true });
    mkdirSync(join(base, 'handled'), { recursive: true });
    writeFileSync(join(base, 'answered', 'li-orig-c464'), '');
    writeFileSync(join(base, 'handled', 'li-flat-c464.handled'), '');
    const drop = readLinkedInDrop({ runsDir });
    expect(drop.messages).toEqual([]);
    expect(drop.sourceState).toBe('healthy');
  });

  it('markLinkedInAnswered removes an original-envelope message from the next read', () => {
    put('orig.json', original());
    put('open.json', flat({ id: 'li-open-c464' }));
    expect(readLinkedInDrop({ runsDir }).messages.map(m => m.id).sort())
      .toEqual(['li-open-c464', 'li-orig-c464']);
    expect(markLinkedInAnswered(runsDir, 'li-orig-c464', () => new Date('2026-11-16T00:00:00Z'))).toBe('marked');
    const drop = readLinkedInDrop({ runsDir });
    expect(drop.messages.map(m => m.id)).toEqual(['li-open-c464']);
    expect(markLinkedInAnswered(runsDir, 'li-orig-c464')).toBe('already');
  });
});
