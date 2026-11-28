import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldInstallRows,
  installsBacklogItems,
  parseInstallsJournal,
} from '../src/core/improve/installs-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-installs-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const REPO = 'ashlrai/phantom';

interface LineOpts { integrity?: string; attestation?: string; rolledBack?: boolean }
/** One installs.log line in the writer's fixed shape. */
const line = (from: string, to: string, outcome: string, opts: LineOpts = {}): string =>
  `Phantom ${from} to ${to}: ${outcome}; integrity: ${opts.integrity ?? (outcome === 'updated' ? 'verified' : 'unknown')}; attestation: ${opts.attestation ?? 'unknown'}; rolled back: ${opts.rolledBack === true ? 'true' : 'false'}`;

const healthy = (from = '3.30.9', to = '3.30.9'): string => line(from, to, 'up to date');
const updated = (from: string, to: string): string => line(from, to, 'updated', { integrity: 'verified' });
const err = (from: string, to: string, error: string, opts: LineOpts = {}): string =>
  line(from, to, error, { integrity: opts.integrity ?? 'unknown', attestation: opts.attestation, rolledBack: opts.rolledBack });

const writeJournal = (lines: string[] | string): string => {
  const dir = path.join(home, '.ashlr-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'installs.log');
  fs.writeFileSync(file, typeof lines === 'string' ? lines : lines.join('\n') + '\n');
  return file;
};

/** Six 'Registry unreachable' failures with healthy cycles between first and last. */
const recurringErrors = (error = 'Registry unreachable'): string[] => [
  err('3.30.7', '3.30.8', error),
  err('3.30.7', '3.30.8', error),
  healthy('3.30.7', '3.30.7'),
  err('3.30.8', '3.30.9', error),
  err('3.30.8', '3.30.9', error),
  updated('3.30.8', '3.30.9'),
  err('3.30.9', '3.30.10', error),
  err('3.30.9', '3.30.10', error),
];

/** Twelve contiguous 'Service kickstart failed' rollbacks — the sustained bar. */
const sustainedRollbacks = (): string[] =>
  Array.from({ length: 12 }, () => err('3.30.9', '3.30.10', 'Service kickstart failed',
    { integrity: 'verified', rolledBack: true }));

describe('parseInstallsJournal', () => {
  it('parses the writer shape and skips malformed or off-contract lines', () => {
    const rows = parseInstallsJournal([
      'not a journal line',
      '',
      line('3.30.9', '3.30.9', 'up to date'),
      line('3.30.9', '3.30.10', 'updated', { integrity: 'verified', attestation: 'verified' }),
      line('3.30.9', '3.30.10', 'Registry unreachable'),
      line('3.30.9', '3.30.10', 'Service kickstart failed', { integrity: 'verified', rolledBack: true }),
      // off-contract rows the writer can never produce:
      line('3.30.9', '3.30.9', 'up to date', { integrity: 'verified' }),
      line('3.30.9', '3.30.10', 'up to date'), // 'up to date' requires from === to
      line('3.30.9', '3.30.10', 'updated', { integrity: 'unknown' }),
      line('3.30.9', '3.30.10', 'updated', { integrity: 'verified', rolledBack: true }),
      line('3.30.9', '3.30.10', 'Service kickstart failed', { rolledBack: true }), // rollback before the integrity gate
      line('3.30.9', '3.30.9', 'Registry unreachable'), // equal semver versions never reach an error path
      line('bogus', '3.30.10', 'Registry unreachable'),
      line('3.30.9', '3.30.10', ''),
      line('3.30.9', '3.30.10', 'x'.repeat(300)),
    ].join('\n'));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ outcome: 'up-to-date', from: '3.30.9', to: '3.30.9', line: 2 });
    expect(rows[1]).toMatchObject({ outcome: 'updated', integrity: 'verified', attestation: 'verified' });
    expect(rows[2]).toMatchObject({ outcome: 'error', error: 'Registry unreachable', slug: 'registry-unreachable', rolledBack: false });
    expect(rows[3]).toMatchObject({ outcome: 'error', slug: 'service-kickstart-failed', rolledBack: true, integrity: 'verified' });
    // ordinals count every non-empty line, malformed included
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4, 5]);
  });

  it('accepts unknown versions and slugifies error text', () => {
    const rows = parseInstallsJournal([
      line('unknown', 'unknown', 'Unsupported release directory'),
      line('3.30.9', 'unknown', 'Release update failed'),
    ].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.slug).toBe('unsupported-release-directory');
    expect(rows[1]!.slug).toBe('release-update-failed');
  });
});

