/** RQ-PHX-COORDBOARDUNSAFETEST324 — readFleetBoard() reports state 'unknown'
 * for unsafe ledger conditions (missing file, loose permissions, symlink,
 * torn tail) and 'known' for a valid or fully-expired ledger. */
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coord-board-unsafe-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const claim = (path: string) =>
  claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' }, { path });

describe('readFleetBoard unsafe ledger states', () => {
  it('reports unknown for a missing ledger file', () => {
    const result = readFleetBoard({ path: join(dir, 'missing.jsonl') });
    expect(result.state).toBe('unknown');
    expect(result.claims).toEqual([]);
    expect(result.expiredClaims).toBeNull();
  });

  it('reports known with one claim and no leaseHash for a valid ledger', () => {
    const path = join(dir, 'valid.jsonl');
    expect(claim(path).ok).toBe(true);
    const result = readFleetBoard({ path });
    expect(result.state).toBe('known');
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).not.toHaveProperty('leaseHash');
  });

  it('reports unknown when the ledger permissions are too loose', () => {
    const path = join(dir, 'chmod-test.jsonl');
    expect(claim(path).ok).toBe(true);
    chmodSync(path, 0o644);
    const result = readFleetBoard({ path });
    expect(result.state).toBe('unknown');
    expect(result.claims).toEqual([]);
  });

  it('reports unknown for a symlink to a valid ledger', () => {
    const realPath = join(dir, 'real.jsonl');
    const linkPath = join(dir, 'symlink.jsonl');
    expect(claim(realPath).ok).toBe(true);
    symlinkSync(realPath, linkPath);
    expect(readFleetBoard({ path: linkPath }).state).toBe('unknown');
  });

  it('reports unknown for a torn ledger whose last line lacks a newline', () => {
    const path = join(dir, 'torn.jsonl');
    expect(claim(path).ok).toBe(true);
    const fd = openSync(path, 'a');
    writeSync(fd, '{"version":1,"kind":"release","at":123456789,"id":"test-id"}');
    closeSync(fd);
    expect(readFleetBoard({ path }).state).toBe('unknown');
  });

  it('reports known with zero live claims and one expired claim past expiry', () => {
    const path = join(dir, 'expired.jsonl');
    expect(claim(path).ok).toBe(true);
    const result = readFleetBoard({ path, now: Date.now() + 30 * 24 * 60 * 60_000 });
    expect(result.state).toBe('known');
    expect(result.claims).toHaveLength(0);
    expect(result.expiredClaims).toBe(1);
  });
});
