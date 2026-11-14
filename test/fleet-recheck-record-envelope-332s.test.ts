import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import { RECHECK_RECORD_SCHEMA, recheckLogPath, type ReadRecords, type RecheckRecord } from '../src/core/fleet/recheck-record.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recheck-envelope-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function record(asOf: string): RecheckRecord {
  return {
    schema: RECHECK_RECORD_SCHEMA, asOf, overall: 'VERIFIED',
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: 'fake', asOf },
      claims: { state: 'VERIFIED', active: 0, asOf },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf },
      task: { state: 'VERIFIED', id: null, owner: null, claimReceipt: null, asOf },
      missing: null,
    },
  };
}
function writeLog(dir: string, contents: string): void {
  mkdirSync(join(dir, 'fleet'), { recursive: true });
  writeFileSync(recheckLogPath(dir), contents);
}
async function run(dir: string, args = ['--last', '2', '--json', '--envelope']) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetRecheckRecord(args, { root: dir });
  const stdout = out.mock.calls.map(call => String(call[0]));
  const stderr = err.mock.calls.map(call => String(call[0]));
  out.mockRestore();
  err.mockRestore();
  return { code, stdout, stderr };
}

describe('recheck history CLI envelope', () => {
  it('distinguishes absent from successful empty history without writing', async () => {
    const absent = root();
    const a = await run(absent);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout[0]!) as ReadRecords).toEqual({ rows: [], skipped: 0, missing: true });
    expect(a.stderr).toEqual([]);
    expect(existsSync(recheckLogPath(absent))).toBe(false);
    const empty = root();
    writeLog(empty, '');
    const b = await run(empty);
    expect(b.code).toBe(0);
    expect(JSON.parse(b.stdout[0]!) as ReadRecords).toEqual({ rows: [], skipped: 0, missing: false, outcome: 'ok' });
    expect(readFileSync(recheckLogPath(empty), 'utf8')).toBe('');
  });

  it('counts malformed lines and limits valid rows newest first, preserving legacy output', async () => {
    const dir = root();
    const rows = ['one', 'two', 'three'].map(record);
    const contents = `${JSON.stringify(rows[0])}\ninvalid\n${JSON.stringify(rows[1])}\n{}\n${JSON.stringify(rows[2])}\n`;
    writeLog(dir, contents);
    const result = await run(dir);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!) as ReadRecords).toEqual({ rows: [rows[2], rows[1]], skipped: 2, missing: false, outcome: 'ok' });
    const legacy = await run(dir, ['--last', '2', '--json']);
    expect(legacy.code).toBe(0);
    expect(JSON.parse(legacy.stdout[0]!)).toEqual([rows[2], rows[1]]);
    const human = await run(dir, ['--last', '2']);
    expect(human.code).toBe(0);
    expect(human.stdout.at(-1)).toBe('skipped=2');
    expect(readFileSync(recheckLogPath(dir), 'utf8')).toBe(contents);
  });

  it('emits safe JSON and exits 1 on an unreadable log', async () => {
    const dir = root();
    mkdirSync(recheckLogPath(dir), { recursive: true });
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!) as ReadRecords).toEqual({ rows: [], skipped: 0, missing: false, outcome: 'unreadable', failure: 'EISDIR' });
    expect(result.stdout[0]).not.toContain(dir);
    expect(result.stdout[0]).not.toMatch(/stack|\//i);
    expect(result.stderr).toEqual([]);
    expect(existsSync(recheckLogPath(dir))).toBe(true);
  });

  it.each([
    ['--envelope'], ['--json', '--envelope'], ['--last', '1', '--envelope'],
    ['--last', '0', '--json', '--envelope'], ['--last', '51', '--json', '--envelope'],
    ['--last', '1', '--json', '--envelope', '--envelope'],
    ['--last', '1', '--json', '--envelope', '--json'],
    ['--last', '1', '--json', '--envelope', '--last', '2'],
  ])('rejects invalid arguments %s', async (...args) => {
    const dir = root();
    const result = await run(dir, args);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(existsSync(recheckLogPath(dir))).toBe(false);
  });
});
