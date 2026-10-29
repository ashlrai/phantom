import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { checkConstitutionRepository, checkConstitutionRules } from '../src/core/constitution-check.js';
import { cmdConstitution } from '../src/cli/constitution.js';

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), readFile: vi.fn(), readdir: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function check(text: string, reference = '') {
  return checkConstitutionRules({ path: 'CONSTITUTION.md', text }, [{ path: 'prompts/task.md', text: reference }]);
}

describe('constitution rule IDs', () => {
  it('accepts headings and bullet/numbered definitions with Markdown decoration', () => {
    const result = check('## CON-001: Scope\n- **RULE-2** Evidence\n1. [SAFE-RULE-03] Stop\n### `CON-004` Read',
      'Follow CON-001, RULE-2, SAFE-RULE-03 and CON-004. CON-001 applies again.');
    expect(result).toEqual({ ok: true, ruleCount: 4, referenceCount: 5, filesChecked: 1, diagnostics: [] });
  });
  it('reports missing references with exact file and line', () => {
    expect(check('## CON-001 Scope', 'CON-001\r\nCON-999').diagnostics).toEqual([
      { path: 'prompts/task.md', line: 2, id: 'CON-999', kind: 'missing' },
    ]);
  });
  it('reports duplicate definitions even when no prompt references them', () => {
    expect(check('## CON-001 Scope\n- **CON-001** Again')).toMatchObject({ ok: false, ruleCount: 1,
      diagnostics: [{ path: 'CONSTITUTION.md', line: 2, id: 'CON-001', kind: 'duplicate' }] });
  });
  it('does not count prose mentions or fenced examples as definitions', () => {
    expect(check('See CON-001.\n```md\n## CON-002 Example\n```\n~~~\n- CON-003 Example\n~~~',
      'CON-001 CON-002 CON-003').diagnostics.map(row => row.id)).toEqual(['CON-001', 'CON-002', 'CON-003']);
  });
  it('does not interpret ordinary prose, numbered principles or versions as IDs', () => {
    expect(check('# Constitution v1\n1. **Evidence.**\nversion: 3', 'v1 3.29.0')).toMatchObject({ ok: true, ruleCount: 0, referenceCount: 0 });
  });
  it('does not let mentions in another definition introduce a rule', () => {
    expect(check('## CON-001 depends on CON-002', 'CON-002')).toMatchObject({ ok: false, ruleCount: 1 });
  });
});

function repository() {
  const root = resolve('constitution-fixture');
  const content: Record<string, string> = {
    'CONSTITUTION.md': '## CON-001 Scope',
    'prompts/task.md': 'Follow CON-001',
    'src/task-template.ts': 'CON-001',
    'src/unrelated.ts': 'CON-999',
    'node_modules/prompts/task.md': 'CON-999',
    '.github/prompts/task.md': 'CON-999',
    'prompts/example.test.ts': 'CON-999',
  };
  vi.mocked(readFile).mockImplementation(async path => {
    const key = String(path).slice(root.length + 1);
    if (!(key in content)) throw new Error('input not found');
    return content[key];
  });
  vi.mocked(lstat).mockImplementation(async path => {
    const key = String(path).slice(root.length + 1);
    if (key === 'prompts/link.md') return { isSymbolicLink: () => true } as Awaited<ReturnType<typeof lstat>>;
    return { isSymbolicLink: () => false, isDirectory: () => !(key in content), isFile: () => key in content } as Awaited<ReturnType<typeof lstat>>;
  });
  vi.mocked(readdir).mockImplementation(async path => {
    const key = String(path) === root ? '' : String(path).slice(root.length + 1) + '/';
    const children = Object.keys(content).filter(file => file.startsWith(key)).map(file => file.slice(key.length).split('/')[0]);
    if (key === 'prompts/') children.push('link.md');
    return [...new Set(children)] as unknown as Awaited<ReturnType<typeof readdir>>;
  });
  return root;
}

describe('repository and CLI', () => {
  it('discovers prompt directories and template modules while excluding dependencies, tests and symlinks', async () => {
    expect(await checkConstitutionRepository(repository())).toEqual({ ok: true, ruleCount: 1, referenceCount: 2, filesChecked: 2, diagnostics: [] });
  });
  it('checks and deduplicates explicitly selected files', async () => {
    expect(await checkConstitutionRepository(repository(), ['src/unrelated.ts', 'src/unrelated.ts'])).toMatchObject({ ok: false, filesChecked: 1,
      diagnostics: [{ path: 'src/unrelated.ts', line: 1, id: 'CON-999', kind: 'missing' }] });
  });
  it('rejects an explicitly selected symlink', async () => {
    await expect(checkConstitutionRepository(repository(), ['prompts/link.md'])).rejects.toThrow('Symlink input');
  });
  it('prints structured success with exit 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdConstitution(['check', '--root', repository(), '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ ok: true, filesChecked: 2 });
  });
  it('prints actionable diagnostics and exits 1 for unknown IDs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdConstitution(['check', '--root', repository(), 'src/unrelated.ts'])).toBe(1);
    expect(log).toHaveBeenCalledWith('src/unrelated.ts:1: missing rule CON-999');
  });
  it('fails closed on unreadable input with structured JSON', async () => {
    const root = repository();
    vi.mocked(readFile).mockRejectedValue(new Error('unreadable constitution'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdConstitution(['check', '--root', root, '--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ ok: false, error: 'unreadable constitution' });
  });
  it.each([[], ['unknown'], ['check', '--root'], ['check', '--bogus']])('rejects bad usage %j', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdConstitution(args as string[])).toBe(2);
  });
  it('prints help without reading files', async () => {
    vi.mocked(readFile).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdConstitution(['--help'])).toBe(0);
    expect(readFile).not.toHaveBeenCalled();
  });
});
