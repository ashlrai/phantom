import { appendFile, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { rankPrLeverage } from '../core/fleet/pr-leverage.js';
import { scrubSecrets } from '../core/util/scrub.js';
import { defaultSnapshotRoot, readPrSnapshot } from './fleet-pr-snapshot.js';

const usage = 'Usage: phm fleet pr-leverage [--input <portfolio.json>] [--jobs <jobs.jsonl>] [--day YYYY-MM-DD] [--record-delta] [--json]';

/** Default is read-only. Recording a complete UTC day explicitly opts into a local metrics append. */
export async function cmdFleetPrLeverage(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flags.has(flag) || !['--input', '--jobs', '--day', '--json', '--record-delta'].includes(flag)) { console.error(usage); return 2; }
    const value = ['--json', '--record-delta'].includes(flag) ? '' : args[++i];
    if (value === undefined || value.startsWith('--')) { console.error(usage); return 2; }
    flags.set(flag, value);
  }
  try {
    const root = defaultSnapshotRoot();
    const snapshot = await readPrSnapshot(flags.get('--input') ?? join(root, 'fleet', 'open-prs.json'));
    if (!snapshot.ok) throw new Error('snapshot unavailable');
    const jobs = await readFile(flags.get('--jobs') ?? join(root, 'metrics', 'jobs.jsonl'), 'utf8').catch(() => null);
    const report = rankPrLeverage(JSON.parse(snapshot.text), jobs, Date.now(), flags.get('--day'));
    if (flags.has('--record-delta')) {
      const directory = join(root, 'metrics');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'pr-delta.jsonl');
      const lock = await open(`${path}.lock`, 'wx', 0o600);
      try {
        const previous = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; });
        const records: typeof report.delta[] = previous.split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (records.some(row => row?.schema !== 'fleet.delta.v1')) throw new Error('invalid delta ledger');
        const latest = records.filter(row => row.day === report.delta.day && JSON.stringify(row.repos) === JSON.stringify(report.delta.repos)).at(-1);
        if (JSON.stringify(latest) !== JSON.stringify(report.delta)) await appendFile(path, `${JSON.stringify(report.delta)}\n`, { mode: 0o600 });
      } finally { await lock.close(); await unlink(`${path}.lock`); }
    }
    console.log(scrubSecrets(JSON.stringify(report, null, flags.has('--json') ? undefined : 2)));
    return 0;
  } catch { console.error('error: PR leverage input or metrics unavailable/invalid; no merge action taken'); return 1; }
}
