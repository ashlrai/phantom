/** Read-only host evidence: one lost slot per finished job with leftover processes. */
import {
  defaultStrayReaders,
  readStraySlots,
  STRAY_ID_PATTERN,
  type StrayReaders,
} from '../core/fleet/stray-slots.js';
import { scrubSecrets } from '../core/util/scrub.js';

export {
  defaultStrayReaders,
  defaultStrayReaders as defaultReaders,
  readStraySlots,
  STRAY_ID_PATTERN,
} from '../core/fleet/stray-slots.js';
export type {
  StrayJob,
  StrayProcess,
  StrayReaders,
  StraySlotLane,
  StraySlotStray,
  StraySlotsReport,
  StraySlotsV1,
} from '../core/fleet/stray-slots.js';

const usage = `Usage: ashlr fleet stray-slots [--json] [--check] [--lane NAME ...]
  --lane NAME  Select an exact lane; repeat to select multiple lanes (default: all).
  --check      Exit 1 for observed lost slots or unavailable evidence, 0 otherwise.
No matching jobs means no observed stray slots, not proof a provider is available.
Observation only: never sends signals, mutates slot counts, launches work or releases holds.`;

export async function cmdFleetStraySlots(args: string[], readers: StrayReaders = defaultStrayReaders): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return 0; }
  let json = false;
  let check = false;
  const selectedLanes = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--check' && !check) check = true;
    else if (arg === '--lane' && i + 1 < args.length && !args[i + 1].startsWith('--') && STRAY_ID_PATTERN.test(args[i + 1])) selectedLanes.add(args[++i]);
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  try {
    const report = await readStraySlots(readers, selectedLanes.size ? selectedLanes : undefined);
    const slotsLost = report.lanes.reduce((sum, lane) => sum + lane.slotsLost, 0);
    const summary = { slotsLost, selectedLanes: [...selectedLanes].sort().map(scrubSecrets), passed: slotsLost === 0 };
    const details = report.lanes.map(lane =>
      `${lane.lane}: ${lane.slotsLost} slots lost\n${lane.strays.map(p => `  ${p.job} pid=${p.pid} age=${p.ageSeconds ?? 'unknown'}s`).join('\n')}`).join('\n');
    console.log(json ? JSON.stringify(check ? { ...report, summary } : report) : check
      ? `${details}${details ? '\n' : ''}Observed ${slotsLost} lost slot(s): ${summary.passed ? 'PASS' : 'FAIL'}.\nNo matching jobs means no observed stray slots, not proof a provider is available.`
      : details);
    return check && slotsLost > 0 ? 1 : 0;
  } catch {
    process.stderr.write('error: fleet stray-slots unavailable\n'); return 1;
  }
}
