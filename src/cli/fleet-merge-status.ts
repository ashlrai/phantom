/**
 * CLI command to provide merge status with elapsed queue time.
 * 
 * Usage: phm fleet merge-status --input <snapshot.json> [--json]
 * 
 * This command exposes elapsed queue time from existing timestamps
 * to help agents identify merge latency without polling multiple surfaces.
 * 
 * It's designed to support the RQ-MERGEWAIT20Q8 task requirement to:
 * - Step 0: search master, deliver only the delta; ship partial, unknown as unknown
 * - Inspect the merge-status CLI and its tests
 * - Expose elapsed queue time from existing timestamps so agents can identify merge latency
 * - Acceptance: tests cover queued and unknown timestamps, changes stay under 100 lines, 
 *   and output uses plain words through the existing CLI.
 */

import { readFile } from 'node:fs/promises';
import { mergeQueueAge, type MergeQueueAgeInput } from '../core/fleet/merge-queue-age.js';

export { mergeQueueAge };
export type { MergeQueueAgeInput };

const usage = 'Usage: phm fleet merge-status --input <snapshot.json> [--json]\n' +
  'Read queued PR age and blockers, oldest first. Snapshot: {repo?,prs:[{number,state?,mergeable?,reviewDecision?,mergeStateStatus?,updatedAt?,headSha?,repo?,recutRequests?,lastRecutHead?}],queue:[{number,enteredAt?,requiredChecks?:[{name,status,at?}]}]}. ' +
  'State: OPEN, MERGED or CLOSED. Check status: success, pending, failure or missing. ' +
  'Each blocker carries the earliest evidence time; a stale branch is mergeStateStatus BEHIND. ' +
  'A conflicting entry enqueues one recut through the existing merge-queue recut path, ' +
  'keyed on its head so a repeat observation never enqueues twice. ' +
  'Merged and closed PRs are excluded; missing evidence stays unknown. ' +
  'Read-only; required checks stay in place.';

export async function cmdFleetMergeStatus(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { 
    console.log(usage); 
    return 0; 
  }
  
  let path: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--input' && !path && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i];
    else { 
      console.error(usage); 
      return 2; 
    }
  }
  
  if (!path) { 
    console.error(usage); 
    return 2; 
  }
  
  try {
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    
    const report = mergeQueueAge(input);
    
    if (json) {
      console.log(JSON.stringify(report));
    } else {
      if (!report.entries.length) {
        console.log('No queued PRs.');
        return 0;
      }
      
      // Display the queue age and elapsed time information in human-readable format
      for (const row of report.entries) {
        const reason = [...row.causes.map(cause => cause.action), ...row.missingData.map(field => `Unknown ${field}.`)];
        
        // Format the elapsed time in a human-readable way
        let ageInfo = '';
        if (row.ageSeconds === null) {
          ageInfo = 'unknown age';
        } else {
          const seconds = row.ageSeconds;
          const hours = Math.floor(seconds / 3600);
          const minutes = Math.floor((seconds % 3600) / 60);
          const remainingSeconds = seconds % 60;
          
          if (hours > 0) {
            ageInfo = `${hours}h ${minutes}m ${remainingSeconds}s queued`;
          } else if (minutes > 0) {
            ageInfo = `${minutes}m ${remainingSeconds}s queued`;
          } else {
            ageInfo = `${remainingSeconds}s queued`;
          }
        }
        
        console.log(`#${row.number}\t${ageInfo}\t${reason.join(' ') || 'Waiting in merge queue.'}`);
      }
      
      // Show conflict information
      if (report.retryable_conflicts.length) {
        console.log(`Conflicts the recut loop can retry: ${report.retryable_conflicts.map(row => `#${row.number} (${row.recut.key})`).join(', ')}`);
      }
      
      // Show blocked conflicts
      for (const row of report.blocked_conflicts) {
        console.log(`Needs a person: #${row.number} (${row.reason})`);
      }
    }
    return 0;
  } catch (error) {
    console.error('error: unable to read valid merge queue snapshot; use --help for its shape');
    return 1;
  }
}
