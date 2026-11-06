/** Explicit runner-export ingestion; importing this module has no side effects. */
import { open } from 'node:fs/promises';
import { buildMemoryBenchmark, memoryBenchmarkSpans, memoryReportLine } from '../core/observability/memory-benchmark.js';

const HELP = `phm pulse memory --samples <file> [--json] [--send]

Read a JSON array of job samples (RSS in bytes, memguard RUN/PAUSE).
Report only by default. --send uses the configured Pulse analytics sink.
No new credentials: inject existing credentials through phantom exec --.
Merged PR identities must come from confirmed runner merge observations.`;
const MAX_BYTES = 16 * 1024 * 1024;

export async function cmdPulseMemory(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  let file: string | undefined;
  let json = false;
  let send = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--samples' && !file && args[i + 1] && !args[i + 1].startsWith('-')) file = args[++i];
    else if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--send' && !send) send = true;
    else { console.error(HELP); return 2; }
  }
  if (!file) { console.error(HELP); return 2; }
  try {
    const handle = await open(file, 'r');
    let input: unknown;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Expected regular file');
      // Bound the actual read, including files growing after stat().
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error('Sample file too large');
      input = JSON.parse(bytes.toString('utf8', 0, length));
    } finally { await handle.close(); }
    const report = buildMemoryBenchmark(input);
    let delivery: import('../core/types.js').TelemetryEmitResult | undefined;
    if (send) {
      const [{ loadConfig }, { getSink }] = await Promise.all([
        import('../core/config.js'), import('../core/observability/telemetry-sink.js'),
      ]);
      delivery = await getSink(loadConfig(), false).emit(memoryBenchmarkSpans(report, new Date().toISOString()));
    }
    console.log(json ? JSON.stringify({ ...report, ...(delivery ? { delivery: { sink: delivery.sink, ok: delivery.ok } } : {}) }) : memoryReportLine(report));
    if (delivery && !json) console.log(`Analytics: ${delivery.sink} ${delivery.ok ? (delivery.sink === 'local' ? 'stored' : 'sent') : 'unavailable'}`);
    return delivery?.ok === false ? 1 : 0;
  } catch {
    // Neither malformed file contents nor transport exceptions may reveal secrets.
    console.error('Memory benchmark failed: unreadable or invalid samples, or analytics unavailable.');
    return 1;
  }
}