describe('foldInstallRows', () => {
  it('classifies healthy rows as context and folds errors per slug', () => {
    const fold = foldInstallRows(parseInstallsJournal(recurringErrors().join('\n')));
    expect(fold.total).toBe(8);
    expect(fold.healthy).toBe(2);
    expect(fold.errorRows).toBe(6);
    expect(fold.rolledBackRows).toBe(0);
    const cell = fold.errors.get('registry-unreachable')!;
    expect(cell.rows).toBe(6);
    expect(cell.healthyBetween).toBe(2);
    expect(cell.pairs.map((p) => p.pair)).toEqual(['3.30.7→3.30.8', '3.30.8→3.30.9', '3.30.9→3.30.10']);
    expect(fold.rolledBack.rows).toBe(0);
  });

  it('aggregates rolled-back rows across error classes', () => {
    const fold = foldInstallRows(parseInstallsJournal([
      ...sustainedRollbacks(),
      err('3.30.9', '3.30.10', 'CLI link changed', { integrity: 'verified', rolledBack: true }),
      err('3.30.9', '3.30.10', 'Registry unreachable'),
    ].join('\n')));
    expect(fold.rolledBackRows).toBe(13);
    expect(fold.rolledBack.rows).toBe(13);
    expect(fold.rolledBack.errors[0]).toEqual({ slug: 'service-kickstart-failed', count: 12 });
    expect(fold.rolledBack.errors[1]).toEqual({ slug: 'cli-link-changed', count: 1 });
    expect(fold.errors.get('service-kickstart-failed')!.rolledBack).toBe(12);
    expect(fold.errors.get('registry-unreachable')!.rolledBack).toBe(0);
  });
});

