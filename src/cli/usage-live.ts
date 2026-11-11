/**
 * `phm usage live` runs the live usage tracker: official readouts, an optional
 * dedicated-browser fallback, budgets, alerts and first readings. One pass by
 * default; `--watch` repeats and wakes just after each reset_at.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { playwrightLauncher, profileDirAllowed, usageBrowserDir, type BrowserSession } from '../core/usage/live/browser.js';
import { renderFirstReadings, runLiveUsageTick, type LiveTickResult } from '../core/usage/live/engine.js';

const USAGE = 'Usage: phm usage live [--json] [--watch] [--browser [--headed]] [--interval <seconds>] [--queue-dir <abs>] [--bus-dir <abs>]';

export interface UsageLiveDeps {
  launch?: typeof playwrightLauncher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  home?: string;
  /** Stops a --watch loop; tests use it, the CLI uses process signals. */
  shouldStop?: () => boolean;
}

export async function cmdUsageLive(args: string[], deps: UsageLiveDeps = {}): Promise<number> {
  const home = deps.home ?? homedir();
  const runs = join(process.env['ASHLR_RUNS_DIR'] && isAbsolute(process.env['ASHLR_RUNS_DIR']) ? process.env['ASHLR_RUNS_DIR'] : join(home, '.ashlr-runs'));
  let queueDir = join(runs, 'queue'), busDir = join(runs, 'bus');
  let json = false, watch = false, browser = false, headed = false, intervalMs = 5 * 60_000;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    else if (arg === '--json') json = true;
    else if (arg === '--watch') watch = true;
    else if (arg === '--browser') browser = true;
    else if (arg === '--headed') headed = true;
    else if (arg === '--interval' || arg === '--queue-dir' || arg === '--bus-dir') {
      const value = args[++i];
      if (!value) { console.error(USAGE); return 2; }
      if (arg === '--interval') {
        const s = Number(value);
        if (!Number.isFinite(s) || s < 60 || s > 3600) { console.error('--interval must be 60 to 3600 seconds'); return 2; }
        intervalMs = s * 1000;
      } else if (!isAbsolute(value) || /(?:^|\/)\.codex[^/]*(?:\/|$)/.test(value)) { console.error(USAGE); return 2; }
      else if (arg === '--queue-dir') queueDir = value; else busDir = value;
    } else { console.error(USAGE); return 2; }
  }
  if (headed && !browser) { console.error(USAGE); return 2; }

  let session: BrowserSession | null = null;
  if (browser) {
    const dir = usageBrowserDir(home);
    if (!profileDirAllowed(dir, home)) { console.error('Usage browser profile path refused.'); return 1; }
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      session = await (deps.launch ?? playwrightLauncher)(dir, { headless: !headed });
    } catch {
      console.error('Usage browser is unavailable (Playwright is not installed or the profile could not open). Official readouts only.');
    }
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const firstPath = join(busDir, 'usage-live-first-readings.md');
  let last: LiveTickResult | null = null;
  try {
    do {
      last = await runLiveUsageTick({ nowMs: now(), queueDir, busDir, intervalMs, browser: session,
        official: {
          codexCmpHome: abs(process.env['PHANTOM_SENSOR_CODEX_CMP_HOME']),
          codexPersonalHome: abs(process.env['PHANTOM_SENSOR_CODEX_PERSONAL_HOME']),
        } });
      if (!(await exists(firstPath))) await writeFile(firstPath, renderFirstReadings(last), { mode: 0o600 });
      if (json) console.log(JSON.stringify({ generatedAt: last.generatedAt, budget: last.budget, needsSignin: last.needsSignin,
        alerts: last.alerts, nextWakeAt: last.nextWakeAt }));
      else {
        for (const [name, b] of Object.entries(last.budget)) {
          console.log(`${name} ${b['weekly_used_pct']}% reset=${b['reset_at'] ?? 'unknown'} source=${b['source']}${b['estimated'] ? ' estimated' : ''}`);
        }
        for (const n of last.needsSignin) console.log(`needs-signin ${n.label} ${n.url}`);
        for (const a of last.alerts) console.log(`alert ${a.level} ${a.message}`);
        if (!Object.keys(last.budget).length) console.log('no readable usage source');
      }
      if (!watch || deps.shouldStop?.()) break;
      await sleep(Math.max(1000, Date.parse(last.nextWakeAt) - now()));
    } while (!deps.shouldStop?.());
  } finally { try { await session?.close(); } catch { /* best effort */ } }
  return 0;
}

function abs(value: string | undefined): string | undefined { return typeof value === 'string' && isAbsolute(value) ? value : undefined; }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
