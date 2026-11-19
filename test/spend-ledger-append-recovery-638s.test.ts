import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { parseSpendDecision, readSpendLedger, SPEND_LEDGER_MAX_BYTES } from '../src/core/providers/coding-cli/ledger.js';
import { appendSpendDecision, SPEND_ROW_MAX_BYTES } from '../src/core/providers/coding-cli/ledger-append.js';

afterEach(() => vi.restoreAllMocks());

const loaders = { 'spend-record': () => import('../src/cli/fleet-spend-record.js') };

// Plainly fake data only. The account identifier must never reach CLI output.
const ACCOUNT = 'acct-fake-638s';
const base = {
  ts: '2026-11-02T00:00:00.000Z', poolId: 'pool-fake-b', billing: 'credit', balanceKnown: true, expiryKnown: false,
  complexity: 'low', risk: 'low', backend: 'fake-backend', accountId: ACCOUNT, model: 'fake-model-638',
  escalations: 0, verification: 'passed', ci: 'passed', merged: true, timeMs: 1200, quota: null, cost: null,
};
const rowText = (o: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...o });
const OLD = JSON.stringify({ ...base, accountId: null, ts: '2026-11-01T00:00:00.000Z', quota: 3, cost: 1.5 }) + '\n';
const expectedLine = (o: Record<string, unknown> = {}) => `${JSON.stringify(parseSpendDecision(rowText(o)))}\n`;

