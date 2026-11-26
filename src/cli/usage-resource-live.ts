/**
 * `phm usage resource-live` reads every allowance and writes the sidecar
 * <runs>/state/resource-live.json. One pass by default; `--watch` repeats on
 * the adaptive cadence (about a minute while a lane is active, ten minutes
 * when readings stop changing). `--show` prints the stored sidecar and reads
 * nothing else.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  openUsageBrowserSession,
  optionalAbsolutePath,
  type BrowserLauncher,
  type BrowserSession,
} from '../core/usage/live/browser.js';
import { hasCodexHomeSegment } from '../core/usage/runway.js';
import { ResourceLiveBusyError, runResourceLiveTick, type ResourceLiveTickResult } from '../core/usage/resource-live/engine.js';
import type { ResourceLiveSources } from '../core/usage/resource-live/source-types.js';
import { defaultResourceLiveSources } from '../core/usage/resource-live/sources.js';
import { readResourceLiveFile } from '../core/usage/resource-live/store.js';
import type { ResourceLiveSidecar } from '../core/usage/resource-live/types.js';
import { loadConfigReadOnly } from '../core/config.js';
import { liveSourceOptions } from '../core/usage/resource-live/config.js';

const USAGE = 'Usage: phm usage resource-live [--json] [--watch] [--force] [--show] [--browser [--headed]] [--runs-dir <abs>]';

export interface UsageResourceLiveDeps {
  launch?: BrowserLauncher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  home?: string;
  sources?: ResourceLiveSources;
  /** Stops a --watch loop. Tests use it; the CLI runs until it is signalled. */
  shouldStop?: () => boolean;
}

function printTable(sidecar: Pick<ResourceLiveSidecar, 'readings' | 'burn_down'>): void {
  const rank = new Map(sidecar.burn_down.allowances.map(row => [row.id, row]));
  for (const reading of sidecar.readings) {
    const plan = rank.get(reading.id);
    const used = reading.used_pct === null ? 'unknown' : `${reading.used_pct}%`;
    const target = plan?.target_rate_per_hour == null ? '' : ` target=${plan.target_rate_per_hour} ${reading.unit}/h`;
    console.log(reading.verified
      ? `${reading.id} used=${used} reset=${reading.reset_at ?? 'unknown'} source=${reading.source} (${reading.source_tier}) confidence=${reading.confidence} observed=${reading.observed_at} plan=${plan?.action ?? 'unknown'}${target}`
      : `${reading.id} unverified (${reading.reason}) confidence=null plan=${plan?.action ?? 'unknown'}`);
  }
  const bank = sidecar.burn_down.banked_resets;
  if (bank) console.log(`banked Codex resets: ${bank.count ?? 'unknown'}`);
  if (bank?.proposal) console.log(`use reset now: ${bank.proposal.grant.kind} for ${bank.proposal.window} (expires ${bank.proposal.grant.expires_at}; explicit request required)`);
  console.log(`spend order: ${sidecar.burn_down.lane_order.join(', ') || 'none'}`);
}

export async function cmdUsageResourceLive(args: string[], deps: UsageResourceLiveDeps = {}): Promise<number> {
  const home = deps.home ?? homedir();
  let runsDir = optionalAbsolutePath(process.env['ASHLR_RUNS_DIR']) ?? join(home, '.ashlr-runs');
  let json = false, watch = false, force = false, show = false, browser = false, headed = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    else if (arg === '--json') json = true;
    else if (arg === '--watch') watch = true;
    else if (arg === '--force') force = true;
    else if (arg === '--show') show = true;
    else if (arg === '--browser') browser = true;
    else if (arg === '--headed') headed = true;
    else if (arg === '--runs-dir') {
      const value = args[++i];
      if (!value || !isAbsolute(value) || hasCodexHomeSegment(value)) { console.error(USAGE); return 2; }
      runsDir = value;
    } else { console.error(USAGE); return 2; }
  }
  if ((headed && !browser) || (show && (watch || force || browser))) { console.error(USAGE); return 2; }

  if (show) {
    const stored = await readResourceLiveFile(runsDir) as ResourceLiveSidecar | null;
    if (!stored || !Array.isArray(stored.readings) || !Array.isArray(stored.burn_down?.allowances)) {
      console.error('No resource-live sidecar yet. Run `phm usage resource-live` first.');
      return 1;
    }
    if (json) console.log(JSON.stringify(stored)); else printTable(stored);
    return 0;
  }

  let session: BrowserSession | null = null;
  if (browser) {
    const opened = await openUsageBrowserSession({ home, headed, launch: deps.launch });
    if (opened.status === 'refused') { console.error('Usage browser profile path refused.'); return 1; }
    if (opened.status === 'opened') session = opened.session;
    else console.error('Usage browser is unavailable (Playwright is not installed or the profile could not open). Official sources only.');
  }
  const sources = deps.sources ?? defaultResourceLiveSources({
    ...liveSourceOptions(loadConfigReadOnly()),
    runsDir,
    operatorHome: home,
    browser: session,
  });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    do {
      let result: ResourceLiveTickResult;
      try {
        result = await runResourceLiveTick({ runsDir, sources, nowMs: now(), force });
      } catch (error) {
        if (!(error instanceof ResourceLiveBusyError)) throw error;
        console.error('Another resource-live pass is running.');
        if (!watch) return 1;
        await sleep(60_000);
        continue;
      }
      if (json) {
        console.log(JSON.stringify({ generated_at: result.sidecar.generated_at, polled: result.polled, readings: result.sidecar.readings,
          burn_down: result.sidecar.burn_down, reset_drafts: result.drafts, decision_file: result.decisionFile,
          next_poll_at: result.sidecar.next_poll_at }));
      } else {
        printTable(result.sidecar);
        if (result.decisionFile) console.log(`reset decision drafted for the owner: ${result.decisionFile}`);
      }
      if (!watch || deps.shouldStop?.()) break;
      await sleep(Math.max(1000, Date.parse(result.sidecar.next_poll_at) - now()));
    } while (!deps.shouldStop?.());
  } finally { try { await session?.close(); } catch { /* best effort */ } }
  return 0;
}
