import { calibrationMarkdown, readCalibration } from '../core/routing/calibration.js';

export const ROUTER_CALIBRATION_USAGE = 'Usage: phm router-calibration --jobs <jobs.jsonl> [--posthog <runs.json>] [--json]';
export async function cmdRouterCalibration(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(ROUTER_CALIBRATION_USAGE); return 0; }
  let jobs: string | undefined; let posthog: string | undefined; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) { json = true; continue; }
    if ((arg === '--jobs' && jobs === undefined) || (arg === '--posthog' && posthog === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(ROUTER_CALIBRATION_USAGE); return 2; }
      if (arg === '--jobs') jobs = value; else posthog = value;
      continue;
    }
    console.error(ROUTER_CALIBRATION_USAGE); return 2;
  }
  if (!jobs) { console.error(ROUTER_CALIBRATION_USAGE); return 2; }
  try {
    const report = readCalibration(jobs, posthog);
    console.log(json ? JSON.stringify(report, null, 2) : calibrationMarkdown(report).trimEnd());
    return 0;
  } catch (error) {
    // Input contents and paths may be private; do not echo filesystem errors.
    const message = error instanceof Error && !('code' in error) ? error.message : 'Could not read input file';
    console.error(`error: ${message}`); return 1;
  }
}
