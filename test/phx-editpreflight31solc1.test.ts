import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdKnowledge } from '../src/cli/knowledge.js';

let dir: string;
let file: string;
let out: string;
let err: string;
const body = 'PRIVATE BODY: must never appear';
const spec = { id: 'job-123', kind: 'fixed', entries: ['PRIVATE FRAGMENT ENTRY'] };
const edit = (name: string, content: string | null = body) => ({ path: name, content });

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edit-preflight-')));
  file = path.join(dir, 'edits.json');
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function write(value: unknown): string {
  const text = JSON.stringify(value);
  fs.writeFileSync(file, text);
  return text;
}
async function run(...args: string[]): Promise<number> { return cmdKnowledge(['edit-preflight', ...args]); }
async function check(value: unknown): Promise<{ code: number; report: Record<string, unknown> }> {
  const original = write(value);
  const code = await run('--file', file, '--json');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(out).not.toContain(body);
  expect(out).not.toContain(spec.entries[0]);
  expect(err).not.toContain(body);
  expect(err).not.toContain(spec.entries[0]);
  return { code, report: JSON.parse(out) as Record<string, unknown> };
}

describe('knowledge edit-preflight', () => {
  it('accepts ordinary edits and deletions without writing or printing bodies', async () => {
    const result = await check({ edits: [edit('src/example.ts'), edit('obsolete.ts', null)] });
    expect(result).toEqual({ code: 0, report: { ok: true, allowed: ['src/example.ts', 'obsolete.ts'], refusals: [], diverted: [] } });
    expect(fs.readdirSync(dir)).toEqual(['edits.json']);
  });

  it('diverts a changelog only when valid fragment metadata is supplied', async () => {
    const result = await check({ edits: [edit('CHANGELOG.md')], changelog: spec });
    expect(result).toEqual({ code: 0, report: { ok: true, allowed: ['changelog.d/job-123.fixed.md'], refusals: [],
      diverted: [{ from: 'CHANGELOG.md', to: 'changelog.d/job-123.fixed.md' }] } });
  });

  it.each([
    { edits: [edit('CHANGELOG.md')] },
    { edits: [edit('CHANGELOG.md')], changelog: { ...spec, kind: 'bogus' } },
    { edits: [edit('CHANGELOG.md')], changelog: { ...spec, entries: [''] } },
    { edits: [edit('CHANGELOG.md')], changelog: { ...spec, id: '../oops' } },
    { edits: [edit('CHANGELOG.md', null)], changelog: spec },
  ])('refuses a changelog with absent, invalid, or inapplicable metadata %#', async value => {
    const { code, report } = await check(value);
    expect(code).toBe(1);
    expect(report).toMatchObject({ ok: false, allowed: [], diverted: [], refusals: [{ rule: 'changelog-singleton', path: 'CHANGELOG.md' }] });
  });

  it('reports existing policy reasons alongside allowed edits', async () => {
    const { code, report } = await check({ edits: [edit('src/a.ts'), edit('docs/README.md'), edit('package-lock.json')] });
    expect(code).toBe(1);
    expect(report).toMatchObject({ ok: false, allowed: ['src/a.ts'], refusals: [
      { path: 'docs/README.md', rule: 'readme-singleton', why: expect.any(String), redirect: null },
      { path: 'package-lock.json', rule: 'lockfile', why: expect.any(String), redirect: null },
    ] });
  });

  it.each([['src/a.ts', 'src/a.ts'], ['src/a.ts', 'SRC/A.TS']])('refuses colliding paths %s and %s', async (a, b) => {
    const { code, report } = await check({ edits: [edit(a), edit(b)] });
    expect(code).toBe(1);
    expect(report).toMatchObject({ ok: false, allowed: [a], refusals: [{ path: b, rule: 'unsafe-path', why: 'the edit set names the same file twice' }] });
  });

  it.each(['../escape', '/absolute', '.git/config', 'src/evil\nname'])('refuses unsafe path %j', async name => {
    const { code, report } = await check({ edits: [edit(name)] });
    expect(code).toBe(1);
    expect(report).toMatchObject({ ok: false, allowed: [], refusals: [{ rule: 'unsafe-path' }] });
  });

  it.each([null, [], {}, { edits: 'bad' }, { edits: [edit('x'), { path: 'x' }] },
    { edits: [], changelog: { ...spec, entries: [1] } }, { edits: [], extra: true },
    { edits: Array.from({ length: 50001 }, () => edit('x', null)) },
    { edits: [edit('x', 'x'.repeat(8 * 1024 * 1024 + 1))] },
  ])('rejects malformed input %#', async value => {
    const { code, report } = await check(value);
    expect(code).toBe(2);
    expect(report).toEqual({ error: true, exitCode: 2 });
  });

  it.each([[], ['--file'], ['--json'], ['--file', '--json'], ['--file', 'x', '--file', 'y'],
    ['--file', 'x', '--json', '--json'], ['--help', '--json'], ['unexpected']])('rejects invalid arguments %j', async (...args) => {
    expect(await run(...args)).toBe(2);
  });

  it('rejects malformed JSON, oversized files, missing files, directories and symlinks', async () => {
    fs.writeFileSync(file, '{');
    expect(await run('--file', file)).toBe(2);
    fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    expect(await run('--file', file)).toBe(2);
    fs.unlinkSync(file);
    expect(await run('--file', file)).toBe(2);
    fs.writeFileSync(file, '{}');
    const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
    expect(await run('--file', link)).toBe(2);
    expect(await run('--file', dir)).toBe(2);
    expect(out).toBe('');
  });

  it('provides standalone help and readable results without bodies', async () => {
    expect(await run('--help')).toBe(0);
    expect(out).toContain('"edits"');
    expect(out).toContain('owner lane');
    expect(out).toContain('Exit 0');
    out = '';
    write({ edits: [edit('README.md'), edit('src/a.ts')] });
    expect(await run('--file', file)).toBe(1);
    expect(out).toContain('readme-singleton');
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain(body);
  });
});
