import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { probePersonalQuota } from '../core/fleet/personal-quota-probe.js';
import {
  buildCodexResourceReport,
  collectCodexSessionUsages,
  type CodexResourceWindow,
  type CodexSessionUsage,
} from '../core/fleet/codex-session-usage.js';

function unavailableUsage(): CodexSessionUsage {
  return {
    accountId: 'codex-personal', slot: 'secondary', observedAt: null,
    planType: null, limitId: null, limitName: null, rateLimitReachedType: null,
    spendControlReached: null, individualLimit: null, model: null, originator: null,
    cliVersion: null, primary: null, secondary: null, credits: null,
  };
}

function windowText(name: string, window: CodexResourceWindow | null): string {
  if (!window) return `  ${name}: unavailable`;
  return `  ${name}: ${window.usedPct === null ? 'unavailable' : `${window.usedPct}% used`} | resets: ${window.resetsAt ?? 'unknown'}`;
}

/** Exit 0 for current usage evidence; exit 1 when evidence is stale or unavailable. */
export function cmdResourcePersonalUsage(opts: { json: boolean; home?: string; refresh?: false }): number;
export function cmdResourcePersonalUsage(opts: { json: boolean; home?: string; refresh?: boolean }): number | Promise<number>;
export function cmdResourcePersonalUsage(opts: { json: boolean; home?: string; refresh?: boolean }): number | Promise<number> {
  const homeDir = homedir();
  const personalHome = resolve(opts.home ?? join(homeDir, '.codex-2'));
  if (opts.refresh) {
    return probePersonalQuota(opts.home ?? personalHome).then(
      live => printPersonalUsage([live], opts.json, null, true),
      () => printPersonalUsage([], opts.json, 'Personal quota refresh failed. Check the personal home and installed Codex app-server, then retry.', true),
    );
  }
  return printPersonalUsage(collectCodexSessionUsages({
    env: { CODEX_HOME: personalHome, CODEX_HOME_ALT: personalHome },
    homeDir,
  }), opts.json, null);
}

function printPersonalUsage(usages: CodexSessionUsage[], json: boolean, refreshError: string | null, refresh = false): number {
  const personal = usages.length > 0
    ? usages.map((usage) => ({ ...usage, accountId: 'codex-personal', slot: 'secondary' as const,
      // Do not expose free-form rollout metadata in this personal view.
      limitId: null, limitName: null, model: null, originator: null, cliVersion: null }))
    : [unavailableUsage()];
  const report = buildCodexResourceReport(personal, [], Date.now());
  if (json) {
    console.log(JSON.stringify(refresh ? { ...report, refresh: { status: refreshError ? 'failed' : 'current', error: refreshError } } : report, null, 2));
  } else {
    const resource = report.resources[0]!;
    console.log('Personal Codex usage');
    if (refreshError) console.log(refreshError);
    console.log(`  Freshness: ${resource.state} | observed: ${resource.observedAt ?? 'unknown'}`);
    console.log(windowText('Session', resource.session));
    console.log(windowText('Weekly', resource.weekly));
    const burn = resource.weekly?.burnPctPerHour;
    console.log(`  Weekly measured burn: ${burn == null ? 'unknown' : `${burn}%/hour`} | projected exhaustion: ${resource.weekly?.projectedExhaustionAt ?? 'unknown'} | evidence: ${resource.state}`);
  }
  return report.resources[0]?.state === 'current' ? 0 : 1;
}
