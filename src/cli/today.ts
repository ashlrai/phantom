/** `phm today`: thin handler. Reads the same three reports the phone's Today screen draws and prints core/fleet/today.ts. */
import { listAskBatch } from '../core/fleet/asks-batch.js';
import { readHome } from '../core/fleet/home.js';
import { buildToday, todayText, type TodayInput, type TodayV1 } from '../core/fleet/today.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm today [--json]
Is it working: one sentence (PRs merged in the last hour, jobs running, the pool that is empty and when it is back, questions waiting),
then jobs running per lane, the empty pools with their return time, and the open asks only you can answer (reply with phm asks answer).
The phone's Today screen shows exactly this. Read-only. A source that cannot be read prints as unknown, never zero.
  --json   print the typed summary (schema today.v1)`;

async function readInput(): Promise<TodayInput> {
  const now = Date.now();
  const quiet = <T>(read: () => Promise<T> | T): Promise<T | null> => Promise.resolve().then(read).catch(() => null);
  const [home, pools, asks] = await Promise.all([
    quiet(() => readHome({ now })),
    quiet(async () => {
      const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }] = await Promise.all([
        import('../core/fleet/runs-resource-ledger.js'), import('../core/fleet/pools-view.js'), import('../core/fleet/usage-history.js'),
      ]);
      return buildPoolsView(await readResourceLedger({ now: () => now }), now, await readUsageSamples({ nowMs: now }));
    }),
    quiet(() => listAskBatch()),
  ]);
  return { home, pools, asks };
}

export async function cmdToday(args: string[], read: () => Promise<TodayInput> = readInput): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const bad = args.find((arg) => arg !== '--json');
  if (bad !== undefined) { console.error(`phm today: unknown option ${bad}\n${usage}`); return 2; }
  const today = sanitizePublicJson(buildToday(await read(), Date.now())) as TodayV1;
  console.log(args.includes('--json') ? JSON.stringify(today) : todayText(today).join('\n'));
  return 0;
}
