/** Read-only per-account pool CLI version checks. Commands and output stay private. */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DoctorCheck } from '../types.js';
import { validateResourceConnectionConfig } from './connection-config.js';
import { readResourceJson } from './pool-runtime.js';
import { workerEnvironment } from './worker.js';
import { POOL_CLI_MIN_VERSIONS, probePoolCliVersion, type PoolCliProvider } from './pool-cli-versions.js';

export async function checkPoolCliVersions(
  accountsRoot = join(homedir(), '.ashlr', 'account-connections'),
  probe: typeof probePoolCliVersion = probePoolCliVersion,
): Promise<DoctorCheck[]> {
  let accounts: Array<{ id: string; provider: string; command: string[] }>;
  const path = join(accountsRoot, 'connections.json');
  const invalidRoster = (): DoctorCheck[] => [{ id: 'pool-cli-config', label: 'Pool CLI versions', status: 'fail',
    detail: 'Cannot read a valid native pool connection roster; CLI versions are unverified',
    fix: 'Repair the native account connections configuration and rerun phm doctor' }];
  let absent = false;
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return invalidRoster();
    absent = true;
  }
  if (absent) {
    accounts = (['claude', 'codex'] as const).map(provider => ({ id: provider, provider, command: [provider] }));
  } else {
    try { accounts = validateResourceConnectionConfig(readResourceJson(path)).accounts; }
    catch { return invalidRoster(); }
  }
  const checks: DoctorCheck[] = [];
  const deadline = performance.now() + 10_000;
  // Sequential probes and one total deadline bound cost independently of roster size.
  for (const account of accounts) {
    if (account.provider !== 'claude' && account.provider !== 'codex') continue;
    const provider: PoolCliProvider = account.provider;
    const policy = POOL_CLI_MIN_VERSIONS[provider];
    const remaining = Math.floor(deadline - performance.now());
    const result = remaining <= 0 ? { status: 'unknown' as const, version: null }
      : await probe(provider, account.command, {
        cwd: homedir(), env: workerEnvironment(), timeoutMs: Math.min(5_000, remaining),
      });
    checks.push({ id: `pool-cli:${account.id}`, label: `Pool CLI: ${account.id} (${policy.label})`,
      status: result.status === 'supported' ? 'pass' : result.status === 'outdated' ? 'fail' : 'warn',
      detail: `${policy.label} ${result.version ?? 'unknown'}; minimum ${policy.minimum} (${result.status})`,
      ...(result.status === 'supported' ? {} : {
        fix: `Update or repin this pool's ${policy.label} CLI to ${policy.minimum} or newer and rerun phm doctor`,
      }) });
  }
  return checks;
}
