/** `phm usage limits`: every provider account's limits, current usage and reset times. */
import { resolve } from 'node:path';
import { accountLimitsReport, accountLimitsText, type AccountLimitsSource } from '../core/usage/account-limits.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm usage limits [--json] [--accounts-root <directory>]
Every provider account (Claude, Codex, Grok): each window's used percent, whether the provider flagged a limit, and when it resets. Read-only.
The same records and summary as the console's Usage pane. A window with no reading prints "usage unknown", never 0%.
A limit is reported only when the provider flagged it, never from a 100% reading.
  --json                    print JSON (schema usage.limits.v1)
  --accounts-root <dir>     account connections directory, default the configured one or ~/.ashlr/account-connections
Without a running console this reads the shared evidence the collector last published; "Read from" says which.
Exit 2 on a bad option.`;

export interface UsageLimitsDeps {
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Reads the accounts snapshot for a root; injected by tests. */
  read?: (accountsRoot: string | undefined) => Promise<AccountLimitsSource>;
}

async function readSnapshot(accountsRoot: string | undefined): Promise<AccountLimitsSource> {
  const { buildVerseAccountsSnapshot, getVerseAccountCollector } = await import('../core/verse/accounts.js');
  let root = accountsRoot;
  if (root === undefined) {
    const { loadConfig } = await import('../core/config.js');
    const { resolveAccountsRoot } = await import('../core/verse/seats.js');
    root = resolveAccountsRoot(loadConfig());
  }
  return buildVerseAccountsSnapshot({ accountsRoot: root, collector: getVerseAccountCollector() });
}

export async function cmdUsageLimits(args: string[], deps: UsageLimitsDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false;
  let rootArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--accounts-root' && rootArg === undefined && next && !next.startsWith('-')) rootArg = args[++i];
    else { err(`phm usage limits: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const nowMs = (deps.now ?? Date.now)();
  const source = await (deps.read ?? readSnapshot)(rootArg === undefined ? undefined : resolve(rootArg));
  const report = accountLimitsReport(source, nowMs);
  out(json ? JSON.stringify(sanitizePublicJson(report)) : accountLimitsText(report, nowMs).map(line => sanitizePublicJson(line)).join('\n'));
  return 0;
}
