#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readResourceLedger, type ApiModelUsage } from '../../src/core/fleet/runs-resource-ledger.js';

type Sort = 'tokens' | 'errors' | 'usd';
type Dependencies = {
  readLedger?: typeof readResourceLedger;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

/**
 * --check-errors [--model exact-id] checks the ledger's returned model groups
 * before --limit. Exit 3 means observed errors, 1 means unavailable or no
 * observations, 2 means invalid options, and 0 means observed error-free rows.
 * The ledger's bounded tail and 100-model cap can omit observations. Degraded
 * sources may contain partial counts; an observed error still exits 3.
 * Without --check-errors, exit 0/1 continues to reflect source health alone.
 */
export async function runApiSpendReport(args: string[], deps: Dependencies = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  let sort: Sort = 'tokens';
  let limit: number | undefined;
  let seenSort = false;
  let seenLimit = false;
  let checkErrors = false;
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check-errors' && !checkErrors) {
      checkErrors = true;
      continue;
    }
    const value = args[++i];
    if (arg === '--sort' && !seenSort && (value === 'tokens' || value === 'errors' || value === 'usd')) {
      sort = value;
      seenSort = true;
    } else if (arg === '--limit' && !seenLimit && value !== undefined && /^(?:[1-9]|[1-9]\d|100)$/.test(value)) {
      limit = Number(value);
      seenLimit = true;
    } else if (arg === '--model' && model === undefined && value !== undefined && value.length > 0 && !value.startsWith('--')) {
      model = value;
    } else {
      stderr('Usage: api-spend-report [--sort tokens|errors|usd] [--limit 1..100] [--check-errors [--model exact-id]]\n');
      return 2;
    }
  }
  if (model !== undefined && !checkErrors) {
    stderr('Usage: api-spend-report [--sort tokens|errors|usd] [--limit 1..100] [--check-errors [--model exact-id]]\n');
    return 2;
  }
  try {
    const ledger = await (deps.readLedger ?? readResourceLedger)();
    const usage = ledger.apiSpend?.modelUsageToday ?? [];
    const selected = model === undefined ? usage : usage.filter(row => row.model === model);
    const requests = ledger.apiSpend === null ? null : selected.reduce((sum, row) => sum + row.rows, 0);
    const errors = requests === null ? null : selected.reduce((sum, row) => sum + row.errors, 0);
    const check = {
      model: model ?? null,
      requests,
      errors,
      errorFraction: requests && errors !== null ? errors / requests : null,
      status: ledger.sources.apiSpend !== 'healthy' || ledger.apiSpend === null ? 'unavailable'
        : requests === 0 ? 'unknown' : errors ? 'errors' : 'ok',
    };
    const compare = (a: ApiModelUsage, b: ApiModelUsage): number => {
      let difference: number;
      if (sort === 'usd') {
        if (a.usd === null && b.usd !== null) return 1;
        if (b.usd === null && a.usd !== null) return -1;
        difference = (b.usd ?? 0) - (a.usd ?? 0);
      } else if (sort === 'errors') {
        difference = b.errors - a.errors;
      } else {
        difference = (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens);
      }
      return difference || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
    };
    const rows = [...usage].sort(compare).slice(0, limit);
    const report = {
      source: 'metrics/api-spend.jsonl',
      sourceHealth: ledger.sources.apiSpend,
      observedAt: ledger.generatedAt,
      lastAt: ledger.apiSpend?.lastAt ?? null,
      sort,
      rows,
      omittedModels: (ledger.apiSpend?.modelUsageTodayOmitted ?? 0) + usage.length - rows.length,
      unrepresentedRows: ledger.apiSpend === null ? null : ledger.apiSpend.rowsToday - rows.reduce((sum, row) => sum + row.rows, 0),
      ...(checkErrors ? { check } : {}),
    };
    stdout(`${JSON.stringify(report, null, 2)}\n`);
    if (checkErrors) return errors ? 3 : check.status === 'ok' ? 0 : 1;
    return ledger.sources.apiSpend === 'healthy' ? 0 : 1;
  } catch {
    stderr('Unable to read the resource ledger.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runApiSpendReport(process.argv.slice(2));
}