describe('installsBacklogItems', () => {
  it('turns a recurring error class into a valid priority-3 backlog item', async () => {
    const items = await installsBacklogItems({ repo: REPO, journalPath: writeJournal(recurringErrors()) });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^installs-update-error-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'self-update' });
    expect(item.title).toContain('Registry unreachable');
    expect(item.prompt).toContain("recorded 6 'Registry unreachable' failure(s)");
    expect(item.prompt).toContain('installs.log');
    expect(item.prompt).toContain('release-directory.ts');
    expect(item.prompt).toContain('no per-line timestamps');
    expect(item.prompt).toContain('non-contiguous');
    expect(item.prompt).toContain('3.30.9→3.30.10');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps a short contiguous burst silent and emits a sustained streak', async () => {
    const burst = Array.from({ length: 6 }, () => err('3.30.9', '3.30.10', 'Registry unreachable'));
    expect(await installsBacklogItems({ repo: REPO, journalPath: writeJournal(burst) })).toEqual([]);
    const streak = Array.from({ length: 12 }, () => err('3.30.9', '3.30.10', 'Registry unreachable'));
    const items = await installsBacklogItems({ repo: REPO, journalPath: writeJournal(streak) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('contiguous');
  });

  it('requires the minimum adverse rows even with separators', async () => {
    const few = [
      err('3.30.9', '3.30.10', 'Registry unreachable'),
      healthy(),
      err('3.30.9', '3.30.10', 'Registry unreachable'),
      healthy(),
      err('3.30.9', '3.30.10', 'Registry unreachable'),
    ];
    expect(await installsBacklogItems({ repo: REPO, journalPath: writeJournal(few) })).toEqual([]);
  });

  it('emits the rolled-back cell for recurring post-swap failures', async () => {
    const rows = [
      ...sustainedRollbacks(),
      healthy('3.30.10', '3.30.10'),
      err('3.30.9', '3.30.10', 'Service kickstart failed', { integrity: 'verified', rolledBack: true }),
      err('3.30.9', '3.30.10', 'Service kickstart failed', { integrity: 'verified', rolledBack: true }),
    ];
    const items = await installsBacklogItems({ repo: REPO, journalPath: writeJournal(rows) });
    // one update-error item for the class plus the aggregate rolled-back item
    expect(items).toHaveLength(2);
    const rb = items.find((i) => i.id.startsWith('installs-rolled-back-'))!;
    expect(rb).toBeDefined();
    expect(rb.prompt).toContain('14 rolled-back update(s)');
    expect(rb.prompt).toContain('service-kickstart-failed');
    expect(rb.prompt).toContain('post-swap window');
    const errItem = items.find((i) => i.id.startsWith('installs-update-error-'))!;
    expect(errItem.prompt).toContain("'rolled back: true'");
  });

  it('emits both cell kinds and orders by recorded rows', async () => {
    const rows = [
      ...recurringErrors('Registry unreachable'),   // 6 error rows
      // 8 integrity failures with healthy separators — the larger cell
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
      healthy(),
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
      healthy(),
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
      err('3.30.9', '3.30.10', 'Release integrity verification failed', { integrity: 'verified' }),
    ];
    const items = await installsBacklogItems({ repo: REPO, journalPath: writeJournal(rows) });
    expect(items).toHaveLength(2);
    // 8 integrity rows outrank 6 registry rows
    expect(items[0]!.prompt).toContain('Release integrity verification failed');
    expect(items[1]!.prompt).toContain('Registry unreachable');
    const again = await installsBacklogItems({ repo: REPO, journalPath: writeJournal(rows) });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('honours the item limit', async () => {
    const rows = [
      ...recurringErrors('Registry unreachable'),
      ...recurringErrors('Release integrity verification failed'),
    ];
    const items = await installsBacklogItems({ repo: REPO, journalPath: writeJournal(rows), limit: 1 });
    expect(items).toHaveLength(1);
  });

  it('stays quiet on healthy-only, missing and malformed journals', async () => {
    expect(await installsBacklogItems({
      repo: REPO,
      journalPath: writeJournal([healthy(), updated('3.30.9', '3.30.10'), healthy()]),
    })).toEqual([]);
    expect(await installsBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.log') })).toEqual([]);
    expect(await installsBacklogItems({
      repo: REPO,
      journalPath: writeJournal(['garbage', line('bad', 'versions', 'up to date'), healthy()]),
    })).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(recurringErrors());
    expect(await installsBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file })).toEqual([]);
    expect(await installsBacklogItems({ repo: '', journalPath: file })).toEqual([]);
    expect(await installsBacklogItems({ repo: 'not-a-repo', journalPath: file })).toEqual([]);
    const items = await installsBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(recurringErrors());
    const first = await installsBacklogItems({ repo: REPO, journalPath: file });
    const second = await installsBacklogItems({ repo: REPO, journalPath: file });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeJournal([...recurringErrors(), err('3.30.9', '3.30.10', 'Registry unreachable'), healthy(), err('3.30.9', '3.30.10', 'Registry unreachable')]);
    const third = await installsBacklogItems({ repo: REPO, journalPath: grown });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default journal path under the home .ashlr-runs dir', async () => {
    writeJournal(recurringErrors());
    const items = await installsBacklogItems({ repo: REPO });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^installs-update-error-/);
  });

  it('appends installs items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      writeJournal(recurringErrors());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const folded = first.items.filter((i) => i.id.startsWith('installs-'));
      expect(folded).toHaveLength(1);
      expect(folded[0]!.id).toMatch(/^installs-update-error-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(folded)).toBe(folded.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('installs-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('installs-'))).toHaveLength(folded.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
