import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetVitals } from '../src/cli/fleet-vitals.js';

it('reads leader liveness data including plan log age and mismatch count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitals-leader-'));
  try {
    // First make sure it handles missing files gracefully
    const report = await readFleetVitals(root);
    expect(report.leader_liveness).toBeNull();
    
    // Create the leader directory and files to test leader liveness
    await mkdir(join(root, 'leader'), { recursive: true });
    await mkdir(join(root, 'queue'), { recursive: true });
    
    // Create PLAN-LOG.md with recent entries
    const planLogContent = `# Leader PLAN-LOG

## 2026-11-16 ~15:05 ET
**Review**
- First pass

## 2026-11-16 ~16:05 ET
**Dispatch**
- Work from /Users/fake/projects/phantom
  - Nested work
`;
    await writeFile(join(root, 'leader/PLAN-LOG.md'), planLogContent);
    
    // Create dispatch-events.log with recent mismatches
    const dispatchEventsContent = `2026-11-16T14:00:00.000Z INFO OPUS-LEADER loop sha mismatch, refused
2026-11-16T15:00:00.000Z INFO OPUS-LEADER loop sha mismatch, refused
2026-11-15T14:00:00.000Z INFO OPUS-LEADER loop sha mismatch, refused (old entry)
`;
    await writeFile(join(root, 'queue/dispatch-events.log'), dispatchEventsContent);
    
    // Mock current time to be about 2 hours after the log entries (to check red flag)
    const now = new Date('2026-11-16T17:05:00.000Z').getTime();
    
    // Test that leader liveness is properly computed
    const report2 = await readFleetVitals(root, now);
    
    expect(report2.leader_liveness).not.toBeNull();
    // The age should be around 2 hours (should be less than 2.5 hours)
    expect(report2.leader_liveness?.age_hours).toBeCloseTo(2, 1);
    
    // Should count 2 recent mismatches (the 3rd one is more than 24h old)
    expect(report2.leader_liveness?.mismatch_count).toBe(2);
    
    // Should be flagged red because age is > 2 hours (in our test case it's exactly 2h)
    expect(report2.leader_liveness?.flagged_red).toBe(true);
  } finally { 
    await rm(root, { recursive: true, force: true }); 
  }
});
