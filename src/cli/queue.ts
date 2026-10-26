import { readQueueVisits } from '../core/queue/journal.js';
import { estimateQueueStats } from '../core/queue/stats.js';

export async function cmdQueue(args: string[]): Promise<number> {
  const help = 'Usage: phm queue stats [--json] [--window <seconds>]\nSliding windows default to 1h, 24h, 7d. Rates per second; wait in seconds.\n';
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return 0; }
  let windows: number[] | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--window') {
      const seconds = Number(args[++i]);
      if (Number.isFinite(seconds) && seconds > 0 && Number.isFinite(seconds * 1000)) { windows = [seconds * 1000]; continue; }
    }
    console.error(help); return 2;
  }
  if (args[0] !== 'stats') { console.error(help); return 2; }
  try {
    const stats = estimateQueueStats(await readQueueVisits(), Date.now(), windows);
    if (args.includes('--json')) console.log(JSON.stringify(stats));
    else {
      for (const [scope, rows] of [['station', stats.stations], ['pool', stats.pools]] as const) {
        for (const row of rows) for (const w of row.windows) {
          console.log(`${scope}=${row[scope]} window=${w.windowMs / 1000}s lambda=${w.lambda} mu=${w.mu ?? 'unknown'} rho=${w.rho ?? 'unknown'} queue=${w.queueLength} wait=${w.wait ?? 'unknown'} wip=${w.wip} littleLaw=${w.littleLaw.flagged ?? 'unknown'}`);
        }
      }
      if (!stats.stations.length) console.log('No recorded queue visits.');
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue statistics unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return 1;
  }
}
