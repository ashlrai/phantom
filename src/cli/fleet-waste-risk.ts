import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadConfigReadOnly } from '../core/config.js';
import { readWasteRiskInputs } from '../core/resources/waste-risk-read.js';
import { projectWasteRisk, type WasteRiskProjection } from '../core/resources/waste-risk.js';
import { notifyWasteRiskTransition } from '../core/resources/waste-risk-notify.js';

export interface WasteRiskDeps {
  read?: typeof readWasteRiskInputs;
  notify?: typeof notifyWasteRiskTransition;
  config?: typeof loadConfigReadOnly;
  now?: () => string;
}
export async function cmdFleetWasteRisk(args: string[], deps: WasteRiskDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet waste-risk [--json] [--notify] [--runs-dir <abs>] — advisory only');
    return 0;
  }
  let runsDir = join(homedir(), '.ashlr-runs');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs-dir' && args[i + 1] && isAbsolute(args[i + 1]!)) runsDir = args[++i]!;
    else if (!['--json', '--notify'].includes(args[i]!)) return 2;
  }
  try {
    const lanes = (await (deps.read ?? readWasteRiskInputs)(runsDir, (deps.now ?? (() => new Date().toISOString()))())).map(projectWasteRisk);
    if (args.includes('--notify')) {
      const path = join(runsDir, 'queue/waste-risk-last.json');
      let previous: WasteRiskProjection[] = [];
      try {
        const snapshot: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(snapshot)) throw new Error('invalid snapshot');
        previous = snapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const cfg = (deps.config ?? loadConfigReadOnly)();
      for (const row of lanes) await (deps.notify ?? notifyWasteRiskTransition)(previous.find(p => p.lane === row.lane), row, cfg);
      await mkdir(join(runsDir, 'queue'), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(lanes), { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
      finally { await unlink(temp).catch(() => {}); }
    }
    const rank = { high: 0, medium: 1, low: 2, unknown: 3 };
    lanes.sort((a, b) => rank[a.waste_risk] - rank[b.waste_risk] || a.lane.localeCompare(b.lane));
    console.log(args.includes('--json') ? JSON.stringify({ schema: 'fleet.waste-risk.v1', lanes }) : lanes.map(l => `${l.lane}: ${l.waste_risk}; unused=${l.projected_unused_at_reset ?? 'unknown'}; reset=${l.reset_at ?? 'unknown'}; target=${l.recommended_target ?? 'unknown'}`).join('\n'));
    return 0;
  } catch { console.error('fleet waste-risk: evidence or notification snapshot unavailable'); return 1; }
}
