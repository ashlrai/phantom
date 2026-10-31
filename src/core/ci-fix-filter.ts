/**
 * CI daily-fix filter — input validation and job/test selection for the daily
 * workflow_dispatch. Security-first: allowlist regex validation, env-only pass-through,
 * zero interpolation into shell `run:` blocks.
 *
 * R7 compliance: `only_jobs` and `only_tests` pass via env with an allowlist regex
 * and are never interpolated into `run:`. The workflow binds them to env vars and
 * downstream scripts read those env vars.
 *
 * Usage from a CI script (NOT from the workflow YAML `if:` or `run:`):
 *   import { validateDispatchInputs, buildFilterConfig } from '../core/ci-fix-filter.js';
 *   const filter = buildFilterConfig({ onlyJobs: process.env.CI_ONLY_JOBS, onlyTests: process.env.CI_ONLY_TESTS });
 */

// ─── Allowlist ───────────────────────────────────────────────────────

/**
 * CI jobs that may be targeted by `only_jobs`. These are the user-facing test
 * jobs from the daily CI workflow. Infrastructure jobs (secret-shape, classify,
 * merge-gate, fixup-queue) are always required and cannot be excluded.
 */
export const ALLOWED_JOBS = [
  // Linux
  'ci',
  'site',
  'docs',
  // macOS
  'ci-shared-macos',
  'mac-general',
  'mac-isolated',
  'native-macos-broker-foundation',
  // Windows
  'windows-service-authority',
] as const;

/**
 * Infrastructure jobs that always run regardless of `only_jobs` filtering.
 * These are required for the workflow to function correctly.
 */
export const INFRA_JOBS = [
  'secret-shape',
  'classify',
  'merge-gate',
  'fixup-queue',
] as const;

/** Compiled allowlist regex for `only_jobs` validation. Matches comma-separated
 *  job names from ALLOWED_JOBS, with optional whitespace. Rejects anything else. */
export const ONLY_JOBS_REGEX = new RegExp(
  `^\\s*(?:${ALLOWED_JOBS.join('|')})(?:\\s*,\\s*(?:${ALLOWED_JOBS.join('|')}))*\\s*$`,
);

/**
 * Compiled allowlist regex for `only_tests` validation. Accepts a single line
 * of printable ASCII (test name patterns, vitest -t arguments). Rejects control
 * characters, backticks, and shell metacharacters to prevent injection.
 */
export const ONLY_TESTS_REGEX = /^[a-zA-Z0-9 _\-.\/:=+*&?()\[\]{}|@#$%!,;<>]*$/;

// ─── Types ───────────────────────────────────────────────────────────

/** Raw dispatch inputs as received from env vars. */
export interface DispatchInputs {
  /** Comma-separated job names (e.g. "ci,mac-general") or empty/undefined for all jobs. */
  onlyJobs?: string;
  /** Vitest `-t` filter pattern from the fixup line, or empty/undefined for no filter. */
  onlyTests?: string;
  /** The mac_shard input from the workflow (all or 0-6). Defaults to the daily rotation. */
  macShard?: string;
}

/** Validated filter config — safe to pass to downstream scripts. */
export interface FilterConfig {
  /** Jobs to run. Empty array means run all test jobs (infra always runs). */
  jobs: readonly string[];
  /** Test filter for vitest `-t`, or undefined to run all tests. */
  testFilter: string | undefined;
  /** Mac shard input (for mac rotation). */
  macShard: string | undefined;
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate dispatch inputs. Throws on invalid values (Security R7: fail closed).
 * Returns the raw inputs for further processing.
 */
export function validateDispatchInputs(inputs: DispatchInputs): void {
  const { onlyJobs, onlyTests } = inputs;

  // Validate only_jobs against allowlist regex
  if (onlyJobs !== undefined && onlyJobs !== '') {
    if (!ONLY_JOBS_REGEX.test(onlyJobs)) {
      throw new Error(
        `only_jobs contains disallowed values: "${onlyJobs}". ` +
        `Must be comma-separated names from: ${ALLOWED_JOBS.join(', ')}`,
      );
    }
  }

  // Validate only_tests: must be printable ASCII without shell metacharacters
  if (onlyTests !== undefined && onlyTests !== '') {
    if (!ONLY_TESTS_REGEX.test(onlyTests)) {
      throw new Error(
        `only_tests contains disallowed characters: "${onlyTests}". ` +
        `Must be printable ASCII (letters, digits, common punctuation).`,
      );
    }
    // Additional length limit to prevent abuse
    if (onlyTests.length > 512) {
      throw new Error(
        `only_tests exceeds maximum length of 512 characters (${onlyTests.length} found)`,
      );
    }
  }

  // Validate mac_shard if provided
  if (inputs.macShard !== undefined && inputs.macShard !== '' && inputs.macShard !== 'all') {
    if (!/^[0-6]$/.test(inputs.macShard)) {
      throw new Error(
        `mac_shard must be 'all' or a digit 0-6, got: "${inputs.macShard}"`,
      );
    }
  }
}

// ─── Filtering ───────────────────────────────────────────────────────

/**
 * Parse the `only_jobs` comma-separated string into an array of validated job names.
 * Returns empty array (meaning "run all") when input is empty or undefined.
 */
export function parseOnlyJobs(value: string | undefined | null): readonly string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean) as string[];
}

