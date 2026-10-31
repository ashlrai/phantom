import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

export function cmdResourcePersonalUsage(opts: { json: boolean; home?: string }): number {
  const homeDir = homedir();
  const personalHome = resolve(opts.home ?? join(homeDir, '.codex-2'));
  const usages = collectCodexSessionUsages({
    env: { CODEX_HOME: personalHome, CODEX_HOME_ALT: personalHome },
    homeDir,
  });
  const personal = usages.length > 0
    ? usages.map((usage) => ({ ...usage, accountId: 'codex-personal', slot: 'secondary' as const,
      // Do not expose free-form rollout metadata in this personal view.
      limitId: null, limitName: null, model: null, originator: null, cliVersion: null }))
    : [unavailableUsage()];
  const report = buildCodexResourceReport(personal, [], Date.now());
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const resource = report.resources[0]!;
    console.log('Personal Codex usage');
    console.log(`  Freshness: ${resource.state} | observed: ${resource.observedAt ?? 'unknown'}`);
    console.log(windowText('Session', resource.session));
    console.log(windowText('Weekly', resource.weekly));
  }
  return 0;
}
