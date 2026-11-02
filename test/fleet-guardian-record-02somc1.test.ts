import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianRecord } from '../src/cli/fleet-guardian-record.js';
import { cmdFleetGuardianContinue } from '../src/cli/fleet-guardian-continue.js';
import type { GuardianDrainDeps } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const setup = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-record-')));
  const file = join(dir, 'receipt.json');
  const args = ['--manifest', join(dir, 'manifest'), '--source-state', join(dir, 'source'), '--output-dir', dir,
    '--max-retries', '1', '--timeout-ms', '60000'];
  const select = vi.fn(async () => ({ repo: join(dir, 'fake-repo'), sha: 'a'.repeat(40) }));
  const prepare = vi.fn(async () => undefined) as unknown as NonNullable<GuardianDrainDeps['prepare']>;
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false, sensitive: 'private synthetic detail' } } as unknown as GuardianVerifyExclusiveResult;
  const verify = vi.fn(async () => ran);
  return { dir, file, args, drainDeps: { select, prepare, verify }, verify, select };
};
const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

describe('fleet guardian-record', () => {
  it('streams live records and persists the final summary, which guardian-continue accepts', async () => {
    const o = setup();
    try {
      const lines: string[] = [];
      const code = await cmdFleetGuardianRecord([...o.args, '--new-session', '--apply', '--result-file', o.file],
        { drainDeps: o.drainDeps, output: line => { lines.push(line); } });
      expect(code).toBe(0);
      expect(o.verify).toHaveBeenCalledTimes(1);
      expect(lines.map(line => parse(line)['record'])).toEqual(['attempt', 'summary', 'receipt']);
      expect(lines.join('')).not.toContain('private synthetic detail');
      const saved = readFileSync(o.file, 'utf8');
      expect(saved).toBe(lines[1]);
      expect(statSync(o.file).mode & 0o777).toBe(0o600);
      expect(parse(lines[2]!)).toMatchObject({ record: 'receipt', persisted: true });
      const resume = vi.fn(async () => 0);
      expect(await cmdFleetGuardianContinue(['--stdin'], { readInput: async () => saved, resume })).toBe(0);
      expect(resume.mock.calls[0]![0]![0]).toBe('--checkpoint-dir');
      expect(readdirSync(o.dir).filter(name => name.startsWith('.guardian-record-'))).toEqual([]);
    } finally { rmSync(o.dir, { recursive: true, force: true }); }
  });

  it('dry run verifies nothing, saves a preview summary, and continue refuses it as apply authority', async () => {
    const o = setup();
    try {
      const lines: string[] = [];
      expect(await cmdFleetGuardianRecord([...o.args, '--result-file', o.file], { drainDeps: o.drainDeps, output: line => { lines.push(line); } })).toBe(0);
      expect(o.verify).not.toHaveBeenCalled();
      expect(parse(readFileSync(o.file, 'utf8'))).toMatchObject({ mode: 'preview', termination: 'planned' });
      expect(parse(lines[lines.length - 1]!)).toMatchObject({ record: 'receipt', persisted: true });
      expect(await cmdFleetGuardianContinue(['--stdin'], { readInput: async () => readFileSync(o.file, 'utf8'), resume: vi.fn(async () => 0) })).toBe(2);
    } finally { rmSync(o.dir, { recursive: true, force: true }); }
  });

  it('keeps the drain exit code and saves a refused summary', async () => {
    const o = setup();
    try {
      const verify = vi.fn(async () => ({ state: 'refused' as const, reason: 'already-running' as const }));
      expect(await cmdFleetGuardianRecord([...o.args, '--new-session', '--apply', '--result-file', o.file],
        { drainDeps: { ...o.drainDeps, verify }, output: () => {} })).toBe(5);
      expect(parse(readFileSync(o.file, 'utf8'))).toMatchObject({ termination: 'refused', refused: 1 });
    } finally { rmSync(o.dir, { recursive: true, force: true }); }
  });

  it('never overwrites a prior receipt on missing, oversized, or malformed summaries', async () => {
    const o = setup();
    try {
      writeFileSync(o.file, 'old');
      const drains = [
        async () => 2,
        async (_args: string[], deps?: { writeLine?: (line: string) => void | Promise<void> }) => {
          await deps?.writeLine?.(JSON.stringify({ record: 'summary', mode: 'apply', termination: 'drained', attempts: 1, pad: 'x'.repeat(33 * 1024) }) + '\n');
          return 0;
        },
        async (_args: string[], deps?: { writeLine?: (line: string) => void | Promise<void> }) => {
          await deps?.writeLine?.('{"record":"summary"\n');
          return 0;
        },
        async (_args: string[], deps?: { writeLine?: (line: string) => void | Promise<void> }) => {
          await deps?.writeLine?.(JSON.stringify({ record: 'summary', mode: 'apply' }) + '\n');
          return 0;
        },
      ];
      for (const drain of drains) {
        expect(await cmdFleetGuardianRecord([...o.args, '--result-file', o.file], { drain, output: () => {} })).not.toBe(0);
        expect(readFileSync(o.file, 'utf8')).toBe('old');
      }
      expect(readdirSync(o.dir).sort()).toEqual(['receipt.json']);
    } finally { rmSync(o.dir, { recursive: true, force: true }); }
  });

  it('cleans the temporary file and preserves the prior receipt when rename fails', async () => {
    const o = setup();
    try {
      writeFileSync(o.file, 'old');
      const lines: string[] = [];
      expect(await cmdFleetGuardianRecord([...o.args, '--new-session', '--apply', '--result-file', o.file],
        { drainDeps: o.drainDeps, rename: () => { throw Error('fail'); }, output: line => { lines.push(line); } })).not.toBe(0);
      expect(readFileSync(o.file, 'utf8')).toBe('old');
      expect(readdirSync(o.dir).filter(name => name.startsWith('.guardian-record-'))).toEqual([]);
      expect(parse(lines[lines.length - 1]!)).toMatchObject({ record: 'receipt', persisted: false, reason: 'persistence failed' });
    } finally { rmSync(o.dir, { recursive: true, force: true }); }
  });

  it('refuses caller streams, duplicate or colliding result paths, and unsafe targets before the drain runs', async () => {
    const o = setup();
    try {
      const drain = vi.fn(async () => 0);
      const dirTarget = join(o.dir, 'as-dir');
      mkdirSync(dirTarget);
      const link = join(o.dir, 'link.json');
      symlinkSync(join(o.dir, 'missing'), link);
      const cases = [
        [...o.args, '--result-file', o.file, '--json'],
        [...o.args, '--result-file', o.file, '--stream'],
        [...o.args, '--result-file', o.file, '--result-file', o.file],
        [...o.args, '--result-file', join(o.dir, 'manifest')],
        [...o.args, '--result-file', dirTarget],
        [...o.args, '--result-file', link],
        [...o.args, '--result-file', 'relative.json'],
        [...o.args],
      ];
      for (const args of cases) expect(await cmdFleetGuardianRecord(args, { drain, output: () => {} })).not.toBe(0);
      expect(drain).not.toHaveBeenCalled();
    } finally { rmSync(o.dir, { recursive: true, force: true }); }
  });
});
