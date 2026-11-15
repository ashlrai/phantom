/**
 * `ashlr fleet waste-incident` — posts the `fleet waste-risk` projection to the
 * shared fleet bus. Every lane projected 'high' waste gets one 'waste-high' P1
 * envelope per clock hour; the hour bucket in the id makes a rerun a
 * 'duplicate'. Without --apply this is a dry run that writes nothing. Advisory
 * only: no lane target, hold or dispatch file is touched.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { appendBusInbox } from '../core/fleet/bus-inbox.js';
import {
  buildWasteIncidentEnvelope, planWasteIncidents, postWasteIncidents, type WasteIncidentPost,
} from '../core/fleet/waste-incident.js';
import { readWasteRiskInputs } from '../core/resources/waste-risk-read.js';
import { projectWasteRisk } from '../core/resources/waste-risk.js';

const usage = `Usage: ashlr fleet waste-incident [--json] [--apply] [--runs-dir <abs>]
Without --apply this is a dry run: it prints the incidents it would post and
writes nothing. With --apply every high-waste lane gets one 'waste-high' P1
envelope on the shared fleet bus, deduped per clock hour. Advisory only.
--runs-dir roots both the waste evidence and the bus store under that
directory; without it the canonical stores are used.`;

interface Dependencies {
  read?: typeof readWasteRiskInputs;
  now?: () => number;
  post?: typeof appendBusInbox;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdFleetWasteIncident(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  let json = false, apply = false, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  const nowMs = (deps.now ?? Date.now)();
  let rows;
  try {
    const inputs = await (deps.read ?? readWasteRiskInputs)(runsDir ?? join(homedir(), '.ashlr-runs'), new Date(nowMs).toISOString());
    rows = inputs.map(projectWasteRisk);
  } catch {
    error('fleet waste-incident: waste-risk evidence unavailable');
    return 1;
  }
  const high = planWasteIncidents(rows);
  const planned = high.map(row => {
    const envelope = buildWasteIncidentEnvelope(row, nowMs);
    return { id: envelope.id, ...envelope.body };
  });
  const posted: WasteIncidentPost[] | null = apply
    ? postWasteIncidents(rows, nowMs, deps.post ?? appendBusInbox,
      { now: () => nowMs, ...(runsDir === undefined ? {} : { root: runsDir }) })
    : null;
  if (json) {
    output(JSON.stringify({ schema: 'fleet.waste-incident.v1', planned, posted }));
  } else {
    const lines = [`fleet waste-incident: ${apply ? 'APPLIED' : 'DRY-RUN — no changes made'}`];
    if (planned.length === 0) lines.push('  no high-waste lanes');
    if (posted === null) for (const row of planned) lines.push(`  ${row.text}`);
    else for (const post of posted) lines.push(`  ${post.lane}: ${post.status}`);
    output(lines.join('\n'));
  }
  return 0;
}
