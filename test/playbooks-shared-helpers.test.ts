import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CommandTemplateError,
  extractCommandFence,
  fillCommandTemplate,
  parseCommandTemplate,
  previewCommandTemplate,
} from '../src/core/playbooks/command-template.js';
import { canonicalizePlaybook, playbookTemplate } from '../src/core/playbooks/parse.js';
import {
  getPlaybook,
  getPlaybookSync,
  listLatestPlaybooks,
  listLatestPlaybooksSync,
  savePlaybook,
} from '../src/core/playbooks/store.js';
import {
  formatPlaybookRef,
  isPlainRecord,
  isPlaybookRef,
  isPositivePlaybookVersion,
  normalizeLineEndings,
  parsePlaybookRefText,
  parsePositivePlaybookVersion,
  utf8ByteLength,
} from '../src/core/playbooks/types.js';

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('playbooks shared guards, parsing, template, and store helpers', () => {
  it('validates records, version numbers, refs, UTF-8 byte lengths, and line endings consistently', () => {
    expect(isPlainRecord({ ok: true })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(['a'])).toBe(false);

    expect(isPositivePlaybookVersion(1)).toBe(true);
    expect(isPositivePlaybookVersion(0)).toBe(false);
    expect(isPositivePlaybookVersion(1.5)).toBe(false);
    expect(isPositivePlaybookVersion('1')).toBe(false);

    expect(parsePositivePlaybookVersion('1')).toBe(1);
    expect(parsePositivePlaybookVersion('999999')).toBe(999999);
    expect(parsePositivePlaybookVersion('0')).toBeNull();
    expect(parsePositivePlaybookVersion('01')).toBeNull();
    expect(parsePositivePlaybookVersion('1000000')).toBeNull();
    expect(parsePositivePlaybookVersion('1.5')).toBeNull();

    expect(formatPlaybookRef({ id: 'fix-issue', version: 3 })).toBe('fix-issue@v3');
    expect(parsePlaybookRefText('!fix-issue@v3')).toEqual({ id: 'fix-issue', version: 3 });
    expect(parsePlaybookRefText('fix-issue@2')).toEqual({ id: 'fix-issue', version: 2 });
    expect(parsePlaybookRefText('fix-issue')).toEqual({ id: 'fix-issue', version: null });
    expect(parsePlaybookRefText('Bad_Id')).toBeNull();

    expect(isPlaybookRef({ id: 'fix-issue', version: 1, sha: '0123456789ab' })).toBe(true);
    expect(isPlaybookRef({ id: 'fix-issue', version: 0, sha: '0123456789ab' })).toBe(false);
    expect(isPlaybookRef([])).toBe(false);

    expect(utf8ByteLength('hello')).toBe(5);
    expect(utf8ByteLength('—…')).toBe(6);
    expect(normalizeLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('normalizes line endings in playbook parsing and command fence extraction', () => {
    const crlfPlaybook = playbookTemplate('crlf-check').replace(/\n/g, '\r\n');
    const canonical = canonicalizePlaybook(crlfPlaybook);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(canonical.source).not.toContain('\r');
      expect(canonical.meta.id).toBe('crlf-check');
    }

    const fence = extractCommandFence('```sh\r\necho {{msg:hi}}\r\n```\r\n');
    expect(fence).toEqual({ ok: true, template: 'echo {{msg:hi}}' });
  });

  it('enforces shared control-character rules and piece rendering across fill and preview', () => {
    const multiline = 'echo {{a}}\n\techo {{b:ok}}';
    expect(parseCommandTemplate(multiline).errors).toEqual([]);
    expect(parseCommandTemplate('echo \u0007bad').errors).toHaveLength(1);
    expect(parseCommandTemplate('echo \u202ebidi').errors).toHaveLength(1);

    expect(previewCommandTemplate(multiline, { a: '' })).toBe('echo <a>\n\techo ok');
    expect(previewCommandTemplate(multiline, { a: 'bad\nline' })).toBe('echo <a>\n\techo ok');
    expect(fillCommandTemplate(multiline, { a: 'two words' })).toBe("echo 'two words'\n\techo ok");
    expect(() => fillCommandTemplate(multiline, { a: 'bad\tvalue' })).toThrow(CommandTemplateError);
  });

  it('keeps sync and async store readers in agreement for built-ins and saved versions', async () => {
    const saved = await savePlaybook(playbookTemplate('sync-parity'), { createOnly: true, note: 'initial' });
    expect(saved.ok).toBe(true);

    expect(getPlaybookSync('fix-issue')).toEqual(await getPlaybook('fix-issue'));
    expect(getPlaybookSync('fix-issue', 2)).toBeNull();
    expect(await getPlaybook('fix-issue', 2)).toBeNull();
    expect(getPlaybookSync('sync-parity')).toEqual(await getPlaybook('sync-parity'));
    expect(listLatestPlaybooksSync().map((pb) => pb.meta.id)).toEqual(
      (await listLatestPlaybooks()).map((pb) => pb.meta.id),
    );
  });
});
