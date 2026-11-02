import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNeedsMason, readNeedsMason } from '../src/core/fleet/needs-mason-read.js';

const OPEN = '- [ ] safari-import[keychain]: Approve the one-time Keychain prompt.';
const OPEN_TEXT = 'safari-import[keychain]: Approve the one-time Keychain prompt.';
const idOf = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

describe('parseNeedsMason', () => {
  it('keeps open checkbox lines and strips the markers', () => {
    expect(parseNeedsMason(OPEN)).toEqual([{ id: idOf(OPEN_TEXT), text: OPEN_TEXT }]);
  });

  it('strips dash and star bullets and a bare unchecked box', () => {
    const items = parseNeedsMason('- fake dash item\n* fake star item\n[ ] fake bare box\n- [ ] fake full line');
    expect(items.map(item => item.text)).toEqual(['fake dash item', 'fake star item', 'fake bare box', 'fake full line']);
  });

  it.each(['- [x] fake done', '- [X] fake done upper', '[x] fake bare done'])(
    'skips checked line %j', line => expect(parseNeedsMason(line)).toEqual([]));

  it('skips blanks and headings', () => {
    expect(parseNeedsMason(`\n\n# fake heading\n   \n## fake second heading\n${OPEN}`)).toEqual([{ id: idOf(OPEN_TEXT), text: OPEN_TEXT }]);
  });

  it('skips lines containing "resolved"', () => {
    expect(parseNeedsMason('- [ ] fake resolved earlier\n- [ ] fake still open')).toEqual([{ id: idOf('fake still open'), text: 'fake still open' }]);
  });

  it('drops duplicate lines', () => {
    const items = parseNeedsMason(`${OPEN}\n${OPEN}\n- fake other`);
    expect(items.map(item => item.text)).toEqual([OPEN_TEXT, 'fake other']);
  });

  it('collapses whitespace and drops control characters', () => {
    const items = parseNeedsMason('- [ ] fake  spaced\t item\x07 end');
    expect(items).toEqual([{ id: idOf('fake spaced item end'), text: 'fake spaced item end' }]);
  });

  it('clips each line to 160 characters', () => {
    const text = `fake ${'x'.repeat(200)}`;
    expect(parseNeedsMason(`- [ ] ${text}`)).toEqual([{ id: idOf(text.slice(0, 160)), text: text.slice(0, 160) }]);
  });

  it('gives a stable sha1-derived id', () => {
    expect(parseNeedsMason(OPEN)[0]!.id).toBe(idOf(OPEN_TEXT));
    expect(parseNeedsMason(OPEN)[0]!.id).toBe(parseNeedsMason(OPEN)[0]!.id);
    expect(idOf(OPEN_TEXT)).not.toBe(idOf('fake other'));
  });

  it('keeps at most 20 items', () => {
    const text = Array.from({ length: 25 }, (_, i) => `- [ ] fake item ${i}`).join('\n');
    const items = parseNeedsMason(text);
    expect(items).toHaveLength(20);
    expect(items[19]!.text).toBe('fake item 19');
  });
});

describe('readNeedsMason', () => {
  let runsDir: string;
  beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fake-needs-mason-')); });
  afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

  it('reports absent when the file does not exist', async () => {
    expect(await readNeedsMason({ runsDir })).toEqual({ v: 1, state: 'absent', items: [] });
  });

  it('reports absent when the runs directory itself is missing', async () => {
    expect(await readNeedsMason({ runsDir: join(runsDir, 'fake-missing-dir') })).toEqual({ v: 1, state: 'absent', items: [] });
  });

  it('reads open lines from a regular file', async () => {
    await writeFile(join(runsDir, 'NEEDS-MASON.md'), `# fake notes\n${OPEN}\n- [x] fake done\n`);
    expect(await readNeedsMason({ runsDir })).toEqual({ v: 1, state: 'ok', items: [{ id: idOf(OPEN_TEXT), text: OPEN_TEXT }] });
  });

  it('refuses a symlink as unreadable', async () => {
    await mkdir(join(runsDir, 'real'), { recursive: true });
    await writeFile(join(runsDir, 'real', 'target.md'), OPEN);
    await symlink(join(runsDir, 'real', 'target.md'), join(runsDir, 'NEEDS-MASON.md'));
    expect(await readNeedsMason({ runsDir })).toEqual({ v: 1, state: 'unreadable', items: [] });
  });

  it('refuses a non-file as unreadable', async () => {
    await mkdir(join(runsDir, 'NEEDS-MASON.md'));
    expect(await readNeedsMason({ runsDir })).toEqual({ v: 1, state: 'unreadable', items: [] });
  });

  it('refuses a file over 32 KiB as unreadable', async () => {
    await writeFile(join(runsDir, 'NEEDS-MASON.md'), Buffer.alloc(32 * 1024 + 1, 'x'));
    expect(await readNeedsMason({ runsDir })).toEqual({ v: 1, state: 'unreadable', items: [] });
  });
});
