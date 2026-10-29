/** `phm metrics [summary|dashboard|record|recommend|templates]` — local telemetry + value metrics. */
import { join } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { ashlrHome } from '../core/cloud/store.js';
import { readTelemetry, recordEvent, type TelemetryInput } from '../core/metrics/telemetry.js';
import { recommend, rollup } from '../core/metrics/scoring.js';
import { renderDashboard } from '../core/metrics/dashboard.js';
import { readRouterFeed, parseRouterFeed, type RouterFeed } from '../core/metrics/router-feed.js';
import { rankTemplates } from '../core/metrics/templates.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../core/verse/preferences.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';

const USAGE = 'Usage: phm metrics <summary|dashboard [--out file]|record <json>|recommend <taskType> <arm...>|templates [--json] [--stdin] [--input <json>]> [--json]';

export interface MetricsIO {
  readInput?: () => Promise<string>;
  write?: (text: string) => void;
}

export async function cmdMetrics(argv: string[], io: MetricsIO = {}): Promise<number> {
  const { readInput = () => '', write = (text: string) => console.log(text) } = io;
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  const json = argv.includes('--json');
  const sub = argv.filter((a) => a !== '--json').filter((a) => a !== '--stdin').filter((a) => a !== '--input').filter((a) => a !== '--input' && !a.startsWith('--input='))[0] ?? 'summary';
  const rest = argv.filter((a) => !a.startsWith('--'));
  const hasStdin = argv.includes('--stdin') || argv.find((a) => a.startsWith('--input')) !== undefined;
  const inputArg = argv.find((a) => a.startsWith('--input'))?.split('=').slice(1).join('=') || null;

  if (sub === 'templates') {
    try {
      const raw = inputArg ?? (hasStdin ? await readInput() : null);
      let feed: RouterFeed;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          feed = parseRouterFeed(parsed);
        } catch {
          feed = { schemaVersion: 1, available: true, jobs: [] };
        }
      } else {
        feed = readRouterFeed();
      }
      const report = rankTemplates(feed);
      write(JSON.stringify(report, null, 2));
      return 0;
    } catch {
      write(JSON.stringify({ error: hasStdin ? 'Invalid router snapshot' : 'Unknown templates subcommand' }));
      return 2;
    }
  }

  if (rejectUnknownOptions(rest, sub === 'dashboard' ? { values: ['--out'] } : {})) { console.error(USAGE); return 2; }
  try {
    switch (sub) {
      case 'summary': {
        if (rest.length) { console.error(USAGE); return 2; }
        const r = rollup(readTelemetry());
        if (json) console.log(JSON.stringify(r, null, 2));
        else console.log(`${r.totals.prsShipped} PRs shipped · ${r.totals.valuePerMTok} value/1M tok · ${r.totals.valuePerHour} value/hr · ${r.totals.valuePerUsd ?? '—'} value/$`);
        return 0;
      }
      case 'dashboard': {
        if (rest.length && (rest.length !== 2 || rest[0] !== '--out' || !rest[1] || rest[1].startsWith('-'))) { console.error(USAGE); return 2; }
        const out = rest[1] ?? join(ashlrHome(), 'metrics', 'dashboard.html');
        const html = renderDashboard(rollup(readTelemetry()), runSteward(defaultStewardPolicy()));
        if (!rest.length) { ensurePrivateDirectory(ashlrHome()); ensurePrivateDirectory(join(ashlrHome(), 'metrics')); }
        writePrivateFileAtomic(out, html);
        console.log(out); return 0;
      }
      case 'record': { if (rest.length !== 1) { console.error(USAGE); return 2; } let input: TelemetryInput; try { input = JSON.parse(rest[0]!) as TelemetryInput; } catch { console.error('phm metrics: invalid JSON event.'); return 2; } const ev = recordEvent(input); console.log(json ? JSON.stringify(ev) : ev.id); return 0; }
      case 'recommend': { const [taskType, ...arms] = rest; if (!taskType || !arms.length) { console.error(USAGE); return 2; } console.log(JSON.stringify(recommend(readTelemetry(), taskType, arms), null, 2)); return 0; }
      default: console.error(USAGE); return 2;
    }
  } catch { console.error('phm metrics: unable to process metrics; check the event schema and local file permissions.'); return 1; }
}