function setup(ledger: string | null = OLD, row: string | null = rowText()) {
  const dir = mkdtempSync(join(tmpdir(), 'spend-append-638s-'));
  const file = join(dir, 'ledger.jsonl');
  const rowFile = join(dir, 'row.json');
  if (ledger !== null) writeFileSync(file, ledger);
  if (row !== null) writeFileSync(rowFile, row);
  return { dir, file, rowFile };
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { out.push(String(s)); });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => { err.push(String(s)); });
  const code = await cmdFleet(['spend-record', ...args], loaders);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('fleet spend-record (append recovered from #5952)', () => {
  it('previews by default without touching the ledger bytes', async () => {
    const { dir, file, rowFile } = setup();
    const before = readFileSync(file, 'utf8');
    const mtime = statSync(file).mtimeMs;
    const r = await run(['--file', file, '--row-file', rowFile, '--json']);
    expect(r.code).toBe(0);
    const receipt = JSON.parse(r.out);
    expect(receipt).toMatchObject({ schema: 'fleet.spend-record.v1', status: 'preview', appended: false });
    expect(receipt.bytes).toBe(Buffer.byteLength(expectedLine(), 'utf8'));
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(r.out).not.toContain(ACCOUNT);
    expect(r.out).not.toContain('fake-model-638');
    expect(readdirSync(dir).sort()).toEqual(['ledger.jsonl', 'row.json']);
  });

  it('appends one canonical row after the untouched old bytes, read back through readSpendLedger', async () => {
    const { file, rowFile } = setup(OLD, rowText({ extra: 'dropped-unknown-key' }));
    const r = await run(['--file', file, '--row-file', rowFile, '--apply', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'applied', appended: true, bytes: Buffer.byteLength(expectedLine(), 'utf8') });
    expect(r.out).not.toContain(ACCOUNT);
    expect(r.out).not.toContain('fake-model-638');
    const after = readFileSync(file, 'utf8');
    expect(after).toBe(OLD + expectedLine());
    expect(after).not.toContain('dropped-unknown-key');
    const read = readSpendLedger(file);
    expect(read.validRows).toBe(2);
    expect(read.invalidRows).toBe(0);
    expect(read.rows[0]).toMatchObject({ quota: 3, cost: 1.5 });
    expect(read.rows[1]).toMatchObject({ model: 'fake-model-638', accountId: ACCOUNT, quota: null, cost: null, merged: true });
  });

  it('keeps earlier rows across repeated applies and parses pretty-printed row files', async () => {
    const { file, rowFile } = setup(OLD, JSON.stringify(JSON.parse(rowText()), null, 2));
    await run(['--file', file, '--row-file', rowFile, '--apply']);
    await run(['--file', file, '--row-file', rowFile, '--apply']);
    const read = readSpendLedger(file);
    expect(read.validRows).toBe(3);
    expect(read.rows.map((row) => row.ts)).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
    expect(readFileSync(file, 'utf8').startsWith(OLD)).toBe(true);
  });

  it('refuses invalid or oversized rows with no write and no new file', async () => {
    const { dir, file } = setup(OLD, null);
    const bad: Array<string | null> = [
      'not json SECRET-RAW-ROW',
      rowText({ billing: 'free' }),
      rowText({ repo: 'example-org/example-repo' }),
      rowText({ escalations: -1 }),
      rowText({ model: 'a'.repeat(SPEND_ROW_MAX_BYTES) }),
      JSON.stringify({ ...base, quota: undefined }),
      rowText() + '\n' + rowText(),
    ];
    for (const text of bad) {
      writeFileSync(join(dir, 'row.json'), text as string);
      for (const extra of [[], ['--apply']]) {
        const r = await run(['--file', file, '--row-file', join(dir, 'row.json'), ...extra]);
        expect(r.code).toBe(2);
        expect(r.err).not.toContain('SECRET-RAW-ROW');
        expect(r.err).not.toContain(ACCOUNT);
      }
    }
    expect(readFileSync(file, 'utf8')).toBe(OLD);
    expect(readdirSync(dir).sort()).toEqual(['ledger.jsonl', 'row.json']);
  });

  it('refuses a missing target without creating it or its parent directory', async () => {
    const { dir, rowFile } = setup(null);
    const missing = join(dir, 'nope', 'ledger.jsonl');
    for (const extra of [[], ['--apply']]) {
      const r = await run(['--file', missing, '--row-file', rowFile, '--json', ...extra]);
      expect(r.code).toBe(2);
      expect(JSON.parse(r.out).status).toBe('refused');
    }
    expect(existsSync(join(dir, 'nope'))).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses symlink, directory and unterminated targets without mutation', async () => {
    const { dir, file, rowFile } = setup(OLD);
    const link = join(dir, 'link.jsonl');
    symlinkSync(file, link);
    const linked = await run(['--file', link, '--row-file', rowFile, '--apply']);
    expect(linked.code).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(OLD);

    const asDir = await run(['--file', dir, '--row-file', rowFile, '--apply']);
    expect(asDir.code).toBe(2);

    const unterminated = join(dir, 'unterminated.jsonl');
    writeFileSync(unterminated, OLD.trimEnd());
    expect((await run(['--file', unterminated, '--row-file', rowFile])).code).toBe(2);
    expect((await run(['--file', unterminated, '--row-file', rowFile, '--apply'])).code).toBe(2);
    expect(readFileSync(unterminated, 'utf8')).toBe(OLD.trimEnd());
  });

  it('refuses a target that would pass the reader byte ceiling', async () => {
    const { dir, rowFile } = setup(null);
    const full = join(dir, 'full.jsonl');
    writeFileSync(full, '\n'.repeat(SPEND_LEDGER_MAX_BYTES));
    const r = await run(['--file', full, '--row-file', rowFile, '--apply']);
    expect(r.code).toBe(2);
    expect(statSync(full).size).toBe(SPEND_LEDGER_MAX_BYTES);
  });

  it('refuses relative paths, unknown flags and symlinked or non-regular row files', async () => {
    const { dir, file, rowFile } = setup();
    for (const args of [
      ['--file', 'relative.jsonl', '--row-file', rowFile, '--apply'],
      ['--file', file, '--row-file', 'row.json', '--apply'],
      ['--file', file, '--row-file', rowFile, '--bogus'],
      ['--file', file],
    ]) {
      const r = await run(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('Usage: phm fleet spend-record');
    }
    const rowLink = join(dir, 'row-link.json');
    symlinkSync(rowFile, rowLink);
    expect((await run(['--file', file, '--row-file', rowLink, '--apply'])).code).toBe(2);
    const rowDir = join(dir, 'rowdir');
    mkdirSync(rowDir);
    expect((await run(['--file', file, '--row-file', rowDir, '--apply'])).code).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(OLD);
  });

  it('prints help and exits 0 without acting', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--row-file <absolute-json-file-path>');
    expect(r.out).toContain('--apply');
  });

  it('exposes the same append used by the reader, which tolerates the appended line', () => {
    const { file } = setup(OLD);
    const parsed = parseSpendDecision(rowText());
    expect(parsed).not.toBeNull();
    appendSpendDecision(file, parsed!);
    expect(readSpendLedger(file).validRows).toBe(2);
  });
});
