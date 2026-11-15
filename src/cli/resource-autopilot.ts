/** `phm resources autopilot --json [--input FILE] [--root PATH]`: read-only lane targets. */
import { readFileSync, statfsSync } from 'node:fs';
import { budgetEntryQuota } from '../core/fabric/lane-usage-self.js';
import { compactThresholds, decideLanes, type DiskReading, type LaneInput } from '../core/resources/lane-autopilot.js';

export function diskReading(root: string): DiskReading {
  const s = statfsSync(root);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize),
    freeInodes: Number(s.ffree), totalInodes: Number(s.files) };
}

export async function cmdResourceAutopilot(args: string[]): Promise<number> {
  let input: string | null = null; let root = '/'; let json = false; let overridesPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--input' && args[i + 1]) input = args[++i]!;
    else if (a === '--root' && args[i + 1]) root = args[++i]!;
    else if (a === '--overrides' && args[i + 1]) overridesPath = args[++i]!;
    else { process.stderr.write('usage: phm resources autopilot [--json] [--input FILE] [--root PATH] [--overrides budget-overrides.json]\n'); return 2; }
  }
  let lanes: LaneInput[] = [];
  if (input) {
    try {
      const parsed = JSON.parse(readFileSync(input, 'utf8')) as { lanes?: unknown };
      if (!Array.isArray(parsed.lanes)) throw new Error('lanes missing');
      lanes = parsed.lanes as LaneInput[];
    } catch (e) {
      process.stderr.write(`autopilot: unreadable input (${(e as Error).message})\n`); return 2;
    }
  }
  let bytes;
  if (overridesPath) {
    try {
      const overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>;
      bytes = compactThresholds(overrides);
      // A quota lane with no usable reading takes the self-maintained budget entry (estimates included),
      // so an unknown or stale typed value never holds the lane when an estimate exists.
      const now = Date.now();
      lanes = lanes.map(l => {
        const q = l.quota;
        if (l.kind !== 'quota-window' || (q && q.value !== null && q.asOf !== null && now - Date.parse(q.asOf) <= q.ttlMs)) return l;
        const b = budgetEntryQuota(overrides[l.lane], now);
        return b.value ? { ...l, quota: b } : l;
      });
    } catch { process.stderr.write('autopilot: unreadable overrides\n'); return 2; }
  }
  const out = decideLanes(lanes, diskReading(root), Date.now(), bytes);
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`disk: ${out.disk}`);
    for (const l of out.lanes) console.log(`  ${l.lane}: ${l.target}${l.held ? ' (held)' : ''}  ${l.reason}`);
  }
  return 0;
}
