import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { refreshCatalog } from '../core/routing/catalog-refresh.js';
import { catalogSchedule } from '../core/routing/catalog-schedule.js';
import { installScheduleUnits } from './steward.js';

export const ROUTER_CATALOG_USAGE = `Usage: phm router catalog refresh [--json] [--apply] [--include-seats] [--out-dir DIR] [--catalog FILE]
       phm router catalog schedule [--install] [--hour 0-23]`;

interface Deps {
  out: (text: string) => void;
  err: (text: string) => void;
  phmPath: string;
  platform: NodeJS.Platform;
  built: () => boolean;
  installUnits: typeof installScheduleUnits;
  refresh: typeof refreshCatalog;
}
export async function cmdRouterCatalog(args: string[], overrides: Partial<Deps> = {}): Promise<number> {
  const deps: Deps = {
    out: console.log, err: console.error,
    phmPath: fileURLToPath(new URL('../../bin/ashlr', import.meta.url)), platform: process.platform,
    built: () => existsSync(fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))),
    installUnits: installScheduleUnits, refresh: refreshCatalog, ...overrides,
  };
  if (args.includes('--help') || args.includes('-h')) { deps.out(ROUTER_CATALOG_USAGE); return 0; }
  const [verb, ...rest] = args;
  const flags = new Map<string, string>();
  const values = verb === 'schedule' ? ['--hour'] : ['--out-dir', '--catalog'];
  const allowed = verb === 'schedule' ? ['--install', ...values] : ['--json', '--apply', '--include-seats', ...values];
  if (!['schedule', 'refresh'].includes(verb ?? '')) { deps.err(ROUTER_CATALOG_USAGE); return 2; }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!allowed.includes(flag) || flags.has(flag)) { deps.err(ROUTER_CATALOG_USAGE); return 2; }
    let value = '';
    if (values.includes(flag)) {
      value = rest[++i] ?? '';
      if (!value || value.startsWith('-')) { deps.err(ROUTER_CATALOG_USAGE); return 2; }
    }
    flags.set(flag, value);
  }
  if (flags.has('--hour') && (!/^\d{1,2}$/.test(flags.get('--hour')!) || Number(flags.get('--hour')) > 23)) { deps.err(ROUTER_CATALOG_USAGE); return 2; }
  try {
    if (verb === 'schedule') {
      const units = catalogSchedule({ phmPath: deps.phmPath, platform: deps.platform, hour: flags.has('--hour') ? Number(flags.get('--hour')) : undefined });
      if (!flags.has('--install')) { for (const u of units) deps.out(`# ${u.path}\n${u.contents}`); return 0; }
      if (process.getuid?.() === 0) throw new Error('Install the schedule as a regular user, not root.');
      if (!deps.built()) throw new Error('Compiled CLI missing; run npm run build before installing the schedule.');
      return deps.installUnits(units, { logName: 'router-catalog.jsonl' });
    }
    const report = await deps.refresh({ apply: flags.has('--apply'), includeSeats: flags.has('--include-seats'), outDir: flags.get('--out-dir'), catalog: flags.get('--catalog') });
    deps.out(flags.has('--json') ? JSON.stringify(report) : `Catalog ${report.dryRun ? 'dry run' : 'applied'}: ${report.additions.length} additions, ${report.unseen.length} unseen, ${report.unknown.length} unknown, ${report.rejectedRules.length} rejected rules.`);
    return 0;
  } catch (error) { deps.err(`Catalog refresh failed: ${(error as Error).message}`); return 1; }
}
