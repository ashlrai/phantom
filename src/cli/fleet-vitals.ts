import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readSource } from '../core/fleet/runs-parked-queue.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const number = z.number().finite();
const diskSchema = z.object({
  sampled_at: number, previous_sampled_at: number.nullable(), free_gb: number.nonnegative(),
  directories: z.array(z.object({ path: z.string(), size_gb: number.nonnegative().nullable(), delta_gb: number.nullable() })),
  growth_gb_per_h: number.nullable(), hours_to_reuse_only: number.nonnegative().nullable(), timed_out: z.boolean(),
});

const leaderLivenessSchema = z.object({
  age_hours: z.number().nullable(),
  mismatch_count: z.number(),
  flagged_red: z.boolean(),
});

export interface FleetVitals {
  schema: 'fleet.vitals.v1';
  status: 'ok' | 'partial' | 'stale' | 'unknown';
  disk: z.infer<typeof diskSchema> | null;
  leader_liveness: z.infer<typeof leaderLivenessSchema> | null;
}

/** Read the bounded host sample; no traversal or cleanup happens in this view. */
export async function readFleetVitals(root = join(homedir(), '.ashlr-runs'), now = Date.now()): Promise<FleetVitals> {
  const report: FleetVitals = { schema: 'fleet.vitals.v1', status: 'unknown', disk: null, leader_liveness: null };
  try {
    // Read disk information first (existing logic)
    const source = await readSource(join(root, 'queue/disk-growth.json'), 1024 * 1024, false);
    if (source.state !== 'healthy') return report;
    const disk = diskSchema.parse(JSON.parse(source.text));
    if (disk.sampled_at * 1000 > now) return report;
    const diskStatus = now - disk.sampled_at * 1000 > 900_000 ? 'stale'
      : disk.timed_out || disk.directories.some(row => row.size_gb === null) ? 'partial' : 'ok';

    // Determine leader liveness
    let leaderLiveness: z.infer<typeof leaderLivenessSchema> | null = null;

    try {
      // Check PLAN-LOG.md for most recent "## " entry
      const planLogPath = join(root, 'leader/PLAN-LOG.md');
      const fs = await import('node:fs/promises');
      let planLogContent = '';
      try {
        planLogContent = await fs.readFile(planLogPath, 'utf-8');
      } catch (e) {
        // If PLAN-LOG.md does not exist, we'll set appropriate defaults
      }

      let lastPlanLogEntryAge = null;
      if (planLogContent) {
        // Find the newest "## " line (the most recent timestamp)
        const lines = planLogContent.split('\n');
        let mostRecentTimestamp = null;

        // Scan for timestamp lines that start with ##
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          // Look for lines that match timestamp format like: ## 2026-10-29 ~13:05 ET
          const timestampMatch = line.match(/^## (\d{4}-\d{2}-\d{2}) ~(\d{1,2}:\d{2}) ET/);
          if (timestampMatch) {
            const [, datePart, timePart] = timestampMatch;
            const fullDateTime = `${datePart}T${timePart.replace(':', ':')}:00`;
            const timestamp = new Date(fullDateTime).getTime();
            if (timestamp > 0) {
              mostRecentTimestamp = timestamp;
              break;
            }
          }
        }

        if (mostRecentTimestamp !== null) {
          lastPlanLogEntryAge = (now - mostRecentTimestamp) / (1000 * 60 * 60); // hours
        }
      }

      // Count "OPUS-LEADER loop sha mismatch, refused" in dispatch-events.log from last 24h
      let mismatchCount = 0;
      const dispatchEventsPath = join(root, 'queue/dispatch-events.log');
      try {
        const dispatchContent = await fs.readFile(dispatchEventsPath, 'utf-8');
        const dispatchLines = dispatchContent.split('\n');
        
        // Get timestamp for the last 24 hours
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

        for (const line of dispatchLines) {
          // Check if the line contains the error and is recent enough
          if (line.includes("OPUS-LEADER loop sha mismatch, refused")) {
            // Look for timestamp prefix (common log format with timestamp like "2026-10-29T13:05:45.000Z")
            const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z)/);
            if (timestampMatch) {
              const timestamp = new Date(timestampMatch[1]).getTime();
              if (timestamp >= twentyFourHoursAgo) {
                mismatchCount++;
              }
            }
            // If we can't find timestamp, assume it's recent enough if it matches pattern
            // This handles log formats where the timestamp may not be present
          }
        }
      } catch (e) {
        // If dispatch-events.log doesn't exist or can't be read, keep count at 0
      }

      // Determine if flagged red (leader not writing for more than 2 hours)
      const flaggedRed = lastPlanLogEntryAge !== null && lastPlanLogEntryAge > 2;

      leaderLiveness = {
        age_hours: lastPlanLogEntryAge,
        mismatch_count: mismatchCount,
        flagged_red: flaggedRed
      };
    } catch (e) {
      // If we can't read leader liveness, set to null
      leaderLiveness = null;
    }

    return { 
      ...report, 
      disk, 
      status: diskStatus,
      leader_liveness: leaderLiveness
    };
  } catch { return report; }
}

export async function cmdFleetVitals(args: string[]): Promise<number> {
  const usage = 'Usage: phm fleet vitals [--json]\nDisk sizes and change since the previous host sample. Missing readings are unknown.';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const report = sanitizePublicJson(await readFleetVitals()) as FleetVitals;
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else {
    console.log(`Disk growth: ${report.status}; free ${report.disk?.free_gb ?? 'unknown'} GB`);
    for (const row of report.disk?.directories ?? [])
      console.log(`${row.path}: ${row.size_gb ?? 'unknown'} GB; change ${row.delta_gb ?? 'unknown'} GB`);
    
    // Output leader liveness data if available
    if (report.leader_liveness !== null) {
      const { age_hours, mismatch_count, flagged_red } = report.leader_liveness;
      const ageText = age_hours === null ? 'unknown' : `${age_hours.toFixed(1)}h`;
      const flagText = flagged_red ? ' (RED)' : '';
      console.log(`Leader liveness: age ${ageText}, mismatches ${mismatch_count}${flagText}`);
    }
  }
  return 0;
}
