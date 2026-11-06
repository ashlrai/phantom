import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetImessageAcks } from '../src/cli/fleet-imessage-acks.js';

const dirs: string[] = [];
function fixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ack-test-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'imessage'));
  return { dir, file: join(dir, 'imessage', 'acks.jsonl') };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const row = (rowid: number, extra: object = {}) => JSON.stringify({ at: '2026-01-02T03:04:05.000Z', rowid, status: 'accepted', delivery: 'recorded-not-sent', ...extra });
async function run(dir: string, args: string[]) {
  const out: string[] = []; const errors: string[] = [];
  const code = await cmdFleetImessageAcks(args, { runsDir: dir, output: s => out.push(s), error: s => errors.push(s) });
  return { code, out: out.join('\n'), errors: errors.join('\n') };
}

describe('fleet imessage-acks', () => {
  it('projects and redacts records in both formats, and does not claim delivery', async () => {
    const { dir, file } = fixture();
    writeFileSync(file, `${row(1, { text: 'FAKE_PRIVATE_TEXT', receipt: 'FAKE_RECEIPT', extra: 'FAKE_EXTRA' })}\n${row(2, { status: 'duplicate', delivery: 'FAKE_PRIVATE_DELIVERY' })}\n`);
    for (const args of [['--json'], []]) {
      const result = await run(dir, args);
      expect(result.code).toBe(0);
      expect(result.out).not.toMatch(/FAKE_|receipt|extra/);
      expect(result.out).toContain('unknown');
      if (args.length) {
        expect(JSON.parse(result.out)).toMatchObject({ sourceState: 'ok', deliveryProof: false, malformedRows: 0, rows: [{ rowid: 1, delivery: 'recorded-not-sent' }, { rowid: 2, delivery: 'unknown' }] });
      } else expect(result.out).toContain('does not establish delivery');
    }
  });
  it('limits rows, bounds the tail, and counts malformed and torn records', async () => {
    const { dir, file } = fixture();
    writeFileSync(file, `${'x'.repeat(300000)}\n${Array.from({ length: 25 }, (_, i) => row(i + 1)).join('\n')}\nnot-json\n{"at":`);
    const result = JSON.parse((await run(dir, ['--limit', '2', '--json'])).out);
    expect(result.rows.map((r: { rowid: number }) => r.rowid)).toEqual([24, 25]);
    expect(result.malformedRows).toBe(2);
  });
  it('distinguishes missing, empty, and unreadable sources', async () => {
    const { dir, file } = fixture();
    expect(JSON.parse((await run(dir, ['--json'])).out).sourceState).toBe('missing');
    writeFileSync(file, '');
    expect(JSON.parse((await run(dir, ['--json'])).out)).toMatchObject({ sourceState: 'ok', rows: [], malformedRows: 0 });
    rmSync(file); mkdirSync(file);
    expect(JSON.parse((await run(dir, ['--json'])).out).sourceState).toBe('unreadable');
  });
  it('rejects invalid flags before filesystem reads', async () => {
    const { dir } = fixture();
    for (const args of [['--limit', '0'], ['--limit', '101'], ['--limit', '1.5'], ['--limit'], ['--json', '--json'], ['--wat'], ['--limit', '1', '--limit', '2']]) {
      const result = await run(dir, args);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.errors).toBe('Usage: phm fleet imessage-acks [--limit N] [--json]');
    }
  });
});
