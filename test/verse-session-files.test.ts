/**
 * core/verse/session-files.ts — the Files pane browser's unit suite.
 *
 * Hermetic: every fixture is a mkdtemp tree; the "session" is the two fields
 * browsing reads (projectPath + extraRoots). The policy under test is the
 * preview's, not the resource console's vault rules — group-writable bits and
 * hardlink counts are deliberately NOT required (see the module header),
 * while names, symlink containment, UTF-8 text and the entry/byte caps are.
 */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  browseSessionFiles,
  readSessionFile,
  SessionFilesError,
  VERSE_FILE_BROWSE_MAX_ENTRIES,
  VERSE_FILE_READ_MAX_BYTES,
} from '../src/core/verse/session-files.js';
import type { SessionFilesSession } from '../src/core/verse/session-files.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { base: string; root: string; session: SessionFilesSession } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verse-session-files-')));
  roots.push(base);
  const root = join(base, 'project');
  mkdirSync(root, { mode: 0o700 });
  return { base, root, session: { projectPath: root } };
}

async function browseError(session: SessionFilesSession, path?: string, root?: string): Promise<SessionFilesError> {
  try {
    await browseSessionFiles({ session, ...(root === undefined ? {} : { root }) }, path);
    throw new Error('expected browseSessionFiles to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(SessionFilesError);
    return error as SessionFilesError;
  }
}

async function readError(session: SessionFilesSession, path: string, root?: string): Promise<SessionFilesError> {
  try {
    await readSessionFile({ session, ...(root === undefined ? {} : { root }) }, path);
    throw new Error('expected readSessionFile to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(SessionFilesError);
    return error as SessionFilesError;
  }
}

describe('browseSessionFiles', () => {
  it('lists the root directories-first then files, with root-relative paths and sizes', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'src'));
    mkdirSync(join(f.root, 'test'));
    writeFileSync(join(f.root, 'src', 'a.ts'), 'aaaa');
    writeFileSync(join(f.root, 'z.txt'), 'zz');
    writeFileSync(join(f.root, 'a.txt'), 'a');
    const res = await browseSessionFiles({ session: f.session }, '');
    expect(res.path).toBe('');
    expect(res.root).toBe(realpathSync(f.root));
    expect(res.entries).toEqual([
      { name: 'src', path: 'src', kind: 'directory', sizeBytes: null },
      { name: 'test', path: 'test', kind: 'directory', sizeBytes: null },
      { name: 'a.txt', path: 'a.txt', kind: 'file', sizeBytes: 1 },
      { name: 'z.txt', path: 'z.txt', kind: 'file', sizeBytes: 2 },
    ]);
    // A subdirectory browses with paths relative to the ROOT, not the dir.
    const sub = await browseSessionFiles({ session: f.session }, 'src');
    expect(sub.path).toBe('src');
    expect(sub.entries).toEqual([{ name: 'a.ts', path: 'src/a.ts', kind: 'file', sizeBytes: 4 }]);
  });

  it('skips hidden, credential-, key- and build-shaped names but keeps safe dotfiles', async () => {
    const f = fixture();
    mkdirSync(join(f.root, '.github'));
    mkdirSync(join(f.root, 'node_modules'));
    for (const name of ['.gitignore', '.env', '.npmrc', 'secrets.json', 'id_rsa', 'cert.pem', 'ok.txt']) {
      writeFileSync(join(f.root, name), 'x');
    }
    writeFileSync(join(f.root, '.github', 'ci.yml'), 'x');
    const res = await browseSessionFiles({ session: f.session }, '');
    expect(res.entries.map((e) => e.name)).toEqual(['.github', '.gitignore', 'ok.txt']);
    const gh = await browseSessionFiles({ session: f.session }, '.github');
    expect(gh.entries.map((e) => e.path)).toEqual(['.github/ci.yml']);
  });

  it('never lists or follows symlinks — inside the root or pointing out of it', async () => {
    const f = fixture();
    const outside = join(f.base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'loot.txt'), 'x');
    symlinkSync(outside, join(f.root, 'alias'));           // dir symlink → outside
    symlinkSync(join(outside, 'loot.txt'), join(f.root, 'link.txt')); // file symlink
    mkdirSync(join(f.root, 'real'));
    symlinkSync(join(f.root, 'real'), join(f.root, 'real-alias'));
    const res = await browseSessionFiles({ session: f.session }, '');
    expect(res.entries.map((e) => e.name)).toEqual(['real']);
    expect((await browseError(f.session, 'alias')).code).toBe('INVALID');
    expect((await browseError(f.session, 'alias/loot.txt')).code).toBe('INVALID');
    expect((await browseError(f.session, 'real-alias')).code).toBe('INVALID');
  });

  it('rejects traversal, absolute, backslash, empty-segment and overlong paths', async () => {
    const f = fixture();
    for (const path of ['..', '../x', 'a/../b', '/etc', 'a\\b', 'a//b', './a', 'a/.', 'a b/../c', 'x'.repeat(5000)]) {
      expect((await browseError(f.session, path)).code, path).toBe('INVALID');
    }
    expect((await browseError(f.session, 'missing-dir')).code).toBe('NOT_FOUND');
    writeFileSync(join(f.root, 'file.txt'), 'x');
    expect((await browseError(f.session, 'file.txt')).code).toBe('INVALID'); // a file is not a directory
  });

  it('fails an over-cap directory rather than truncating the listing', async () => {
    const f = fixture();
    for (let i = 0; i < VERSE_FILE_BROWSE_MAX_ENTRIES + 1; i++) writeFileSync(join(f.root, `f-${i}.txt`), '');
    expect((await browseError(f.session, '')).code).toBe('LIMIT');
  });

  it('browses a named extra root and refuses roots outside the chat', async () => {
    const f = fixture();
    const second = join(f.base, 'second');
    mkdirSync(second);
    writeFileSync(join(second, 'only-here.txt'), 'x');
    const session: SessionFilesSession = { projectPath: f.root, extraRoots: [second] };
    const res = await browseSessionFiles({ session, root: second }, '');
    expect(res.entries.map((e) => e.name)).toEqual(['only-here.txt']);
    // A symlinked spelling of a chat root is the same root; anything else is refused.
    const alias = join(f.base, 'root-alias');
    symlinkSync(f.root, alias);
    const viaAlias = await browseSessionFiles({ session, root: alias }, '');
    expect(viaAlias.entries).toEqual([]);
    expect((await browseError(session, '', f.base)).code).toBe('INVALID'); // parent of a root is not a root
    expect((await browseError(session, '', '/etc')).code).toBe('INVALID');
    // A root that no longer exists drops out of the browsable set.
    rmSync(second, { recursive: true, force: true });
    expect((await browseError(session, '', second)).code).toBe('INVALID');
  });

  it('answers UNAVAILABLE when the chat has no browsable root left', async () => {
    const f = fixture();
    rmSync(f.root, { recursive: true, force: true });
    expect((await browseError(f.session, '')).code).toBe('UNAVAILABLE');
  });
});

