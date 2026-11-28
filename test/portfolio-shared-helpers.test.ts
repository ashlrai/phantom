import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKLOG_SOURCE_FILTERS } from '../src/cli/backlog.js';
import * as backlogLintCli from '../src/cli/backlog-lint.js';
import * as backlogPlanCli from '../src/cli/backlog-plan.js';
import * as backlogCore from '../src/core/portfolio/backlog.js';
import {
  FLEET_REPOS,
  lintRestockDocument,
  lintRestockLine,
  RESTOCK_LINT_REASONS,
} from '../src/core/portfolio/restock-lint.js';
import { planRestock } from '../src/core/portfolio/restock-plan.js';
import * as rqBacklog from '../src/core/portfolio/rq-backlog.js';
import {
  isPlainRecord,
  isSha256Hex,
  isWorkSource,
  normalizePathSeparators,
  WORK_SOURCES,
} from '../src/core/portfolio/scoring.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('portfolio shared vocabulary, guards, snapshot-read, and CLI helpers', () => {
  it('shares the canonical WorkSource vocabulary and pure validation guards', () => {
    expect(BACKLOG_SOURCE_FILTERS).toBe(WORK_SOURCES);
    for (const source of WORK_SOURCES) {
      expect(isWorkSource(source)).toBe(true);
    }
    expect(isWorkSource('unknown')).toBe(false);
    expect(isWorkSource(null)).toBe(false);
    expect(isWorkSource(42)).toBe(false);

    expect(isPlainRecord({ ok: true })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(['a'])).toBe(false);
    expect(isPlainRecord('str')).toBe(false);

    const validHash = rqBacklog.rqDigest('portfolio');
    expect(isSha256Hex(validHash)).toBe(true);
    expect(isSha256Hex(validHash.toUpperCase())).toBe(false);
    expect(isSha256Hex(validHash.slice(0, 63))).toBe(false);
    expect(isSha256Hex('z'.repeat(64))).toBe(false);
    expect(isSha256Hex(123)).toBe(false);

    expect(normalizePathSeparators('C:\\repo\\src\\index.ts')).toBe('C:/repo/src/index.ts');
    expect(normalizePathSeparators('src/core/portfolio/scoring.ts')).toBe('src/core/portfolio/scoring.ts');
  });

  it('reads bounded UTF-8 snapshots through readBoundedRqSnapshot and rejects unsafe inputs', async () => {
    const dir = makeTempDir('portfolio-shared-snapshot-');

    const regular = join(dir, 'queue.md');
    writeFileSync(regular, '\uFEFFline-1\nline-2\n', 'utf8');
    const contents = await rqBacklog.readBoundedRqSnapshot(regular);
    expect(contents).toBe('\uFEFFline-1\nline-2\n');
    expect(contents.charCodeAt(0)).toBe(0xfeff);

    const invalidUtf8 = join(dir, 'invalid.bin');
    writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(rqBacklog.readBoundedRqSnapshot(invalidUtf8)).rejects.toThrow();

    const oversized = join(dir, 'oversized.md');
    writeFileSync(oversized, '');
    truncateSync(oversized, rqBacklog.RQ_MAX_FILE_BYTES + 1);
    await expect(rqBacklog.readBoundedRqSnapshot(oversized)).rejects.toThrow('Invalid snapshot file');

    const link = join(dir, 'queue-link.md');
    symlinkSync(regular, link);
    await expect(rqBacklog.readBoundedRqSnapshot(link)).rejects.toThrow();

    const nestedDir = join(dir, 'subdir');
    mkdirSync(nestedDir);
    await expect(rqBacklog.readBoundedRqSnapshot(nestedDir)).rejects.toThrow();
  });

  it('keeps RESTOCK_LINT_REASONS canonical and matches restock digest/landed behavior', async () => {
    expect(new Set(RESTOCK_LINT_REASONS).size).toBe(RESTOCK_LINT_REASONS.length);
    expect(RESTOCK_LINT_REASONS).toContain('unparseable');
    expect(RESTOCK_LINT_REASONS).toContain('unknown-pool');

    const line = '- READY RQ-SHARED-1 (P1, pool=devin, repo=phantom, after RQ-PRIOR-1): Update src/core/foo.ts; run npm test';
    const opts = { isDir: () => true, landed: new Set(['RQ-PRIOR-1']) };
    const single = lintRestockLine(line, 1, opts);
    const doc = lintRestockDocument(line, opts);
    expect(single).not.toBeNull();
    expect(single && 'candidate' in single ? single.candidate : null).toEqual(doc.accepted[0]);

    const badLine = '- READY RQ-BAD-1 (repo=phantom): Missing path and verify';
    const dropped = lintRestockLine(badLine, 1, { isDir: () => true });
    expect(dropped && 'drop' in dropped ? dropped.drop.sha : null).toBe(rqBacklog.rqDigest(badLine));

    const batchLines = Array.from({ length: 6 }, (_, i) =>
      `- READY RQ-PHANTOM-${i} (repo=${FLEET_REPOS[0]}, pool=devin, tier=work): Touch src/core/a${i}.ts; run npm test.`);
    const plan = await planRestock(batchLines.join('\n'), async () => ({ code: 0, reason: 'ready' }), { isDir: () => true });
    expect(plan.jobs).toHaveLength(1);
    const expectedPrefix = rqBacklog.rqDigest(JSON.stringify(batchLines)).slice(0, 12).toUpperCase();
    expect(plan.jobs[0]!.jobId).toBe(`RQ-RESTOCK-PHANTOM-${expectedPrefix}`);
  });

  it('prunes unused runtime exports from portfolio core and backlog CLI modules', () => {
    expect('BACKLOG_SCANNER_DEADLINE_MS' in backlogCore).toBe(false);
    expect('rqJobIsParked' in rqBacklog).toBe(false);
    expect('BACKLOG_LINT_USAGE' in backlogLintCli).toBe(false);
    expect('BACKLOG_PLAN_USAGE' in backlogPlanCli).toBe(false);
  });
});
