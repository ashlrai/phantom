/** Source runner argument/file boundaries. Only synthetic temporary files. */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateMemoryCli, parseMemoryEvaluationArgs, readFixedMemoryEvaluationFile } from '../scripts/evaluate-memory.js';
import { runBoundedCommand } from '../scripts/run-bounded-command.mjs';
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

/** The vulnerable open runs only in an owned child. Reuse the process-group
 * helper with a 1500ms child deadline and 100ms kill grace, not a latency SLO
 * or a change to the suite's existing timeout. */
describe('fixed source descriptors refuse post-stat replacement', () => {
  it.each(['regular', 'changed-inode', 'nonregular'] as const)('checks %s in a finite inert child', async kind => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'memory-cli-descriptor-')));
    roots.push(directory); chmodSync(directory, 0o700);
    const repository = fileURLToPath(new URL('..', import.meta.url));
    const sourcePath = join(repository, 'scripts/evaluate-memory.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const needle = 'lstatSync, openSync, readSync';
    expect(source.split(needle)).toHaveLength(2);
    const require = createRequire(import.meta.url);
    const { build } = require('esbuild') as typeof import('esbuild');
    const bundle = join(directory, 'reader.mjs');
    const hook = String.raw`
import fixtureFs from 'node:fs';
import {execFileSync as fixtureExec} from 'node:child_process';
function openSync(path,flags,...rest) {
  globalThis.__fixtureFlags=flags;
  if (globalThis.__fixtureReplacement===path) {
    globalThis.__fixtureReplacement=null;
    if(globalThis.__fixtureKind==='changed-inode') {
      fixtureFs.renameSync(path,path+'.previous');
      fixtureFs.writeFileSync(path,'{"synthetic":true}',{mode:0o600});
    } else {
      fixtureFs.unlinkSync(path);
      if(process.platform==='win32')fixtureFs.mkdirSync(path);
      else {fixtureExec('/usr/bin/mkfifo',[path]);fixtureFs.chmodSync(path,0o600);}
    }
    globalThis.__fixtureReplaced=true;
  }
  return fixtureOpenSync(path,flags,...rest);
}
function readSync(...args) {globalThis.__fixtureReads++;return fixtureReadSync(...args);}
`;
    await build({ entryPoints: [sourcePath], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      plugins: [{ name: 'owned-evaluator-before-open', setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, args => args.path === sourcePath ? {
          contents: source.replace(needle, 'lstatSync, openSync as fixtureOpenSync, readSync as fixtureReadSync') + hook, loader: 'ts',
        } : undefined);
      } }],
    });
    const resultPath = join(directory, 'result.json');
    const child = join(directory, 'child.mjs');
    writeFileSync(child, `import fs from 'node:fs';import {join} from 'node:path';import {readFixedMemoryEvaluationFile} from ${JSON.stringify(bundle)};
const dir=${JSON.stringify(join(directory, 'fixture'))};fs.mkdirSync(dir,{mode:0o700});
const file=join(dir,'fixture.json');fs.writeFileSync(file,'{"synthetic":true}',{mode:0o600});
const original=fs.lstatSync(file);
globalThis.__fixtureKind=${JSON.stringify(kind)};globalThis.__fixtureReads=0;globalThis.__fixtureReplaced=false;
globalThis.__fixtureReplacement=globalThis.__fixtureKind==='regular'?null:file;
let bytes=null,code=null;
try {bytes=readFixedMemoryEvaluationFile(dir,'fixture.json',128).bytes.toString();}
catch(error) {code=error?.message==='MEMORY_EVAL_INPUT'?'MEMORY_EVAL_INPUT':process.platform==='win32'&&['EPERM','EISDIR','EACCES'].includes(error?.code)?'descriptor-open-refused':'unexpected-reader-error';}
const current=fs.lstatSync(file);
fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({bytes,code,reads:globalThis.__fixtureReads,replaced:globalThis.__fixtureReplaced,nonBlock:Boolean(globalThis.__fixtureFlags&fs.constants.O_NONBLOCK),replacementType:current.isFIFO()?'fifo':current.isDirectory()?'directory':'regular',identityChanged:current.dev!==original.dev||current.ino!==original.ino,pid:process.pid}),{mode:0o600});`, { mode: 0o600 });
    const exitCode = await runBoundedCommand({ command: process.execPath, args: [child], timeoutMs: 1500, killAfterMs: 100 });
    expect(exitCode).toBe(0);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    expect(() => process.kill(result.pid, 0)).toThrow();
    if (process.platform !== 'win32') {
      expect(() => process.kill(-result.pid, 0)).toThrow();
      expect(result.nonBlock).toBe(true);
    }
    if (kind === 'regular') {
      expect(result).toMatchObject({ bytes: '{"synthetic":true}', code: null, replaced: false });
      expect(result.reads).toBeGreaterThan(0);
    } else {
      expect(result).toMatchObject({ bytes: null, replaced: true, reads: 0 });
      expect(result.replacementType).toBe(kind === 'changed-inode' ? 'regular' : process.platform === 'win32' ? 'directory' : 'fifo');
      if (kind === 'changed-inode') expect(result.identityChanged).toBe(true);
      expect(result.code).toBe(kind === 'nonregular' && process.platform === 'win32' ? expect.stringMatching(/^(MEMORY_EVAL_INPUT|descriptor-open-refused)$/) : 'MEMORY_EVAL_INPUT');
    }
  });
});