/**
 * Build a filter config from validated dispatch inputs.
 * When `onlyJobs` is empty, all ALLOWED_JOBS are included.
 * When `onlyJobs` is specified, only those jobs run (infra jobs still always run).
 */
export function buildFilterConfig(inputs: DispatchInputs): FilterConfig {
  const jobs = parseOnlyJobs(inputs.onlyJobs);
  return {
    jobs: jobs.length > 0 ? jobs : ALLOWED_JOBS,
    testFilter: inputs.onlyTests || undefined,
    macShard: inputs.macShard || undefined,
  };
}

/**
 * Check if a specific job should run given the filter config.
 * Infra jobs (secret-shape, classify, merge-gate, fixup-queue) always run.
 * Test jobs run only if included in the filter.
 */
export function shouldRunJob(jobName: string, config: FilterConfig): boolean {
  // Infra jobs always run
  if (INFRA_JOBS.includes(jobName as typeof INFRA_JOBS[number])) return true;
  // Test jobs run if in the selected set
  if (ALLOWED_JOBS.includes(jobName as typeof ALLOWED_JOBS[number])) {
    return config.jobs.includes(jobName);
  }
  // Unknown jobs never run
  return false;
}

/**
 * Get the list of all jobs that should run (infra + selected test jobs).
 */
export function activeJobs(config: FilterConfig): readonly string[] {
  const testJobs = config.jobs;
  return [...INFRA_JOBS, ...testJobs];
}

/**
 * Format the test filter as a vitest command-line argument.
 * Returns `[]` (no filter) or `['-t', pattern]` when a filter is set.
 */
export function vitestFilterArgs(config: FilterConfig): readonly string[] {
  if (!config.testFilter) return [];
  return ['-t', config.testFilter];
}

// ─── Dispatch command generation ─────────────────────────────────────

/**
 * Generate a `gh workflow run` command for manual dispatch.
 * This is the CLI helper that agents/CI pollers use to trigger filtered runs.
 */
export function buildDispatchCommand(opts: {
  workflow?: string;
  onlyJobs?: string;
  onlyTests?: string;
  macShard?: string;
  ref?: string;
}): string {
  const workflow = opts.workflow ?? 'ci.yml';
  const parts = ['gh', 'workflow', 'run', workflow];

  if (opts.onlyJobs) parts.push('-f', `only_jobs=${opts.onlyJobs}`);
  if (opts.onlyTests) parts.push('-f', `only_tests=${opts.onlyTests}`);
  if (opts.macShard) parts.push('-f', `mac_shard=${opts.macShard}`);
  if (opts.ref) parts.push('-r', opts.ref);

  return parts.join(' ');
}

/**
 * Parse a fixup line produced by the fixup-queue job and extract the
 * job name and mac_shard for redispatch.
 *
 * Fixup line format:
 *   - READY RQ-FIXUP-PHANTOM-{sha}-{n} (... job={job}, result={result}... mac_shard={slice} ...)
 */
export function parseFixupLine(line: string): { job: string; macShard?: string } | null {
  const jobMatch = line.match(/\bjob=([a-z][a-z0-9-]*)/);
  const macMatch = line.match(/\bmac_shard=([0-6]|all)/);
  if (!jobMatch) return null;
  return {
    job: jobMatch[1],
    macShard: macMatch?.[1] ?? undefined,
  };
}

/**
 * Aggregate fixup lines into dispatch inputs. Groups by mac_shard and collects
 * unique job names and test filters from the fixup lines.
 */
export function aggregateFixupLines(lines: string[]): DispatchInputs {
  const jobs = new Set<string>();
  let macShard: string | undefined;
  let testFilter: string | undefined;

  for (const line of lines) {
    const parsed = parseFixupLine(line);
    if (!parsed) continue;
    jobs.add(parsed.job);
    if (parsed.macShard) macShard = parsed.macShard;
  }

  return {
    onlyJobs: [...jobs].join(','),
    onlyTests: testFilter,
    macShard,
  };
}
