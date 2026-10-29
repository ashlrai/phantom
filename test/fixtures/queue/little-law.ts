import type { QueueEvent } from '../../../src/core/observability/queue-metrics.js';

// Three jobs, 12 busy seconds, 18 job-seconds of occupancy in a 20s window.
// B waits 3s; C waits 3s. Idle tails must count in the observation duration.
export const littleLawLog = [
  { jobId: 'a', kind: 'arrival', atMs: 1_000 },
  { jobId: 'a', kind: 'start', atMs: 1_000 },
  { jobId: 'b', kind: 'arrival', atMs: 2_000 },
  { jobId: 'a', kind: 'complete', atMs: 5_000 },
  { jobId: 'b', kind: 'start', atMs: 5_000 },
  { jobId: 'c', kind: 'arrival', atMs: 6_000 },
  { jobId: 'b', kind: 'complete', atMs: 9_000 },
  { jobId: 'c', kind: 'start', atMs: 9_000 },
  { jobId: 'c', kind: 'complete', atMs: 13_000 },
] as const satisfies readonly QueueEvent[];
