/** Shared child-process PATH construction and verification memory budgets. */
import { availableParallelism, freemem } from 'node:os';
import { delimiter, join } from 'node:path';

export function commonToolBinPaths(home = process.env.HOME ?? process.env.USERPROFILE ?? ''): string[] {
  return [
    ...(home ? [
      join(home, '.local', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.bun', 'bin'),
    ] : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

export function buildToolPath(opts?: {
  prepend?: string[];
  home?: string;
  basePath?: string;
  separator?: string;
}): string {
  const separator = opts?.separator ?? delimiter;
  const basePath = opts?.basePath ?? process.env.PATH ?? '';
  const entries = [
    ...(opts?.prepend ?? []),
    ...commonToolBinPaths(opts?.home),
    ...basePath.split(separator),
  ].filter((entry) => entry.length > 0);
  return [...new Set(entries)].join(separator);
}

/** Verification job memory policy. Independent of provider/model display tiers. */
export const JOB_MEMORY_LIMITS = Object.freeze({
  typecheck: Object.freeze({ maxOldSpaceMiB: 4096 }),
  lint: Object.freeze({ maxOldSpaceMiB: 2048 }),
  build: Object.freeze({ maxOldSpaceMiB: 4096 }),
  test: Object.freeze({ maxOldSpaceMiB: 1024 }),
});

export type MemoryJobClass = keyof typeof JOB_MEMORY_LIMITS;

export interface JobMemoryUsage {
  jobClass: MemoryJobClass;
  /** Largest observed process peak, not the simultaneous process-tree RSS.
   * Missing/abrupt-exit evidence is unknown, never zero. Self-reported only. */
  peakRssKiB: number | null;
  processes: Array<{ pid: number; peakRssKiB: number }>;
}

/** Keep reserved telemetry out of the command-output contract. Capture a
 * bounded set of valid receipts before the normal tool-text rendering cap. */
export function collectJobMemory(output: string, jobClass: MemoryJobClass): { output: string; memoryUsage: JobMemoryUsage } {
  const processes = new Map<number, number>();
  let peakRssKiB: number | null = null;
  // A command may end its output without a newline before the reserved record.
  const clean = output.replace(/\[job-memory\] (.+)(?:\r?\n|$)/g, (line, json: string) => {
    try {
      const row = JSON.parse(json);
      if (row.schema !== 'phantom-job-memory/v1' || row.jobClass !== jobClass ||
        !Number.isSafeInteger(row.pid) || row.pid <= 0 ||
        !Number.isSafeInteger(row.peakRssKiB) || row.peakRssKiB <= 0) return line;
      peakRssKiB = Math.max(peakRssKiB ?? 0, row.peakRssKiB);
      if (processes.size < 128 || processes.has(row.pid)) {
        processes.set(row.pid, Math.max(processes.get(row.pid) ?? 0, row.peakRssKiB));
      }
      return '';
    } catch { return line; }
  });
  const peaks = [...processes].map(([pid, peakRssKiB]) => ({ pid, peakRssKiB }));
  return { output: clean, memoryUsage: { jobClass, peakRssKiB, processes: peaks } };
}

// Reserve space for the coordinator and native allocations outside V8's heap.
export const TEST_COORDINATOR_RESERVE_MIB = 512;
export const TEST_WORKER_OVERHEAD_MIB = 256;
export const TEST_MAX_WORKERS = 4;
const MIB = 1024 * 1024;

/** One worker is the conservative floor, including when memory is unknown.
 * This is an admission estimate, not a whole-process or host RSS hard limit. */
export function memoryBoundedWorkers(freeBytes: number, cpuCount: number): number {
  if (!Number.isFinite(freeBytes) || freeBytes < 0 || !Number.isFinite(cpuCount) || cpuCount < 1) return 1;
  const workerBytes = (JOB_MEMORY_LIMITS.test.maxOldSpaceMiB + TEST_WORKER_OVERHEAD_MIB) * MIB;
  return Math.max(1, Math.min(TEST_MAX_WORKERS, Math.floor(cpuCount),
    Math.floor((freeBytes - TEST_COORDINATOR_RESERVE_MIB * MIB) / workerBytes)));
}

/** Fixed, host-owned startup code. No paths, argv, credentials or ambient
 * options enter the recorder. Each Node process reports its own lifetime peak,
 * in KiB on every supported platform. SIGKILL/OOM may leave no exit receipt.
 * Worker threads share the process RSS, so only the main thread records it. */
function rssRecorder(jobClass: MemoryJobClass): string {
  // Synchronous builtin access avoids resolving an ESM dependency graph in
  // every short-lived compiler/test child (Node >=22.15 supports this API).
  return `const { writeSync } = process.getBuiltinModule('fs');
const { isMainThread } = process.getBuiltinModule('worker_threads');
const resourceUsage = process.resourceUsage.bind(process);
if (isMainThread) process.once('exit', () => {
  try { writeSync(2, '[job-memory] ' + JSON.stringify({
    schema: 'phantom-job-memory/v1', jobClass: ${JSON.stringify(jobClass)},
    pid: process.pid, peakRssKiB: resourceUsage().maxRSS
  }) + '\\n'); } catch { /* Telemetry cannot turn success into failure. */ }
});`;
}

/** Apply only trusted options, after the caller's existing environment gates.
 * Replacing ambient NODE_OPTIONS also removes duplicate heap flags/preloads.
 * Node descendants (including tsc and Vitest forks) inherit both the cap and
 * recorder; records are per-process peaks, never a summed job-tree peak. */
export function memoryJobEnv(base: NodeJS.ProcessEnv, jobClass: MemoryJobClass): NodeJS.ProcessEnv {
  if (!Object.hasOwn(JOB_MEMORY_LIMITS, jobClass)) throw new Error('Unknown memory job class');
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (['NODE_OPTIONS', 'NPM_CONFIG_NODE_OPTIONS'].includes(key.toUpperCase())) delete env[key];
  }
  const recorder = `data:text/javascript,${encodeURIComponent(rssRecorder(jobClass))}`;
  env.NODE_OPTIONS = `--max-old-space-size=${JOB_MEMORY_LIMITS[jobClass].maxOldSpaceMiB} --import=${recorder}`;
  return env;
}

/** Preserve stricter caller caps. Inline Vitest projects override the root
 * maxWorkers flag; the unit lane has an existing environment control and a
 * one-worker budget must also disable file parallelism for the real-I/O lane. */
export function boundedVitestJob(
  base: NodeJS.ProcessEnv,
  args: readonly string[],
  freeBytes = Math.min(freemem(), process.availableMemory()),
  cpuCount = availableParallelism(),
): { env: NodeJS.ProcessEnv; args: string[]; maxWorkers: number } {
  let maxWorkers = memoryBoundedWorkers(freeBytes, cpuCount);
  const configuredUnitWorkers = Number(base.ASHLR_VITEST_UNIT_MAX_WORKERS);
  const forwarded: string[] = [];
  const separator = args.indexOf('--');
  const optionCount = separator === -1 ? args.length : separator;
  const suffix = separator === -1 ? [] : args.slice(separator);
  for (let i = 0; i < optionCount; i++) {
    const arg = args[i]!;
    if (arg === '--pool' || arg.startsWith('--pool=')) {
      const value = arg === '--pool' ? args[++i] : arg.slice('--pool='.length);
      if (i >= optionCount || !value || value.startsWith('--')) throw new Error('pool requires a value');
      continue;
    }
    if (/^--(?:maxWorkers|max-workers)(?:=|$)/.test(arg)) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      const percent = typeof value === 'string' && /^(?:[1-9]\d?|100)%$/.test(value)
        ? Number(value.slice(0, -1)) : null;
      const requested = percent === null ? Number(value) : Math.max(1, Math.floor(cpuCount * percent / 100));
      if (i >= optionCount || !Number.isInteger(requested) || requested < 1) throw new Error('maxWorkers must be a positive integer or 1%-100%');
      maxWorkers = Math.min(maxWorkers, requested);
      continue;
    }
    forwarded.push(arg);
  }
  if (maxWorkers === 1) {
    // Remove positive aliases so a later CLI override cannot re-enable files.
    for (let i = forwarded.length - 1; i >= 0; i--) {
      if (/^--fileParallelism(?:=|$)|^--file-parallelism(?:=|$)/.test(forwarded[i]!)) {
        // Vitest camel-cases aliases after parsing booleans: kebab false
        // spellings remain the truthy string "false", so normalize them.
        if (forwarded[i] === '--fileParallelism=false' ||
          (forwarded[i] === '--fileParallelism' && forwarded[i + 1] === 'false')) continue;
        if (forwarded[i] === '--fileParallelism' || forwarded[i] === '--file-parallelism') {
          if (forwarded[i + 1] === 'true' || forwarded[i + 1] === 'false') forwarded.splice(i + 1, 1);
        }
        forwarded.splice(i, 1);
      }
    }
    if (!forwarded.some(arg => arg === '--no-file-parallelism' || /^--fileParallelism(?:=false|$)/.test(arg))) {
      forwarded.push('--no-file-parallelism');
    }
  }
  const unitWorkers = Number.isInteger(configuredUnitWorkers) && configuredUnitWorkers >= 1 && configuredUnitWorkers <= 4
    ? Math.min(maxWorkers, configuredUnitWorkers) : maxWorkers;
  return {
    env: { ...memoryJobEnv(base, 'test'), ASHLR_VITEST_UNIT_MAX_WORKERS: String(unitWorkers) },
    args: [...forwarded, '--pool=forks', `--maxWorkers=${maxWorkers}`, ...suffix],
    maxWorkers,
  };
}
