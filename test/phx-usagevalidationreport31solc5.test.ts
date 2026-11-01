import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'usage-report-'));
const file = join(root, 'private-filename.jsonl');
const sensitive = 'fake-sensitive-value-9f3d';
const grok = { pool: 'grok-ultra', pctUsed: 23, resetAt: null, source: 'grok-reader', fetchedAt: '2026-10-26T12:00:00.000Z' };
const codex = { pool: 'codex-personal', pctUsed: null, resetAt: null, source: 'codex-personal-reader', fetchedAt: '2026-10-27T12:00:00.000Z' };
const terra = { pool: 'terra', pctUsed: 17, resetAt: null, source: 'terra-reader', fetchedAt: '2026-10-28T12:00:00.000Z', terraResetAt: null };
const journal = { ...grok, fetchedAt: '2026-10-29T12:00:00.000Z', writtenAt: '2026-10-29T12:00:00.000Z', event: 'manual-reading', burnRatePctPerHour: null, projected100At: null, cutActive: false };

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(path = file, json = true) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), 'usage', 'validate', path, ...(json ? ['--json'] : [])], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: root, ASHLR_HOME: join(root, 'ashlr') },
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain(sensitive);
  expect(result.stdout + result.stderr).not.toContain(path);
  return result;
}

function report(result: ReturnType<typeof run>) {
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as {
    schema: string; status: string; total: number; valid: number; invalid: number;
    invalidLines: number[]; omittedInvalidLines: number;
    pools: { pool: string; validCount: number; newestFetchedAt: string }[];
  };
}

describe('usage validate JSON report', { timeout: 60_000 }, () => {
  it('reports valid mixed reader and journal records with the newest timestamp per pool', () => {
    writeFileSync(file, [journal, codex, terra, grok].map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = run();
    expect(result.status).toBe(0);
    expect(report(result)).toEqual({
      schema: 'usage-validation-report.v1', status: 'complete', total: 4, valid: 4, invalid: 0,
      invalidLines: [], omittedInvalidLines: 0,
      pools: [
        { pool: 'codex-personal', validCount: 1, newestFetchedAt: codex.fetchedAt },
        { pool: 'grok-ultra', validCount: 2, newestFetchedAt: journal.fetchedAt },
        { pool: 'terra', validCount: 1, newestFetchedAt: terra.fetchedAt },
      ],
    });
  });

  it('locates malformed lines and rejects unknown properties without revealing their contents', () => {
    writeFileSync(file, [JSON.stringify(grok), `{${sensitive}`, JSON.stringify(codex), JSON.stringify({ ...terra, [sensitive]: sensitive })].join('\n'));
    const result = run();
    expect(result.status).toBe(1);
    expect(report(result)).toMatchObject({ status: 'complete', total: 4, valid: 2, invalid: 2, invalidLines: [2, 4], omittedInvalidLines: 0 });
    expect(report(result).pools.map(pool => pool.pool)).toEqual(['codex-personal', 'grok-ultra']);
    const legacy = run(file, false);
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toBe('Invalid usage reading at line 2.\nInvalid usage reading at line 4.\n');
  });

  it('treats blank lines as invalid while a final newline is only a terminator', () => {
    writeFileSync(file, `${JSON.stringify(grok)}\n\n${JSON.stringify(codex)}\n`);
    const result = run();
    expect(result.status).toBe(1);
    expect(report(result)).toMatchObject({ total: 3, valid: 2, invalid: 1, invalidLines: [2] });
    const legacy = run(file, false);
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toBe('Invalid usage reading at line 2.\n');
  });

  it('distinguishes empty and unreadable files from successful validation', () => {
    writeFileSync(file, '');
    const empty = run();
    expect(empty.status).toBe(1);
    expect(report(empty)).toMatchObject({ status: 'empty', total: 0, valid: 0, invalid: 0, pools: [] });
    const missing = run(join(root, 'missing-file'));
    expect(missing.status).toBe(1);
    expect(report(missing)).toMatchObject({ status: 'unreadable', total: 0, valid: 0, invalid: 0, pools: [] });
    expect(run(file, false).stderr).toBe('Usage readings file is empty.\n');
    expect(run(join(root, 'missing-file'), false).stderr).toBe('Unable to read usage readings file.\n');
  });

  it('caps invalid line diagnostics and counts omitted lines', () => {
    writeFileSync(file, Array.from({ length: 137 }, () => `{${sensitive}`).join('\n'));
    const result = run();
    expect(result.status).toBe(1);
    expect(report(result)).toMatchObject({ total: 137, valid: 0, invalid: 137, invalidLines: Array.from({ length: 100 }, (_, i) => i + 1), omittedInvalidLines: 37, pools: [] });
  });

  it('keeps default success output and rejects unexpected options', () => {
    writeFileSync(file, JSON.stringify(grok));
    const legacy = run(file, false);
    expect(legacy.status).toBe(0);
    expect(legacy.stdout).toBe('Validated 1 usage reading(s).\n');
    const invalidArgs = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), 'usage', 'validate', file, '--json', '--json'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: root, ASHLR_HOME: join(root, 'ashlr') },
    });
    expect(invalidArgs.status).toBe(2);
    expect(invalidArgs.stderr).not.toContain(file);
  });
});
