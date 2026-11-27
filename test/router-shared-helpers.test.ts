import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  appendLedgerLine,
  defaultRouterRunsDir,
  firstTrimmedString,
  incrementTally,
  isLedgerRecord,
  nonNegativeSafeInt,
  parseJsonObjectLine,
  rankTallyEntries,
  resolveRouterRunsDir,
  tailTruncated,
} from '../src/core/router/outcomes.js';
import {
  estimateRouterTokens,
  isRouterGatewayRecord,
  parseRouterGatewayConfig,
  ROUTER_GATEWAY_DIFFICULTIES,
  ROUTER_GATEWAY_TASKS,
} from '../src/core/router-gateway/config.js';

describe('router shared ledger and tally helpers', () => {
  it('resolves runsDir from explicit arg or ASHLR_RUNS_DIR and enforces absolute paths', () => {
    const prev = process.env['ASHLR_RUNS_DIR'];
    try {
      process.env['ASHLR_RUNS_DIR'] = '/tmp/env-runs-dir';
      expect(defaultRouterRunsDir()).toBe('/tmp/env-runs-dir');
      expect(defaultRouterRunsDir('/tmp/explicit-runs')).toBe('/tmp/explicit-runs');
      expect(resolveRouterRunsDir('/tmp/explicit-runs')).toBe('/tmp/explicit-runs');
      expect(() => resolveRouterRunsDir('relative/runs')).toThrow(RangeError);
    } finally {
      if (prev === undefined) delete process.env['ASHLR_RUNS_DIR'];
      else process.env['ASHLR_RUNS_DIR'] = prev;
    }
  });

  it('guards plain records and parses JSON object lines only', () => {
    expect(isLedgerRecord({ a: 1 })).toBe(true);
    expect(isLedgerRecord(null)).toBe(false);
    expect(isLedgerRecord([1, 2])).toBe(false);
    expect(isLedgerRecord('text')).toBe(false);

    expect(parseJsonObjectLine('{"k":"v"}')).toEqual({ k: 'v' });
    expect(parseJsonObjectLine('[1,2,3]')).toBeNull();
    expect(parseJsonObjectLine('null')).toBeNull();
    expect(parseJsonObjectLine('"str"')).toBeNull();
    expect(parseJsonObjectLine('{broken')).toBeNull();
  });

  it('extracts trimmed strings, non-negative safe integers, and tail truncation state', () => {
    expect(firstTrimmedString({ a: '  ', b: ' ok ', c: 'later' }, 'a', 'b', 'c')).toBe('ok');
    expect(firstTrimmedString({ a: 123, b: '' }, 'a', 'b')).toBeNull();

    expect(nonNegativeSafeInt(0)).toBe(0);
    expect(nonNegativeSafeInt(42)).toBe(42);
    expect(nonNegativeSafeInt(-1)).toBeNull();
    expect(nonNegativeSafeInt(1.5)).toBeNull();
    expect(nonNegativeSafeInt(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(nonNegativeSafeInt('42')).toBeNull();

    expect(tailTruncated({ state: 'read', text: '', truncated: true })).toBe(true);
    expect(tailTruncated({ state: 'read', text: '', truncated: false })).toBe(false);
    expect(tailTruncated({ state: 'missing' })).toBe(false);
  });

  it('tallies counts and ranks entries by descending count then key with limit', () => {
    const map = new Map<string, number>();
    incrementTally(map, 'beta');
    incrementTally(map, 'alpha');
    incrementTally(map, 'beta');
    incrementTally(map, 'gamma');
    incrementTally(map, 'delta');

    expect(rankTallyEntries(map, 3, (key, count) => ({ key, count }))).toEqual([
      { key: 'beta', count: 2 },
      { key: 'alpha', count: 1 },
      { key: 'delta', count: 1 },
    ]);
  });

  it('appends ledger lines safely and refuses symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'router-shared-ledger-'));
    try {
      const ledger = join(dir, 'nested', 'jobs.jsonl');
      await appendLedgerLine(ledger, '{"event":"a"}', 'Invalid ledger');
      await appendLedgerLine(ledger, '{"event":"b"}', 'Invalid ledger');
      expect(await readFile(ledger, 'utf8')).toBe('{"event":"a"}\n{"event":"b"}\n');

      const target = join(dir, 'target.jsonl');
      await writeFile(target, '');
      const link = join(dir, 'nested', 'link.jsonl');
      await symlink(target, link);
      await expect(appendLedgerLine(link, '{"event":"c"}', 'Invalid ledger')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('router-gateway shared config helpers', () => {
  it('shares record validation, token estimation, and task/difficulty enums', () => {
    expect(isRouterGatewayRecord({ version: 1 })).toBe(true);
    expect(isRouterGatewayRecord(null)).toBe(false);
    expect(isRouterGatewayRecord([])).toBe(false);

    expect(estimateRouterTokens(0)).toBe(0);
    expect(estimateRouterTokens(1)).toBe(1);
    expect(estimateRouterTokens(8)).toBe(2);
    expect(estimateRouterTokens(9)).toBe(3);

    expect(ROUTER_GATEWAY_TASKS).toEqual(['code', 'review', 'plan', 'bulk', 'leader']);
    expect(ROUTER_GATEWAY_DIFFICULTIES).toEqual(['low', 'medium', 'high']);

    const cfg = parseRouterGatewayConfig(JSON.stringify({
      version: 1,
      defaults: { task: 'review', difficulty: 'high' },
      models: { fast: { route: 'auto', task: 'bulk', difficulty: 'low' } },
    }));
    expect(cfg.defaults).toEqual({ task: 'review', difficulty: 'high' });
    expect(cfg.models['fast']).toEqual({ route: 'auto', task: 'bulk', difficulty: 'low' });
    expect(() => parseRouterGatewayConfig(JSON.stringify({ version: 1, defaults: { task: 'nope' } })))
      .toThrow(/defaults\.task must be one of/);
    expect(() => parseRouterGatewayConfig(JSON.stringify({ version: 1, models: { a: { route: 'auto', difficulty: 'nope' } } })))
      .toThrow(/models\.a\.difficulty must be one of/);
  });
});
