import { parseRouterFeed, readRouterFeed } from '../core/metrics/router-feed.js';
import { rankTemplates } from '../core/metrics/templates.js';

export interface MetricsIO {
  readInput: () => Promise<string>;
  write: (text: string) => void;
}

const defaultIO: MetricsIO = {
  async readInput() {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('Router snapshot exceeds 16 MiB');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  },
  write: text => { process.stdout.write(text); },
};

export async function cmdMetricsTemplates(args: string[], overrides: Partial<MetricsIO> = {}): Promise<number> {
  const io = { ...defaultIO, ...overrides };
  if (args.includes('--help') || args.includes('-h')) {
    io.write('Usage: phm metrics templates [--json] [--stdin]\nRead-only template rankings. --stdin accepts a version 1 router snapshot.\n');
    return 0;
  }
  const json = args.includes('--json');
  if (args[0] !== 'templates' || args.slice(1).some(arg => !['--json', '--stdin'].includes(arg))) {
    io.write(json ? '{"error":"Usage: phm metrics templates [--json] [--stdin]"}\n' :
      'Usage: phm metrics templates [--json] [--stdin]\n');
    return 2;
  }
  try {
    const feed = args.includes('--stdin') ? parseRouterFeed(JSON.parse(await io.readInput())) : readRouterFeed();
    const report = rankTemplates(feed);
    if (json) io.write(JSON.stringify(report, null, 2) + '\n');
    else {
      io.write(`Template metrics: ${report.source}; minimum ${report.minimumCompletedJobs} completed jobs\n`);
      for (const row of report.templates) {
        io.write(`${row.template}: ${row.merged}/${row.completed} merged, ${row.empty} empty, ${row.incomplete} incomplete; ${row.recommendation}\n`);
      }
    }
    return 0;
  } catch {
    // Never echo snapshot contents, parser excerpts or workspace paths.
    io.write(json ? '{"error":"Invalid router snapshot"}\n' : 'Invalid router snapshot\n');
    return 2;
  }
}
