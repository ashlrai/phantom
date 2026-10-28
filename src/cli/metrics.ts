import { ingestMetrics, MetricsInputError } from '../core/fleet/metrics-ingest.js';

const HELP = `phm metrics ingest --jobs <jobs.jsonl> --status <status.json> [--json]

Read two explicit local files and print deterministic lane and tier metrics as JSON.
No network, writes, provider calls or operational routing changes.
Missing measurements remain null. See docs/METRICS-ROUTER-FEED.md for schemas.
Exit 0: report or help. Exit 2: invalid arguments or refused input.`;

export function cmdMetrics(args: string[], io = { out: console.log, err: console.error }): number {
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0]) ||
    args.length === 2 && args[0] === 'ingest' && ['--help', '-h'].includes(args[1])) {
    io.out(HELP); return 0;
  }
  const usage = (): number => { io.err(HELP); return 2; };
  if (args[0] !== 'ingest') return usage();
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const option = args[i];
    if (!['--jobs', '--status', '--json'].includes(option) || options.has(option)) return usage();
    if (option === '--json') { options.set(option, 'true'); continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) return usage();
    options.set(option, value);
  }
  const jobs = options.get('--jobs'), status = options.get('--status');
  if (!jobs || !status) return usage();
  try {
    io.out(JSON.stringify(ingestMetrics(jobs, status), null, 2)); return 0;
  } catch (error) {
    io.err(error instanceof MetricsInputError ? error.message : 'Metrics input could not be read.'); return 2;
  }
}
