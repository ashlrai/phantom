/**
 * decide/status.ts — the numbers behind `ashlr jev status`, the Resources
 * "Jev" card and the Usage panel: decisions today by kind, average
 * confidence, fallback rate, estimated cost, latency. Reads the ledger only;
 * never calls the API; never throws.
 */

import type { AshlrConfig } from '../types.js';
import { typeSafeAvailable, TYPESAFE_DISABLE_ENV } from '../classify/typesafe-client.js';
import {
  JEV_DISABLE_ENV,
  calledSum,
  classifierKilledByEnv,
  fallbackRateOf,
  isNonNegativeFinite,
  jevKilledByEnv,
  localDay,
  meanOf,
  readJevConfig,
  readLedger,
  summarizeByKind,
  validTokenCount,
} from './ledger.js';
import type { DecisionRecord, JevStatus } from './types.js';

export function jevStatusFromRecords(
  records: readonly DecisionRecord[],
  meta: { enabled: boolean; keyed: boolean; disabledBy?: string; day: string; dailyCallBudget: number | null; disabledKinds: JevStatus['disabledKinds'] },
): JevStatus {
  const called = records.filter((r) => r.called);
  const answered = records.filter((r) => typeof r.jevConfidence === 'number');
  const jev = records.filter((r) => r.path === 'jev').length;
  const reportedCalls = called.filter((r) => validTokenCount(r.inputTokens) && validTokenCount(r.outputTokens)).length;
  const pricedCalls = called.filter((r) => isNonNegativeFinite(r.estCostUsd)).length;
  return {
    enabled: meta.enabled,
    keyed: meta.keyed,
    ...(meta.disabledBy ? { disabledBy: meta.disabledBy } : {}),
    day: meta.day,
    decisionsToday: records.length,
    callsToday: called.length,
    dailyCallBudget: meta.dailyCallBudget,
    inputTokensToday: calledSum(records, 'inputTokens'),
    outputTokensToday: calledSum(records, 'outputTokens'),
    estCostUsdToday: calledSum(records, 'estCostUsd'),
    usageCoverage: {
      reportedCalls,
      unknownCalls: called.length - reportedCalls,
    },
    costCoverage: {
      pricedCalls,
      unknownCalls: called.length - pricedCalls,
      source: 'recorded-estimates',
    },
    lastSuccessfulCallAt: called.filter((r) => typeof r.jevConfidence === 'number' && Number.isFinite(Date.parse(r.ts)))
      .map((r) => r.ts).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
    fallbackRateToday: fallbackRateOf(records.length, jev),
    avgConfidenceToday: meanOf(answered.map((r) => r.jevConfidence!)),
    avgLatencyMsToday: meanOf(called.map((r) => r.durationMs)),
    byKind: summarizeByKind(records),
    disabledKinds: meta.disabledKinds,
  };
}

/** Status for one local day (default today). */
export function jevStatus(cfg: AshlrConfig = {} as AshlrConfig, day: string = localDay()): JevStatus {
  const jc = readJevConfig();
  const classifyKilled = classifierKilledByEnv();
  let disabledBy: string | undefined;
  if (jevKilledByEnv()) disabledBy = `${JEV_DISABLE_ENV} is set`;
  else if (classifyKilled) disabledBy = `${TYPESAFE_DISABLE_ENV} is set`;
  else if (!jc.enabled) disabledBy = 'jev/config.json enabled=false';
  let keyed = false;
  try {
    keyed = !classifyKilled && typeSafeAvailable(cfg);
  } catch {
    keyed = false;
  }
  return jevStatusFromRecords(readLedger(day), {
    enabled: disabledBy === undefined,
    keyed,
    ...(disabledBy ? { disabledBy } : {}),
    day,
    dailyCallBudget: jc.dailyCallBudget,
    disabledKinds: jc.disabledKinds,
  });
}
