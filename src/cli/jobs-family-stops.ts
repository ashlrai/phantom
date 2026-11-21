import { runsRoot } from '../core/metrics/loop-collect.js';
import { familyStopLine, pruneFamilyStops } from '../core/fleet/empty-family-stops.js';
export async function cmdJobsFamilyStops(args: string[]): Promise<number> {
  if (args.some(a => !['--json', '--apply'].includes(a))) { console.error('Usage: phm jobs family-stops [--json] [--apply]'); return 2; }
  try {
    const r = await pruneFamilyStops(runsRoot(), args.includes('--apply'));
    console.log(args.includes('--json') ? JSON.stringify(r) : [...(r.known ? (r.stops.length ? r.stops.map(familyStopLine) : ['No stopped families.']) : ['Family stops unknown: jobs ledger unreadable.']), ...r.removed.map(id => `${r.dry_run ? 'Would remove' : 'Removed'} ${id}`), `${r.removed.length} queued jobs ${r.dry_run ? 'would be removed; add --apply' : 'removed'}.`].join('\n'));
    return r.known ? 0 : 1;
  } catch { console.error('Family stops unavailable; queue may be busy.'); return 1; }
}
