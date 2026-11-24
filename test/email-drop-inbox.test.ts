import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEmailDropInbox } from '../src/core/comms/email-drop-config.js';

const roots: string[] = [];
const dir = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('readEmailDropInbox', () => {
  it('reports a missing dir as missing and a file path as not-directory', () => {
    expect(readEmailDropInbox(join(dir('email-drop-none-'), 'absent')))
      .toEqual({ state: 'missing', unsafe: false, pending: 0, newestAtMs: null });
    const file = join(dir('email-drop-file-'), 'inbox');
    writeFileSync(file, 'x', 'utf8');
    expect(readEmailDropInbox(file))
      .toEqual({ state: 'not-directory', unsafe: false, pending: 0, newestAtMs: null });
  });

  it('counts only *.eml entries and keeps the newest entry mtime', () => {
    const inboxDir = dir('email-drop-in-');
    writeFileSync(join(inboxDir, 'b.eml'), 'x', 'utf8');
    writeFileSync(join(inboxDir, 'A.EML'), 'x', 'utf8');
    writeFileSync(join(inboxDir, 'notes.txt'), 'not mail', 'utf8');
    mkdirSync(join(inboxDir, 'dir.eml')); // a directory named *.eml still counts — the pass would fail on it and leave it
    mkdirSync(join(inboxDir, 'plain-dir'));
    const older = new Date('2026-10-30T00:00:00Z');
    const newer = new Date('2026-10-31T00:00:00Z');
    const oldest = new Date('2026-10-29T00:00:00Z');
    utimesSync(join(inboxDir, 'b.eml'), older, older);
    utimesSync(join(inboxDir, 'A.EML'), newer, newer);
    utimesSync(join(inboxDir, 'dir.eml'), oldest, oldest);
    const read = readEmailDropInbox(inboxDir);
    expect(read.state).toBe('ok');
    expect(read.unsafe).toBe(false);
    expect(read.pending).toBe(3);
    expect(read.newestAtMs).toBe(newer.getTime());
  });

  it('flags an other-writable inbox unsafe while still listing it', () => {
    const inboxDir = dir('email-drop-unsafe-');
    writeFileSync(join(inboxDir, 'a.eml'), 'x', 'utf8');
    chmodSync(inboxDir, 0o777);
    const read = readEmailDropInbox(inboxDir);
    expect(read).toMatchObject({ state: 'ok', unsafe: true, pending: 1 });
    expect(read.newestAtMs).not.toBeNull();
  });

  it('reports an unreadable inbox as unreadable, never an empty listing', () => {
    const inboxDir = dir('email-drop-denied-');
    writeFileSync(join(inboxDir, 'a.eml'), 'x', 'utf8');
    chmodSync(inboxDir, 0o000);
    try {
      expect(readEmailDropInbox(inboxDir).state).toBe('unreadable');
    } finally {
      chmodSync(inboxDir, 0o700);
    }
  });
});
