import type { CloudGh } from '../core/cloud/pr-actions.js';
import { readCiNightly } from '../core/fleet/ci-nightly-hotspots.js';

const usage = 'ashlr fleet ci-nightly --repo OWNER/REPO [--json]';
const minutes = (ms: number | null) => ms === null ? 'unknown' : `${(ms / 60_000).toFixed(2)} min`;

export async function cmdFleetCiNightly(args: string[], deps: { gh?: CloudGh } = {}): Promise<number> {
  let repo = '', json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(`usage: ${usage}`); return 0; }
    if (args[i] === '--json' && !json) { json = true; continue; }
    if (args[i] === '--repo' && !repo && args[i + 1]) { repo = args[++i]!; continue; }
    process.stderr.write(`Invalid argument: ${args[i]}\nusage: ${usage}\n`); return 2;
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.split('/').some(s => s === '.' || s === '..')) {
    process.stderr.write(`Invalid or missing repository\nusage: ${usage}\n`); return 2;
  }
  const report = await readCiNightly(repo, deps.gh);
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`Scheduled CI ${repo}: ${report.evidence}; run listing ${report.listing.complete ? 'complete' : 'incomplete'} (${report.listing.pages} pages, total ${report.listing.total ?? 'unknown'}).`);
    console.log('Queue delay includes dependency and concurrency waits. Runner-minutes sum observed job execution; incomplete or unknown timings are not zero. Run wall time uses GitHub run start and updated timestamps.');
    for (const run of report.runs) {
      console.log(`\n${run.workflow} (${run.path}) run ${run.id} attempt ${run.attempt}: ${run.conclusion ?? 'unknown'}, ${run.startedAt ?? 'unknown'} to ${run.completedAt ?? 'unknown'}, wall ${minutes(run.wallMs)}, observed runner-minutes ${run.observedRunnerMinutes === null ? 'unknown' : run.observedRunnerMinutes.toFixed(2)} (${run.unknownJobTiming} unknown); jobs ${run.jobs.length}/${run.jobsTotal ?? 'unknown'} (${run.jobsComplete ? 'complete' : 'incomplete'}, ${run.jobPages} pages) ${run.url}`);
      for (const job of run.jobs) {
        console.log(`  ${job.name} [${job.labels.join(', ') || 'unknown labels'}] ${job.conclusion ?? 'unknown'}: execution ${minutes(job.executionMs)}, queue ${minutes(job.queueMs)} ${job.url}`);
        for (const step of job.slowestSteps) console.log(`    ${step.name}: ${minutes(step.durationMs)} (${step.conclusion ?? 'unknown'}) ${step.url}`);
      }
    }
    console.log('\nObserved runner-minutes by cohort (owner review candidates):');
    for (const c of report.cohorts) console.log(`  ${c.workflow} / ${c.job} [${c.labels.join(', ') || 'unknown labels'}]: ${c.runnerMinutes === null ? 'unknown' : c.runnerMinutes.toFixed(2)} min, ${c.measuredSamples}/${c.samples} measured, ${c.unknownTiming} unknown, ${c.failures} failures, ${c.cancelled} cancelled, ${c.retryJobs} retry jobs; range ${minutes(c.minExecutionMs)}–${minutes(c.maxExecutionMs)}; ${c.comparison}`);
    console.log('\nLongest observed jobs:');
    for (const job of report.longestJobs) console.log(`  ${minutes(job.executionMs)} ${job.name} ${job.url}`);
    for (const error of report.errors) console.log(`Error: ${error}`);
    if (report.evidence === 'none') console.log('No scheduled-run evidence in the accessible listing.');
  }
  return report.errors.length ? 1 : 0;
}
