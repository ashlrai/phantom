import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_LEDGER_MAX_BYTES,
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
});
