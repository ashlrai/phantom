/** `phm metrics [summary|dashboard|record|recommend]` — local telemetry + value metrics. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { readTelemetry, recordEvent, type TelemetryInput } from '../core/metrics/telemetry.js';
import { recommend, rollup } from '../core/metrics/scoring.js';
import { renderDashboard } from '../core/metrics/dashboard.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';

const USAGE = 'Usage: phm metrics <summary|dashboard [--out file]|record <json>|recommend <taskType> <arm...>> [--json]';
export async function cmdMetrics(argv: string[]): Promise<number> {
  const [sub = 'summary', ...rest] = argv;
  const json = rest.includes('--json');
  try {
    switch (sub) {
      case 'summary': {
        const r = rollup(readTelemetry());
        if (json) console.log(JSON.stringify(r, null, 2));
        else console.log(`${r.totals.prsShipped} PRs shipped · ${r.totals.valuePerMTok} value/1M tok · ${r.totals.valuePerHour} value/hr · ${r.totals.valuePerUsd ?? '—'} value/$`);
        return 0;
      }
      case 'dashboard': {
        const i = rest.indexOf('--out'); const out = i >= 0 && rest[i + 1] ? rest[i + 1]! : join(ashlrHome(), 'metrics', 'dashboard.html');
        writeFileSync(out, renderDashboard(rollup(readTelemetry()), runSteward(defaultStewardPolicy())));
        console.log(out); return 0;
      }
      case 'record': { const ev = recordEvent(JSON.parse(rest[0] ?? '') as TelemetryInput); console.log(json ? JSON.stringify(ev) : ev.id); return 0; }
      case 'recommend': { const [taskType, ...arms] = rest.filter((x) => x !== '--json'); if (!taskType || !arms.length) throw new Error('recommend <taskType> <arm...>'); console.log(JSON.stringify(recommend(readTelemetry(), taskType, arms), null, 2)); return 0; }
      default: console.error(USAGE); return 2;
    }
  } catch (err) { console.error(`phm metrics: ${err instanceof Error ? err.message : String(err)}`); return 1; }
}
