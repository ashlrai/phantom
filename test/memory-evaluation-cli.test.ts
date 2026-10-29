/** Source runner argument/file boundaries. Only synthetic temporary files. */
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMemoryCli, parseMemoryEvaluationArgs, readFixedMemoryEvaluationFile } from '../scripts/evaluate-memory.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('source-only synthetic memory CLI', () => {
  it('supports only default JSON or the explicit JSON flag, never arbitrary export paths or providers', async () => {
    expect(parseMemoryEvaluationArgs([])).toEqual({ json: true }); expect(parseMemoryEvaluationArgs(['--json'])).toEqual({ json: true });
    for (const args of [['--corpus', '/private/export.json'], ['--model', 'provider'], ['--json', '--json'], ['--install'], ['--help']]) {
      expect(() => parseMemoryEvaluationArgs(args)).toThrow('MEMORY_EVAL_ARGUMENTS');
      expect(await evaluateMemoryCli(args)).toMatchObject({ exitCode: 2, output: { code: 'MEMORY_EVAL_ARGUMENTS' } });
    }
  });
  it('bounds exact regular-file bytes and refuses symlink, traversal and size escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-cli-')); roots.push(root); chmodSync(root, 0o700);
    writeFileSync(join(root, 'fixture.json'), '{"synthetic":true}', { mode: 0o600 });
    expect(readFixedMemoryEvaluationFile(root, 'fixture.json', 128).bytes.toString()).toBe('{"synthetic":true}');
    symlinkSync(join(root, 'fixture.json'), join(root, 'alias.json'));
    expect(() => readFixedMemoryEvaluationFile(root, 'alias.json', 128)).toThrow('MEMORY_EVAL_INPUT');
    expect(() => readFixedMemoryEvaluationFile(root, '../fixture.json', 128)).toThrow('MEMORY_EVAL_INPUT');
    expect(() => readFixedMemoryEvaluationFile(root, 'fixture.json', 4)).toThrow('MEMORY_EVAL_INPUT');
    expect(() => readFixedMemoryEvaluationFile(root, 'fixture.json', 1024 * 1024 + 1)).toThrow('MEMORY_EVAL_INPUT');
  });
});
