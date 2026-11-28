import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REFUSED_EXEC, assertAllowedPath, launchdRunsLedgerPath, ledgerLine,
  parseJsonlRecords, planOrSkip, readLedger, safeReportToken, securityReportsDir,
} from '../src/core/autofix/guard.js';
import { createNodeHost } from '../src/core/autofix/host-node.js';
import * as autofixRun from '../src/core/autofix/run.js';
import {
  LAUNCHD_LABEL_RE, RESIDENT_LABEL, defaultLaunchdJob,
  isAutofixRecord, isFixResult, isFixerId, isIncidentStatus,
} from '../src/core/autofix/types.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('autofix shared vocabulary, path, and guard helpers', () => {
  it('validates records, vocabularies, launchd labels, and default launchd jobs', () => {
    expect(isAutofixRecord({ a: 1 })).toBe(true);
    expect(isAutofixRecord(null)).toBe(false);
    expect(isAutofixRecord([])).toBe(false);

    expect(isFixerId('outside-load')).toBe(true);
    expect(isFixerId('pinned-hand-edit')).toBe(true);
    expect(isFixerId('unknown')).toBe(false);

    for (const result of [
      'applied', 'dry-run', 'skipped', 'refused', 'refused_admitted',
      'refused_stale', 'refused_operator', 'failed', 'detect-only',
    ]) expect(isFixResult(result)).toBe(true);
    expect(isFixResult('bogus')).toBe(false);

    for (const status of ['fixed', 'failed', 'intentional', 'refused']) {
      expect(isIncidentStatus(status)).toBe(true);
    }
    expect(isIncidentStatus('bogus')).toBe(false);

    expect(LAUNCHD_LABEL_RE.test('ai.ashlr.daemon')).toBe(true);
    expect(LAUNCHD_LABEL_RE.test('bad label')).toBe(false);

    expect(defaultLaunchdJob(RESIDENT_LABEL, 100, 200)).toEqual({
      label: RESIDENT_LABEL, domain: 'gui', disabled: false, samples: [],
      logTail: '', plistMtimeMs: 100, rollbackMtimeMs: 200, authorityGoverned: true,
    });
    expect(defaultLaunchdJob('ai.ashlr.other', null, null).authorityGoverned).toBe(false);
  });

  it('builds ledger paths, sanitizes tokens, guards paths, and parses JSONL records', () => {
    expect(launchdRunsLedgerPath('/runs')).toBe('/runs/ledger/launchd-runs.jsonl');
    expect(securityReportsDir('/runs')).toBe('/runs/ledger/autofix-security');
    expect(safeReportToken('ai.ashlr/bad:name', 12)).toBe('ai.ashlr_bad');
    expect(REFUSED_EXEC).toEqual({ code: 1, stdout: '', stderr: 'refused' });
    expect(() => assertAllowedPath('/Users/alice/.codex/auth.json')).toThrow('refused path');
    expect(() => assertAllowedPath('/tmp/autofix-runs/ledger/autofix.jsonl')).not.toThrow();

    const parsed = parseJsonlRecords(
      '\n{"n":1}\nnot-json\n{"n":"bad"}\n{"n":2}\n',
      (value) => (isAutofixRecord(value) && typeof value['n'] === 'number' ? value['n'] : null),
    );
    expect(parsed).toEqual([1, 2]);
    expect(parseJsonlRecords(null, () => 1)).toEqual([]);

    const valid = ledgerLine('2026-11-16T18:00:00.000Z', 'outside-load', '90', 'renice-15', {}, { nice: 15 }, 'applied');
    const badResult = JSON.stringify({ ...valid, result: 'bogus' });
    expect(readLedger(`${JSON.stringify(valid)}\n${badResult}\n`)).toEqual([valid]);
  });

  it('gates dry-run and previously recorded actions through planOrSkip', () => {
    const ts = '2026-11-16T18:00:00.000Z';
    const dry = planOrSkip({ dryRun: true, ledger: [] }, ts, 'outside-load', '90', 'renice-15', { pid: 90 }, { nice: 15 });
    expect(dry.done).toBe(true);
    if (dry.done) expect(dry.line.result).toBe('dry-run');

    const fresh = planOrSkip({ dryRun: false, ledger: [] }, ts, 'outside-load', '90', 'renice-15', { pid: 90 }, { nice: 15 });
    expect(fresh.done).toBe(false);
    if (!fresh.done) {
      expect(fresh.planned.result).toBe('applied');
      const repeat = planOrSkip({ dryRun: false, ledger: [fresh.planned] }, ts, 'outside-load', '90', 'renice-15', { pid: 90 }, { nice: 15 });
      expect(repeat.done).toBe(true);
      if (repeat.done) expect(repeat.line.result).toBe('skipped');
    }
  });

  it('refuses writing when a regular file occupies the target directory path and prunes redundant exports', () => {
    const root = mkdtempSync(join(tmpdir(), 'autofix-host-'));
    temps.push(root);
    const blockingFile = join(root, 'not-a-dir');
    writeFileSync(blockingFile, 'occupied');
    const host = createNodeHost();
    expect(() => host.writeFile(join(blockingFile, 'report.json'), '{}')).toThrow(/not a directory/);

    expect('fixerId' in autofixRun).toBe(false);
  });
});
