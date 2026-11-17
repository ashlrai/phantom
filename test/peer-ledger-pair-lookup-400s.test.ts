import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPeerLedger } from '../src/cli/fleet-peer-ledger.js';
import { readPeerLedger, type PeerPairSelector } from '../src/core/agentnet/peer-ledger.js';

const NOW = 1_800_000_000_000;
const THREAD = 'fixture-private-thread-400s', DIGEST = 'a'.repeat(64);
let root: string, n = 0, out: string, err: string;

const row = (from: string, target: string, at: number) => ({
  id: `peer-123e4567-e89b-12d3-a456-426614${(n++).toString(16).padStart(6, '0')}`,
  fromAgent: from, target, origin: 'peer-123e4567-e89b-12d3-a456-426614174000',
  digest: DIGEST, hopCount: 1, threadId: THREAD, at });

function write(rows: unknown) {
  mkdirSync(join(root, 'agentnet'), { recursive: true });
  writeFileSync(join(root, 'agentnet', 'coordination.json'), typeof rows === 'string' ? rows : JSON.stringify(rows), { mode: 0o600 });
}
const file = () => join(root, 'agentnet', 'coordination.json');
const read = (pair?: PeerPairSelector) => readPeerLedger({ busRoot: root, now: () => NOW, pair });
const run = (args: string[] = ['--json']) => cmdFleetPeerLedger(args, { read });

