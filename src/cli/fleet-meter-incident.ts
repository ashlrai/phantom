/**
 * `ashlr fleet meter-incident` — turns the read-only `fleet meter-drop`
 * report into incidents on the shared fleet bus. Every provider whose meter
 * stayed flat while its lane ran jobs ('flat_with_work') gets one 'meter-flat'
 * P1 envelope per clock hour; the hour bucket inside the envelope id makes a
 * rerun inside the same hour a 'duplicate', not a second incident. Without
 * --apply this is a dry run: it prints the incidents it would post and writes
 * nothing.
 */
import { isAbsolute } from 'node:path';
import { appendBusInbox } from '../core/fleet/bus-inbox.js';
import {
  buildMeterIncidentEnvelope, planMeterIncidents, postMeterIncidents,
  type MeterIncidentPost,
} from '../core/fleet/meter-incident.js';
import { defaultLaneTruthReaders, type LaneTruthReaders } from './fleet-lane-truth.js';
import { readMeterDrop } from './fleet-meter-drop.js';

const usage = `Usage: ashlr fleet meter-incident [--json] [--apply] [--runs-dir <abs>]
Without --apply this is a dry run: it prints the incidents it would post and
writes nothing. With --apply every 'flat_with_work' provider gets one
'meter-flat' P1 envelope on the shared fleet bus, deduped per clock hour.
--runs-dir roots the bus store under that directory like the other
bus-posting verbs' dir flags; without it the canonical store is used.`;

interface Dependencies {
  readers?: LaneTruthReaders;
  now?: () => number;
  post?: typeof appendBusInbox;
}

export async function cmdFleetMeterIncident(args: string[], deps: Dependencies = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const invalid = (): number => { console.error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
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
  const now = deps.now ?? Date.now;
  const nowMs = now();
  let report;
  try {
    report = await readMeterDrop(deps.readers ?? defaultLaneTruthReaders(), nowMs);
  } catch {
    console.error('fleet meter-incident: meter evidence unavailable');
    return 1;
  }
  const planned = planMeterIncidents(report).map(provider => {
    const envelope = buildMeterIncidentEnvelope(provider, nowMs);
    return { id: envelope.id, ...envelope.body };
  });
  // --runs-dir is the bus store root here, the same passthrough the other
  // bus-posting verbs give their dir flag; absent, the canonical store posts.
  const posted: MeterIncidentPost[] | null = apply
    ? postMeterIncidents(report, nowMs, deps.post ?? appendBusInbox,
      { now: () => nowMs, ...(runsDir === undefined ? {} : { root: runsDir }) })
    : null;
  if (json) {
    console.log(JSON.stringify({ schema: 'fleet.meter-incident.v1', planned, posted }));
  } else {
    const lines = [`fleet meter-incident: ${apply ? 'APPLIED' : 'DRY-RUN — no changes made'}`];
    if (planned.length === 0) lines.push('  no flat meters with running jobs');
    if (posted === null) for (const row of planned) lines.push(`  ${row.text}`);
    else for (const post of posted) lines.push(`  ${post.provider}: ${post.status}`);
    console.log(lines.join('\n'));
  }
  return 0;
}
