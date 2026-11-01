import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseReadyRows, rewriteReadyRows, type ReadyRow } from '../src/core/fleet/ready-row-edit.js';

let root: string;
let queueDir: string;
let path: string;
const line = (id: string, lane = 'devin', tier = 'work', repo = 'phantom') => `${id}\t${repo}\t${lane}\t${tier}\t${queueDir}/prompts/${id}.md`;
const fixture = () => `${line('RQ-PHX-FAKEONE01', 'codex-personal')}\n${line('RQ-PHX-FAKETWO02', 'codex-personal', 'mid')}\n${line('RQ-PHX-FAKE33303', 'devin')}\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ready-row-edit-'));
  queueDir = join(root, 'queue');
  await mkdir(join(queueDir, 'prompts'), { recursive: true });
  path = join(queueDir, 'ready.tsv');
  await writeFile(path, fixture());
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const retier = (row: ReadyRow, lane: string, tier = row.tier): ReadyRow => {
  const cells = row.raw.split('\t');
  cells[2] = lane;
  cells[3] = tier;
  return { ...row, lane, tier, raw: cells.join('\t') };
};

it('parses positional rows, skips blanks and comments, and keeps extra columns in raw', () => {
  const rows = parseReadyRows(`# header comment\n\nRQ-A\tphantom\tdevin\twork\t/q/p/RQ-A.md\textra\tcolumns\nRQ-B\tphantom\tPARKED-BYHAND.codex-local\tmid\t/q/p/RQ-B.md\n`);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ id: 'RQ-A', repo: 'phantom', lane: 'devin', tier: 'work', promptPath: '/q/p/RQ-A.md' });
  expect(rows[0]!.raw).toBe('RQ-A\tphantom\tdevin\twork\t/q/p/RQ-A.md\textra\tcolumns');
  expect(rows[1]!.lane).toBe('PARKED-BYHAND.codex-local');
});

it('rewrites only the edited row and leaves every other byte unchanged', async () => {
  const result = await rewriteReadyRows(queueDir, (rows) =>
    rows.map((row) => row.id === 'RQ-PHX-FAKEONE01' ? retier(row, 'devin', 'mid') : row), { verifyMs: 0 });
  expect(result).toEqual({ changed: 1, attempts: 1, verified: true });
  const lines = (await readFile(path, 'utf8')).split('\n');
  expect(lines[0]).toBe(line('RQ-PHX-FAKEONE01', 'devin', 'mid'));
  expect(lines.slice(1).join('\n')).toBe(fixture().split('\n').slice(1).join('\n'));
});

it('writes nothing when the edit returns null or changes no row', async () => {
  const original = await readFile(path, 'utf8');
  for (const edit of [() => null, (rows: ReadyRow[]) => rows.map((row) => ({ ...row }))] as const) {
    expect(await rewriteReadyRows(queueDir, edit, { verifyMs: 0 })).toEqual({ changed: 0, attempts: 0, verified: true });
    expect(await readFile(path, 'utf8')).toBe(original);
  }
});

it('removes rows the edit drops and keeps a missing trailing newline', async () => {
  await writeFile(path, fixture().trimEnd());
  const result = await rewriteReadyRows(queueDir, (rows) => rows.filter((row) => row.id !== 'RQ-PHX-FAKETWO02'), { verifyMs: 0 });
  expect(result).toEqual({ changed: 1, attempts: 1, verified: true });
  expect(await readFile(path, 'utf8')).toBe(`${line('RQ-PHX-FAKEONE01', 'codex-personal')}\n${line('RQ-PHX-FAKE33303')}`);
});

it('survives one dispatcher-style revert and verifies after the second attempt', async () => {
  const original = await readFile(path, 'utf8');
  let reverts = 1;
  const sleep = async () => { if (reverts-- > 0) await writeFile(path, original); };
  const result = await rewriteReadyRows(queueDir, (rows) =>
    rows.map((row) => row.id === 'RQ-PHX-FAKEONE01' ? retier(row, 'devin') : row), { sleep });
  expect(result).toEqual({ changed: 1, attempts: 2, verified: true });
  expect((await readFile(path, 'utf8')).split('\n')[0]).toBe(line('RQ-PHX-FAKEONE01', 'devin'));
});

it('reports verified false when every write is reverted', async () => {
  const original = await readFile(path, 'utf8');
  const sleep = async () => { await writeFile(path, original); };
  const result = await rewriteReadyRows(queueDir, (rows) =>
    rows.map((row) => row.id === 'RQ-PHX-FAKEONE01' ? retier(row, 'devin') : row), { sleep });
  expect(result).toEqual({ changed: 1, attempts: 3, verified: false });
});

it('leaves no temp files behind, even when every attempt is reverted', async () => {
  const original = await readFile(path, 'utf8');
  const sleep = async () => { await writeFile(path, original); };
  await rewriteReadyRows(queueDir, (rows) => rows.map((row) => retier(row, 'devin')), { sleep });
  expect((await readdir(queueDir)).filter((name) => name.includes('.tmp'))).toEqual([]);
});