/** 65 decoy pairs sorted before the target pair, each fully debited, plus the target pair. */
function ledgerRows() {
  const rows = [];
  for (let i = 0; i < 65; i++) {
    const from = `fx-a${String(i).padStart(2, '0')}`, to = `fx-b${String(i).padStart(2, '0')}`;
    for (let k = 0; k < 6; k++) rows.push(row(from, to, NOW - 1000 - k));
  }
  for (let k = 0; k < 6; k++) rows.push(row('fx-zz', 'fx-zy', NOW - 1000 - k));
  return rows;
}
const LOOKUP = ['--from-agent', 'fx-zz', '--target', 'fx-zy'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-pair-lookup-')); n = 0; out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out += String(s); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { err += String(s); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('exact pair lookup beyond the display cap', () => {
  it('returns a pair the unfiltered report truncates, with remaining and retryAt', async () => {
    write(ledgerRows());
    const before = readFileSync(file());
    expect(await run()).toBe(0);
    const all = JSON.parse(out);
    expect(all.pairs).toHaveLength(64);
    expect(all.truncated.pairs).toBe(true);
    expect(all.pairs.some((p: { fromAgent: string }) => p.fromAgent === 'fx-zz')).toBe(false);
    expect(all.selection).toBeUndefined();

    out = '';
    expect(await run([...LOOKUP, '--json'])).toBe(0);
    const hit = JSON.parse(out);
    expect(hit).toMatchObject({ status: 'ok', liveRows: 396, capacity: 1024, authority: 'none',
      selection: { fromAgent: 'fx-zz', target: 'fx-zy', match: 'exact' }, truncated: { pairs: true } });
    expect(hit.pairs).toHaveLength(1);
    expect(hit.pairs[0]).toMatchObject({ fromAgent: 'fx-zz', target: 'fx-zy', inWindow: 6, remaining: 0,
      lastAt: new Date(NOW - 1000).toISOString(),
      retryAt: new Date(NOW - 1005 + 60_000).toISOString() });
    const text = JSON.stringify(hit);
    expect(text).not.toContain(DIGEST);
    expect(text).not.toContain(THREAD);
    expect(readFileSync(file())).toEqual(before);
  });

  it('does not mix reversed direction or similar callsigns', async () => {
    write(ledgerRows());
    for (const args of [
      ['--from-agent', 'fx-zy', '--target', 'fx-zz'],
      ['--from-agent', 'fx-z', '--target', 'fx-zy'],
      ['--from-agent', 'fx-zz', '--target', 'fx-zy2'],
    ]) {
      out = '';
      expect(await run([...args, '--json'])).toBe(0);
      const r = JSON.parse(out);
      expect(r.selection).toMatchObject({ match: 'none' });
      expect(r.pairs).toEqual([]);
    }
  });

  it('reports no live evidence for an absent pair without fabricating a zero-use row', async () => {
    write(ledgerRows());
    out = '';
    expect(await run(['--from-agent', 'fx-zz', '--target', 'fx-none'])).toBe(0);
    expect(out).toContain('pair lookup: fx-zz -> fx-none (no live evidence)');
    expect(out).not.toContain('fx-zz -> fx-none  ');
    out = '';
    expect(await run([...LOOKUP])).toBe(0);
    expect(out).toContain('pair lookup: fx-zz -> fx-zy (matched)');
    expect(out).toContain('fx-zz -> fx-zy  6/6  remaining 0');
    expect(out).toContain('retry at:');
  });

  it('rejects malformed, one-sided, duplicate and unknown arguments with exit 2 and fixed usage', async () => {
    for (const args of [
      ['--from-agent'], ['--target'],
      ['--from-agent', 'fx-zz'], ['--target', 'fx-zy'],
      ['--from-agent', 'fx-zz', '--from-agent', 'fx-zz', '--target', 'fx-zy'],
      ['--from-agent', '--target', 'fx-zy'],
      ['--from-agent=fx-zz', '--target', 'fx-zy'],
      ['--bogus'],
    ]) {
      out = ''; err = '';
      expect(await run(args)).toBe(2);
      expect(out).toBe('');
      expect(err).toContain('Usage: ashlr fleet peer-ledger');
    }
  });

  it('rejects invalid selectors without echoing the unsafe input', async () => {
    for (const args of [
      ['--from-agent', 'Bad_Name', '--target', 'fx-zy'],
      ['--from-agent', 'fx-zz', '--target', 'bad target!'],
      ['--from-agent', 'fx-zz', '--target', 'fx-zy', 'extra'],
    ]) {
      out = ''; err = '';
      expect(await run(args)).toBe(2);
      expect(out).toBe('');
      expect(err).toContain('Usage: ashlr fleet peer-ledger');
    }
    expect(err).not.toContain('Bad_Name');
    expect(err).not.toContain('bad target!');
  });

  it('stays unavailable on a global future row even with a valid selector', async () => {
    write([...ledgerRows(), row('fx-aa', 'fx-ab', NOW + 5000)]);
    out = '';
    expect(await run([...LOOKUP, '--json'])).toBe(1);
    const r = JSON.parse(out);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'peer-clock-reversed',
      selection: { fromAgent: 'fx-zz', target: 'fx-zy', match: 'none' } });
    expect(r.pairs).toEqual([]);
  });

  it('never turns an unreadable ledger into an empty lookup and recovers on the next read', async () => {
    write('fixture-private-malformed-400s');
    out = '';
    expect(await run([...LOOKUP, '--json'])).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ status: 'unavailable', reason: 'peer-ledger-unreadable' });
    expect(out).not.toContain('fixture-private-malformed-400s');
    out = '';
    expect(await run([...LOOKUP])).toBe(1);
    expect(out).toContain('peer ledger: unavailable');
    expect(out).toContain('pair lookup: fx-zz -> fx-zy (unavailable)');
    expect(out).not.toContain('fixture-private-malformed-400s');

    write(ledgerRows());
    out = '';
    expect(await run([...LOOKUP, '--json'])).toBe(0);
    expect(JSON.parse(out).selection).toMatchObject({ match: 'exact' });
  });

  it('keeps missing-file and empty semantics for a selector', async () => {
    out = '';
    expect(await run([...LOOKUP, '--json'])).toBe(0);
    const r = JSON.parse(out);
    expect(r).toMatchObject({ status: 'empty', liveRows: 0, selection: { match: 'none' } });
    expect(r.pairs).toEqual([]);
  });
});
