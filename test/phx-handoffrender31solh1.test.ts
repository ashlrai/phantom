import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { estimateHandoffTokens, renderHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

let dir: string;
let file: string;
let out: string;
let err: string;

const good: WorkerHandoff = {
  id: 'w-fake',
  task: 'fake task: rename the stub counter in the fake fixture module',
  files: [{ path: 'src/fake-module.ts', lines: { from: 3, to: 9 }, why: 'fake target' }],
  constraints: [{ rule: 'Do not change the fake signature', reason: 'two fake callers depend on it' }],
  check: 'fake-check command exits 0',
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-handoff-')));
  file = path.join(dir, 'handoff.json');
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function write(value: unknown): void { fs.writeFileSync(file, JSON.stringify(value)); }
async function run(...args: string[]): Promise<number> { return cmdKnowledge(['handoff', ...args]); }
async function check(value: unknown): Promise<{ code: number; report: Record<string, unknown> }> {
  write(value);
  out = '';
  const code = await run('--file', file, '--json');
  expect(out.trim().split('\n')).toHaveLength(1); // a single JSON document
  return { code, report: JSON.parse(out) as Record<string, unknown> };
}

describe('knowledge handoff', () => {
  it('renders a valid handoff exactly like renderHandoff, plus a terminal newline', async () => {
    write({ ...good, findings: ['fake finding one', 'fake finding two'] });
    expect(await run('--file', file)).toBe(0);
    expect(out).toBe(renderHandoff({ ...good, findings: ['fake finding one', 'fake finding two'] }) + '\n');
    expect(err).toBe('');
  });

  it('keeps findings last so the prompt prefix stays append-only', async () => {
    write({ ...good, findings: ['fake later note'] });
    expect(await run('--file', file)).toBe(0);
    expect(out.indexOf('## Done when')).toBeLessThan(out.indexOf('## Found along the way'));
    expect(out.trimEnd().endsWith('- fake later note')).toBe(true);
  });

  it('emits the versioned JSON envelope on success', async () => {
    const { code, report } = await check(good);
    const rendered = renderHandoff(good);
    expect(code).toBe(0);
    expect(report).toEqual({ v: 1, valid: true, prompt: rendered,
      estimatedTokens: estimateHandoffTokens(good), renderedChars: rendered.length });
  });

  it('accepts empty constraints and non-ASCII text with unchanged char/token semantics', async () => {
    const unicode = { ...good, constraints: [],
      task: 'fake tâche café ☕  🔥', findings: ['fake note — naïve façade'] };
    const { code, report } = await check(unicode);
    const rendered = renderHandoff(unicode);
    expect(code).toBe(0);
    expect(report.prompt).toBe(rendered);
    expect(report.renderedChars).toBe(rendered.length); // UTF-16 code units, as the helpers use
    expect(report.estimatedTokens).toBe(estimateHandoffTokens(unicode));
  });

  it('rejects a constraint missing its reason and emits no partial prompt', async () => {
    const { code, report } = await check({ ...good, constraints: [{ rule: 'fake rule', reason: '' }] });
    expect(code).toBe(1);
    expect(report).toMatchObject({ v: 1, valid: false,
      problems: [{ field: 'constraints[0].reason', detail: expect.stringContaining('reasoned away') }] });
    expect(report).not.toHaveProperty('prompt');
    out = '';
    expect(await run('--file', file)).toBe(1);
    expect(out).toBe(''); // text mode: stdout stays clean on failure
    expect(err).toContain('constraints[0].reason');
  });

  it('rejects pasted source where a path belongs', async () => {
    const pasted = 'export function fakeStub() {\n  return 1;\n}';
    const { code, report } = await check({ ...good, files: [{ path: pasted }] });
    expect(code).toBe(1);
    expect(report).toMatchObject({ v: 1, valid: false,
      problems: [{ field: 'files[0].path', detail: expect.stringContaining('CONTENTS') }] });
    expect(JSON.stringify(report)).not.toContain('return 1');
  });

  it('rejects an oversized rendered prompt without truncating it', async () => {
    const { code, report } = await check({ ...good, task: `fake ${'bulk '.repeat(3000)}` });
    expect(code).toBe(1);
    expect(report).toMatchObject({ v: 1, valid: false,
      problems: [{ field: 'handoff', detail: expect.stringContaining('6000') }] });
    expect(report).not.toHaveProperty('prompt');
    expect(JSON.stringify(report)).not.toContain('bulk'); // never echoes the input
  });

  it.each([null, [], 42, 'str', { ...good, extra: true }, { ...good, id: 7 },
    { ...good, files: 'nope' }, { ...good, files: [42] }, { ...good, files: [{ path: 1 }] },
    { ...good, files: [{ path: 'a', bogus: 1 }] },
    { ...good, files: [{ path: 'a', lines: 'x' }] },
    { ...good, files: [{ path: 'a', lines: { from: '1', to: 2 } }] },
    { ...good, files: [{ path: 'a', lines: { from: 1, to: 2, extra: 3 } }] },
    { ...good, constraints: 'x' }, { ...good, constraints: [{ rule: 1, reason: 'y' }] },
    { ...good, constraints: [{ rule: 'x' }] }, { ...good, findings: 'x' }, { ...good, findings: [1] },
  ])('rejects malformed JSON shape %#', async value => {
    const { code, report } = await check(value);
    expect(code).toBe(1);
    expect(report.v).toBe(1);
    expect(report.valid).toBe(false);
    expect(Array.isArray(report.problems)).toBe(true);
    expect((report.problems as unknown[]).length).toBeGreaterThan(0);
  });

  it('rejects semantic failures reported by validateHandoff', async () => {
    for (const value of [{ ...good, task: '  ' }, { ...good, files: [] },
        { ...good, check: '' }, { ...good, files: [{ path: 'a', lines: { from: 9, to: 4 } }] }]) {
      const { code, report } = await check(value);
      expect(code).toBe(1);
      expect(report.valid).toBe(false);
    }
  });

  it('rejects malformed JSON, oversized, missing, directory and symlink inputs', async () => {
    fs.writeFileSync(file, '{');
    expect(await run('--file', file, '--json')).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ v: 1, valid: false });
    out = '';
    fs.truncateSync(file, 64 * 1024 + 1);
    expect(await run('--file', file)).toBe(1);
    fs.unlinkSync(file);
    expect(await run('--file', file)).toBe(1);
    write(good);
    const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
    expect(await run('--file', link)).toBe(1);
    expect(await run('--file', dir)).toBe(1);
    expect(out).toBe('');
  });

  it.each([[], ['--json'], ['--file'], ['--file', '--json'], ['--bogus'],
    ['positional'], ['--file', 'x', '--file', 'y'], ['--json', '--json'],
    ['--help', '--json'], ['-h', 'extra']])('rejects invalid arguments %j', async (...args) => {
    expect(await run(...args)).toBe(2);
  });

  it('emits the standard parent error object for bad arguments under --json', async () => {
    expect(await run('--bogus', '--json')).toBe(2);
    expect(JSON.parse(out)).toEqual({ error: true, exitCode: 2 });
    out = '';
    expect(await run('--file', file, '--file', file, '--json')).toBe(2);
    expect(JSON.parse(out)).toEqual({ error: true, exitCode: 2 });
  });

  it('prints isolated help without opening any file', async () => {
    vi.resetModules();
    const read = vi.fn(() => { throw new Error('must not be called'); });
    vi.doMock('../src/core/util/stable-file-read.js', () => ({ readStableRegularFile: read }));
    try {
      const { cmdKnowledge } = await import('../src/cli/knowledge.js');
      expect(await cmdKnowledge(['handoff', '--help'])).toBe(0);
      expect(await cmdKnowledge(['handoff', '-h'])).toBe(0);
      expect(out).toContain('Usage: phm knowledge handoff --file');
      expect(out).toContain('64 KiB');
      expect(await cmdKnowledge(['handoff', '--help', '--file', file])).toBe(2);
      expect(read).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      vi.doUnmock('../src/core/util/stable-file-read.js');
    }
  });
});