describe('readSessionFile', () => {
  it('returns text with its path, size, byte length and truncation flag', async () => {
    const f = fixture();
    const text = 'hello\nworld\n';
    writeFileSync(join(f.root, 'a.txt'), text);
    const res = await readSessionFile({ session: f.session }, 'a.txt');
    expect(res).toEqual({
      root: realpathSync(f.root),
      path: 'a.txt',
      text,
      sizeBytes: Buffer.byteLength(text),
      byteLength: Buffer.byteLength(text),
      truncated: false,
    });
  });

  it('reads a bounded prefix of a large file and marks it truncated', async () => {
    const f = fixture();
    const prefix = 'a'.repeat(VERSE_FILE_READ_MAX_BYTES - 3);
    const tail = '💡tail';
    writeFileSync(join(f.root, 'big.txt'), prefix + tail);
    const res = await readSessionFile({ session: f.session }, 'big.txt');
    expect(res.truncated).toBe(true);
    expect(res.sizeBytes).toBe(Buffer.byteLength(prefix + tail));
    expect(res.text).toBe(prefix); // the decoder's stream flag keeps the cut on a code-point boundary
    // Exactly at the cap is complete, not truncated.
    writeFileSync(join(f.root, 'exact.txt'), 'b'.repeat(VERSE_FILE_READ_MAX_BYTES));
    expect(await readSessionFile({ session: f.session }, 'exact.txt')).toMatchObject({ truncated: false });
    writeFileSync(join(f.root, 'empty.txt'), '');
    expect(await readSessionFile({ session: f.session }, 'empty.txt')).toMatchObject({ text: '', sizeBytes: 0, truncated: false });
  });

  it('rejects traversal, directories, empty paths and non-root folders', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'dir'));
    writeFileSync(join(f.root, 'a.txt'), 'x');
    for (const path of ['..', '../a.txt', '/etc/passwd', 'a\\b', 'dir', '']) {
      expect((await readError(f.session, path)).code, JSON.stringify(path)).toBe('INVALID');
    }
  });

  it('maps a genuinely absent file to NOT_FOUND', async () => {
    const f = fixture();
    expect((await readError(f.session, 'nope.txt')).code).toBe('NOT_FOUND');
    expect((await readError(f.session, 'dir/nope.txt')).code).toBe('NOT_FOUND');
  });

  it('rejects invalid UTF-8, NUL and control characters as INVALID', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'bad-utf8.txt'), Buffer.from([0xff, 0xfe, 0x41]));
    writeFileSync(join(f.root, 'nul.txt'), Buffer.from('a\0b'));
    writeFileSync(join(f.root, 'esc.txt'), Buffer.from('a\x1bb'));
    writeFileSync(join(f.root, 'c1.txt'), Buffer.from([0x61, 0x85, 0x62])); // NEL, a C1 control
    for (const name of ['bad-utf8.txt', 'nul.txt', 'esc.txt', 'c1.txt']) {
      expect((await readError(f.session, name)).code, name).toBe('INVALID');
    }
    // Tabs, newlines and CR are text; a truncated multibyte tail at the cap is too.
    writeFileSync(join(f.root, 'ws.txt'), 'a\tb\nc\rd');
    expect((await readSessionFile({ session: f.session }, 'ws.txt')).text).toBe('a\tb\nc\rd');
  });

  it('refuses symlinked leaves and escapes; an alias that stays inside still reads', async () => {
    const f = fixture();
    const outside = join(f.base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'loot.txt'), 'x');
    symlinkSync(join(outside, 'loot.txt'), join(f.root, 'link.txt'));
    symlinkSync(outside, join(f.root, 'alias'));
    mkdirSync(join(f.root, 'real'));
    writeFileSync(join(f.root, 'real', 'inner.txt'), 'inside');
    symlinkSync(join(f.root, 'real'), join(f.root, 'real-alias'));
    for (const path of ['link.txt', 'alias/loot.txt']) {
      expect((await readError(f.session, path)).code, path).toBe('INVALID');
    }
    // real-alias resolves INSIDE the root, so the containment rule allows it —
    // the same "symlinked spelling is the same place" rule roots get.
    expect((await readSessionFile({ session: f.session }, 'real-alias/inner.txt')).text).toBe('inside');
    // And it never lists as an entry: dirents that are symlinks are skipped.
    const listed = await browseSessionFiles({ session: f.session }, '');
    expect(listed.entries.map((e) => e.name)).toEqual(['real']);
  });

  it('reads a hardlinked file — the preview policy is not the console vault', async () => {
    const f = fixture();
    const outside = join(f.base, 'hard-target.txt');
    writeFileSync(outside, 'shared inode');
    linkSync(outside, join(f.root, 'hard.txt'));
    expect((await readSessionFile({ session: f.session }, 'hard.txt')).text).toBe('shared inode');
  });

  it('refuses a root that is not one of the chat’s folders', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'a.txt'), 'x');
    expect((await readError(f.session, 'a.txt', f.base)).code).toBe('INVALID');
    expect((await readError(f.session, 'a.txt', '/etc')).code).toBe('INVALID');
  });
});
