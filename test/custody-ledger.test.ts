import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_LEDGER_MAX_BYTES,
  CUSTODY_LEDGER_MAX_READ_BYTES,
  appendCustodyRecord,
  custodyLedgerPath,
  readCustodySummary,
} from '../src/core/run/custody-ledger.js';
import { decidePhantomCustody } from '../src/core/run/phantom-custody.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-custody-ledger-')); process.env.HOME = tmpHome; });
afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); process.env.HOME = origHome; });

const base = { enabled: true, installed: true, initialized: true, linkedWorktree: false, engineBin: '/usr/local/bin/aider' };

describe('custody ledger', () => {
  it('appends one value-free line per record and summarizes by reason', () => {
    appendCustodyRecord(decidePhantomCustody(base));
    appendCustodyRecord(decidePhantomCustody({ ...base, linkedWorktree: true }));
    appendCustodyRecord(decidePhantomCustody({ ...base, linkedWorktree: true }));
    appendCustodyRecord(decidePhantomCustody({ ...base, preflight: { mayWrap: false, reason: 'preflight-blocked' }, preflightExit: 1 }));
    const text = fs.readFileSync(custodyLedgerPath(), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(4);
    expect(text).not.toContain(tmpHome);
    expect(text).not.toContain('/usr/local/bin');
    expect(readCustodySummary(null)).toEqual({ spawns: 4, wrapped: 1, unwrapped: { 'worktree-namespace': 2, 'preflight-blocked': 1 }, malformed: 0 });
    if (process.platform !== 'win32') expect(fs.statSync(custodyLedgerPath()).mode & 0o777).toBe(0o600);
  });

  it('a line carries only fixed keys, never a secret-like value from the environment', () => {
    const fake = `sk-test-${randomBytes(12).toString('hex')}`;
    process.env['FAKE_PROVIDER_KEY'] = fake;
    try {
      appendCustodyRecord(decidePhantomCustody({ ...base, linkedWorktree: true }));
      const line = JSON.parse(fs.readFileSync(custodyLedgerPath(), 'utf8').trim()) as Record<string, unknown>;
      expect(Object.keys(line).sort()).toEqual(['at', 'engine', 'preflight_exit', 'reason', 'schema', 'wrapped']);
      expect(JSON.stringify(line)).not.toContain(fake);
    } finally {
      delete process.env['FAKE_PROVIDER_KEY'];
    }
  });

  it('filters by time, counts malformed lines and maps unknown reasons to unknown', () => {
    const text = [
      JSON.stringify({ schema: 1, at: '2026-10-25T01:00:00Z', wrapped: true, engine: 'a', preflight_exit: null }),
      JSON.stringify({ schema: 1, at: '2026-10-25T03:00:00Z', wrapped: false, reason: 'made-up', engine: 'a', preflight_exit: null }),
      '{not json',
      JSON.stringify({ schema: 2, at: '2026-10-25T03:00:00Z', wrapped: true }),
    ].join('\n');
    expect(readCustodySummary(new Date('2026-10-25T02:00:00Z'), text)).toEqual({ spawns: 1, wrapped: 0, unwrapped: { unknown: 1 }, malformed: 2 });
  });

  it('missing file is all zeros; rotation past the cap keeps writing', () => {
    expect(readCustodySummary(null)).toEqual({ spawns: 0, wrapped: 0, unwrapped: {}, malformed: 0 });
    fs.mkdirSync(path.dirname(custodyLedgerPath()), { recursive: true });
    fs.writeFileSync(custodyLedgerPath(), 'x'.repeat(CUSTODY_LEDGER_MAX_BYTES));
    appendCustodyRecord(decidePhantomCustody(base));
    expect(fs.existsSync(`${custodyLedgerPath()}.1`)).toBe(true);
    expect(readCustodySummary(null).spawns).toBe(1);
  });

  it('never throws when HOME is unwritable', () => {
    process.env.HOME = path.join(tmpHome, 'missing', '\0bad');
    expect(() => appendCustodyRecord(decidePhantomCustody(base))).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('does not write through a symlinked ledger file', () => {
    const target = path.join(tmpHome, 'elsewhere.txt');
    fs.writeFileSync(target, 'keep\n');
    fs.mkdirSync(path.dirname(custodyLedgerPath()), { recursive: true });
    fs.symlinkSync(target, custodyLedgerPath());
    appendCustodyRecord(decidePhantomCustody(base));
    expect(fs.readFileSync(target, 'utf8')).toBe('keep\n');
    expect(readCustodySummary(null)).toEqual({ spawns: 0, wrapped: 0, unwrapped: {}, malformed: 1 });
  });

  it.skipIf(process.platform === 'win32')('does not write into a symlinked custody directory', () => {
    const elsewhere = path.join(tmpHome, 'other-dir');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true });
    fs.symlinkSync(elsewhere, path.dirname(custodyLedgerPath()));
    appendCustodyRecord(decidePhantomCustody(base));
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a directory in place of the ledger file and an oversized ledger', () => {
    fs.mkdirSync(custodyLedgerPath(), { recursive: true });
    expect(() => appendCustodyRecord(decidePhantomCustody(base))).not.toThrow();
    expect(readCustodySummary(null).malformed).toBe(1);
    fs.rmSync(custodyLedgerPath(), { recursive: true });
    fs.writeFileSync(custodyLedgerPath(), 'x'.repeat(CUSTODY_LEDGER_MAX_READ_BYTES + 1));
    expect(readCustodySummary(null)).toEqual({ spawns: 0, wrapped: 0, unwrapped: {}, malformed: 1 });
  });

  it('re-validates fields at write time', () => {
    appendCustodyRecord({ wrapped: true, engine: '../../etc/x y', preflight_schema: 1, preflight_exit: 1.5 } as never);
    appendCustodyRecord({ wrapped: false, reason: 'made-up' as never, engine: 'aider', preflight_exit: 999 } as never);
    const lines = fs.readFileSync(custodyLedgerPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ wrapped: true, engine: 'unknown', preflight_exit: null });
    expect(lines[1]).toMatchObject({ wrapped: false, reason: 'unknown', engine: 'aider', preflight_exit: null });
  });

  it.skipIf(process.platform === 'win32')('creates the ledger owner-only', () => {
    appendCustodyRecord(decidePhantomCustody(base));
    expect(fs.statSync(custodyLedgerPath()).mode & 0o777).toBe(0o600);
  });
});
