import { calibrationMarkdown, readCalibration, type CalibrationArm, type CalibrationReport } from '../core/routing/calibration.js';

export const ROUTER_CALIBRATION_USAGE = 'Usage: phm router-calibration --jobs <jobs.jsonl> [--posthog <runs.json>] [--baseline-jobs <jobs.jsonl> [--baseline-posthog <runs.json>]] [--json]';

type Metric = CalibrationArm['mergeRate'];
type Delta = number | null;

function difference(current: Delta, baseline: Delta): Delta {
  return current === null || baseline === null ? null : current - baseline;
}

function metricDifference(current: Metric | undefined, baseline: Metric | undefined) {
  return {
    predicted: difference(current?.predicted ?? null, baseline?.predicted ?? null),
    actual: difference(current?.actual ?? null, baseline?.actual ?? null),
  };
}

function compareReports(baseline: CalibrationReport, current: CalibrationReport, baselinePosthog: boolean, currentPosthog: boolean) {
  const names = [...new Set([...baseline.arms.map((a) => a.arm), ...current.arms.map((a) => a.arm)])].sort();
  return {
    schemaVersion: 1 as const,
    baseline: { posthogProvided: baselinePosthog, report: baseline },
    current: { posthogProvided: currentPosthog, report: current },
    comparisons: names.map((arm) => {
      const before = baseline.arms.find((a) => a.arm === arm);
      const after = current.arms.find((a) => a.arm === arm);
      return {
        arm,
        population: before && after ? 'both' : before ? 'baseline-only' : 'current-only',
        delta: {
          mergeRate: metricDifference(after?.mergeRate, before?.mergeRate),
          brier: difference(after?.brier ?? null, before?.brier ?? null),
          tokens: metricDifference(after?.tokens, before?.tokens),
          wallTimeMs: metricDifference(after?.wallTimeMs, before?.wallTimeMs),
        },
      };
    }),
  };
}

function comparisonMarkdown(comparison: ReturnType<typeof compareReports>): string {
  const format = (n: Delta): string => n === null ? 'n/a' : Number(n.toFixed(4)).toString();
  const metric = (m: ReturnType<typeof metricDifference>): string => `${format(m.predicted)} / ${format(m.actual)}`;
  const lines = [
    '# Router calibration comparison', '',
    'Deltas are current minus baseline; predicted / actual values use each report’s paired jobs. Brier uses merge-rate paired jobs.',
    'Populations and denominators can differ, including when counts match; differences do not establish causation.', '',
    `## Baseline (PostHog ${comparison.baseline.posthogProvided ? 'provided' : 'not provided'})`, '',
    calibrationMarkdown(comparison.baseline.report).replace(/^# Router calibration\n\n/, '').trimEnd(), '',
    `## Current (PostHog ${comparison.current.posthogProvided ? 'provided' : 'not provided'})`, '',
    calibrationMarkdown(comparison.current.report).replace(/^# Router calibration\n\n/, '').trimEnd(), '',
    '## Deltas by arm', '',
    '| Arm | Population | Merge rate | Brier | Tokens | Wall time ms |',
    '| --- | --- | --- | ---: | --- | --- |',
  ];
  for (const item of comparison.comparisons) {
    const arm = item.arm.replace(/[|\\\r\n]/g, ' ');
    lines.push(`| ${arm} | ${item.population} | ${metric(item.delta.mergeRate)} | ${format(item.delta.brier)} | ${metric(item.delta.tokens)} | ${metric(item.delta.wallTimeMs)} |`);
  }
  return lines.join('\n');
}

export async function cmdRouterCalibration(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(ROUTER_CALIBRATION_USAGE); return 0; }
  let jobs: string | undefined; let posthog: string | undefined;
  let baselineJobs: string | undefined; let baselinePosthog: string | undefined; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) { json = true; continue; }
    if ((arg === '--jobs' && jobs === undefined) || (arg === '--posthog' && posthog === undefined) ||
        (arg === '--baseline-jobs' && baselineJobs === undefined) || (arg === '--baseline-posthog' && baselinePosthog === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(ROUTER_CALIBRATION_USAGE); return 2; }
      if (arg === '--jobs') jobs = value;
      else if (arg === '--posthog') posthog = value;
      else if (arg === '--baseline-jobs') baselineJobs = value;
      else baselinePosthog = value;
      continue;
    }
    console.error(ROUTER_CALIBRATION_USAGE); return 2;
  }
  if (!jobs || (baselinePosthog && !baselineJobs)) { console.error(ROUTER_CALIBRATION_USAGE); return 2; }
  try {
    const report = readCalibration(jobs, posthog);
    if (baselineJobs) {
      const baseline = readCalibration(baselineJobs, baselinePosthog);
      const comparison = compareReports(baseline, report, baselinePosthog !== undefined, posthog !== undefined);
      console.log(json ? JSON.stringify(comparison, null, 2) : comparisonMarkdown(comparison));
    } else {
      console.log(json ? JSON.stringify(report, null, 2) : calibrationMarkdown(report).trimEnd());
    }
    return 0;
  } catch (error) {
    // Input contents and paths may be private; do not echo filesystem errors.
    const message = error instanceof Error && !('code' in error) ? error.message : 'Could not read input file';
    console.error(`error: ${message}`); return 1;
  }
}
