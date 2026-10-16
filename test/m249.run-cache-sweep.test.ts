/**
 * RunCache store bounds + crash safety.
 *
 * Verifies:
 *   1. write() self-bounds: expired / reject>ship entries are evicted once the
 *      file passes the entry trigger, and fresh entries still hit.
 *   2. LRU: past the entry cap, least-recently-hit entries are evicted.
 *   3. Byte budget: large patches cannot grow the file without limit.
 *   4. Rewrites go through a private temporary + rename (no leftovers, 0600),
 *      and a leftover crash temporary never breaks reads; sweep reaps stale ones.
 *
 * Hermetic: temp HOME, no network, no engine.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  lookup,
  write,
  recordOutcome,
  sweep,
  _clearIndexCache,
  type CacheEntry,
} from '../src/core/fabric/cache/store.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = { foundry: { fabric: { cacheShadow: true } } } as unknown as AshlrConfig;
const REPO = '/repo/bounded';
const DAY = 24 * 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function entry(key: string, over: Partial<CacheEntry> = {}): CacheEntry {
  const now = iso(0);
  return {
    key,
    patch: `+${key}\n`,
    provenanceSig: 'sig',
    engineModel: 'claude:test',
    tier: 'frontier',
    diffHash: `dh-${key}`,
    repoTreeSha: 'tree',
    verdictAtWrite: 'unknown',
    shipOutcomes: { ship: 0, reject: 0 },
    createdAt: now,
    lastHit: now,
    hits: 0,
    schemaVersion: 1,
    ...over,
  };
}

function cacheDir(home: string): string {
  return join(home, '.ashlr', 'fabric', 'cache');
}

function jsonlPath(home: string, repo = REPO): string {
  const h = createHash('sha256').update(repo).digest('hex').slice(0, 16);
  return join(cacheDir(home), `${h}.jsonl`);
}

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).length;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('run-cache store — self-bounding sweep and crash-safe rewrites', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    _clearIndexCache();
    home = mkdtempSync(join(tmpdir(), 'ashlr-cache-sweep-'));
    tmpDirs.push(home);
    origHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    _clearIndexCache();
  });

  it('evicts expired and rejected entries once past the cap; fresh entries still hit', () => {
    const old = iso(30 * DAY);
    for (let i = 0; i < 1500; i++) {
      write(cfg, entry(`old${i}`, { createdAt: old, lastHit: old }), REPO);
      write(cfg, entry(`rej${i}`, { shipOutcomes: { ship: 0, reject: 1 } }), REPO);
    }
    for (let i = 0; i < 10; i++) write(cfg, entry(`fresh${i}`), REPO);

    const path = jsonlPath(home);
    // Never more than the trigger (cap * 1.25) lines on disk.
    expect(lineCount(path)).toBeLessThanOrEqual(2500);

    sweep(cfg);
    expect(lineCount(path)).toBe(10);
    _clearIndexCache();
    for (let i = 0; i < 10; i++) expect(lookup(cfg, `fresh${i}`, REPO)?.key).toBe(`fresh${i}`);
    expect(lookup(cfg, 'old0', REPO)).toBeNull();
    expect(lookup(cfg, 'rej0', REPO)).toBeNull();
  });

  it('LRU-evicts least-recently-hit entries beyond the entry cap', () => {
    const n = 2600;
    for (let i = 0; i < n; i++) {
      // Higher i → more recent lastHit.
      write(cfg, entry(`k${i}`, { lastHit: iso((n - i) * 1000) }), REPO);
    }
    const path = jsonlPath(home);
    expect(lineCount(path)).toBeLessThanOrEqual(2500);

    const { removed } = sweep(cfg);
    expect(removed).toBeGreaterThan(0);
    expect(lineCount(path)).toBe(2000);
    _clearIndexCache();
    expect(lookup(cfg, `k${n - 1}`, REPO)).not.toBeNull();
    expect(lookup(cfg, `k${n - 2000}`, REPO)).not.toBeNull();
    expect(lookup(cfg, `k${n - 2001}`, REPO)).toBeNull();
    expect(lookup(cfg, 'k0', REPO)).toBeNull();
  });

  it('bounds file size under large patches (byte budget)', () => {
    const patch = 'x'.repeat(400 * 1024);
    for (let i = 0; i < 120; i++) {
      write(cfg, entry(`big${i}`, { patch, lastHit: iso((120 - i) * 1000) }), REPO);
    }
    const path = jsonlPath(home);
    // 120 * 400 KiB ≈ 48 MiB written; trigger is 40 MiB.
    expect(statSync(path).size).toBeLessThanOrEqual(40 * 1024 * 1024);
    // Most recent write survives the in-write sweep and is served from the index.
    expect(lookup(cfg, 'big119', REPO)?.patch.length).toBe(patch.length);
    _clearIndexCache();
    expect(lookup(cfg, 'big119', REPO)).not.toBeNull();
  });

  it('collapses duplicate keys so repeated writes of one key stay bounded', () => {
    for (let i = 0; i < 2600; i++) write(cfg, entry('same', { hits: i }), REPO);
    const path = jsonlPath(home);
    expect(lineCount(path)).toBeLessThanOrEqual(2500);
    _clearIndexCache();
    expect(lookup(cfg, 'same', REPO)?.hits).toBe(2599);
  });

  it('rewrites atomically: private mode, no leftover temporaries', () => {
    write(cfg, entry('a'), REPO);
    write(cfg, entry('b', { diffHash: 'dh-b' }), REPO);
    recordOutcome(cfg, 'dh-b', 'reject', REPO);
    const path = jsonlPath(home);
    expect(readdirSync(cacheDir(home)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(sweep(cfg).removed).toBe(1);
    expect(readdirSync(cacheDir(home)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    _clearIndexCache();
    expect(lookup(cfg, 'a', REPO)).not.toBeNull();
    expect(lookup(cfg, 'b', REPO)).toBeNull();
  });

  it('a leftover crash temporary does not break reads; sweep reaps only stale ones', () => {
    write(cfg, entry('keep'), REPO);
    const path = jsonlPath(home);
    const dir = cacheDir(home);
    mkdirSync(dir, { recursive: true });
    const base = path.slice(dir.length + 1);
    const stale = join(dir, `.${base}.0123456789abcdef.tmp`);
    const fresh = join(dir, `.${base}.fedcba9876543210.tmp`);
    writeFileSync(stale, '{"key":"torn","schemaVer', { mode: 0o600 });
    writeFileSync(fresh, '{"key":"partial', { mode: 0o600 });
    const past = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(stale, past, past);

    _clearIndexCache();
    expect(lookup(cfg, 'keep', REPO)).not.toBeNull();
    write(cfg, entry('next'), REPO);
    recordOutcome(cfg, 'dh-keep', 'ship', REPO);
    _clearIndexCache();
    expect(lookup(cfg, 'keep', REPO)?.shipOutcomes.ship).toBe(1);
    expect(lookup(cfg, 'next', REPO)).not.toBeNull();

    sweep(cfg);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    _clearIndexCache();
    expect(lookup(cfg, 'keep', REPO)).not.toBeNull();
  });
});
