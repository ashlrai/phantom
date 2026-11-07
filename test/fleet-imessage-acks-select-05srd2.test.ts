import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetImessageAcks } from '../src/cli/fleet-imessage-acks.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ack-select-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'imessage'));
  return { dir, file: join(dir, 'imessage', 'acks.jsonl') };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const row = (rowid: number, status = 'accepted') => JSON.stringify({ at: '2026-01-02T03:04:05.000Z', rowid, status, delivery: 'recorded-not-sent' });
async function run(dir: string, args: string[]) {
  const out: string[] = []; const errors: string[] = [];
  const code = await cmdFleetImessageAcks(args, { runsDir: dir, output: s => out.push(s), error: s => errors.push(s) });
  return { code, out: out.join('\n'), errors: errors.join('\n') };
}

describe('iMessage acknowledgement row selection', () => {
  it('selects accepted and duplicate rows before applying the limit', async () => {
    const { dir, file } = fixture();
    writeFileSync(file, `${row(7)}\n${row(7, 'duplicate')}\n${row(8)}\n${row(9)}\n`);
    const report = JSON.parse((await run(dir, ['--rowid', '7', '--limit', '2', '--json'])).out);
    expect(report).toMatchObject({ rowid: 7, match: 'matched', sourceState: 'ok', malformedRows: 0, deliveryProof: false,
      rows: [{ rowid: 7, status: 'accepted', delivery: 'recorded-not-sent' }, { rowid: 7, status: 'duplicate', delivery: 'recorded-not-sent' }] });
    const human = await run(dir, ['--rowid', '7']);
    expect(human.out).toContain('Matching acknowledgement recorded');
    expect(human.out).toContain('Delivery proof: false');
  });
  it('reports a bounded no-match and counts malformed and torn rows independently of selection', async () => {
    const { dir, file } = fixture();
    writeFileSync(file, `${row(8)}\ninvalid\n{"at":`);
    const report = JSON.parse((await run(dir, ['--rowid', '7', '--json'])).out);
    expect(report).toMatchObject({ rowid: 7, match: 'no-match', sourceState: 'ok', malformedRows: 2, rows: [], deliveryProof: false });
    expect((await run(dir, ['--rowid', '7'])).out).toContain('ingestion may have occurred outside it');
  });
  it('distinguishes absent and unreadable sources from no-match', async () => {
    const { dir, file } = fixture();
    for (const state of ['missing', 'unreadable']) {
      if (state === 'unreadable') symlinkSync('elsewhere', file);
      const result = await run(dir, ['--rowid', '7', '--json']);
      expect(JSON.parse(result.out)).toMatchObject({ rowid: 7, match: 'unknown', sourceState: state, malformedRows: 0, deliveryProof: false });
      const human = (await run(dir, ['--rowid', '7'])).out;
      expect(human).toContain(`source is ${state}`);
      expect(human).not.toContain('No matching acknowledgement');
    }
  });
  it('rejects invalid, missing and repeated options', async () => {
    const { dir } = fixture();
    for (const args of [['--rowid'], ['--rowid', '0'], ['--rowid', '-1'], ['--rowid', '1.0'], ['--rowid', '01'], ['--rowid', '9007199254740992'], ['--rowid', '1', '--rowid', '2'], ['--rowid', '1', '--wat'], ['--limit', '1', '--limit', '2'], ['--json', '--json']]) {
      const result = await run(dir, args);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.errors).toContain('Usage:');
    }
    writeFileSync(join(dir, 'imessage', 'acks.jsonl'), `${row(Number.MAX_SAFE_INTEGER)}\n`);
    expect(JSON.parse((await run(dir, ['--rowid', String(Number.MAX_SAFE_INTEGER), '--json'])).out).match).toBe('matched');
  });
  it('preserves the unfiltered JSON and human output', async () => {
    const { dir, file } = fixture();
    writeFileSync(file, `${row(1)}\n${row(2, 'duplicate')}\n`);
    expect(JSON.parse((await run(dir, ['--limit', '1', '--json'])).out)).toEqual({ sourceState: 'ok', rows: [{ timestamp: '2026-01-02T03:04:05.000Z', rowid: 2, status: 'duplicate', delivery: 'recorded-not-sent' }], malformedRows: 0, deliveryProof: false });
    expect((await run(dir, ['--limit', '1'])).out).toBe('iMessage acknowledgement source: ok; malformed rows: 0\n2026-01-02T03:04:05.000Z rowid 2 duplicate recorded-not-sent\nRecorded-not-sent does not establish delivery. Delivery proof: false.');
  });
});
