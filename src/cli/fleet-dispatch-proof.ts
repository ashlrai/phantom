/** Read-only comparison of dispatch intent and independently observed job claims. */
import { isAbsolute } from 'node:path';
import { readDispatchManifestEventsDetailed } from '../core/fleet/dispatch-manifest.js';
import { summarizeDispatchManifestEvidence } from '../core/fleet/dispatch-manifest-summary.js';
import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';

export async function readDispatchProof(runsDir?: string) {
  const manifests = readDispatchManifestEventsDetailed({ inspectionOnly: true });
  const summary = summarizeDispatchManifestEvidence(manifests);
  const runs = await readFleetRunsDirState({ runsDir });
  const groups = new Map<string, typeof manifests.events>();
  for (const event of manifests.events) {
    const group = groups.get(event.manifestId) ?? [];
    group.push(event);
    groups.set(event.manifestId, group);
  }
  // Use the summary's value-based conflict policy before joining any rows.
  const intent = [...groups.values()].flatMap(events =>
    summarizeDispatchManifestEvidence({ ...manifests, events }).conflictingManifests ? [] : [events[0]!]);
  const observedClaims = runs.claimed;
  const claimsByJob = new Map<string, typeof observedClaims>();
  for (const claim of observedClaims) {
    const group = claimsByJob.get(claim.job) ?? [];
    group.push(claim);
    claimsByJob.set(claim.job, group);
  }
  const assignments = intent.filter(event => !event.dryRun).flatMap(event =>
    event.assignments.map(assignment => ({ manifestId: event.manifestId,
      itemId: assignment.itemId, attemptId: assignment.attemptId ?? null, backend: assignment.backend })));
  const matches = assignments.flatMap(assignment => (claimsByJob.get(assignment.itemId) ?? [])
    .map(claim => ({ ...assignment, claim, evidence: 'exact-item-job-id' as const })));
  const unmatchedIntent = assignments.filter(assignment => !claimsByJob.has(assignment.itemId));
  const assignedIds = new Set(assignments.map(assignment => assignment.itemId));
  const unknownReasons = [
    'Assignments are planned intent; claims are observations, not proof of process launch or completion.',
    'Manifest itemId and claimed job are joined only by exact equality; no identifier mapping or timestamp matching is available.',
    'Claim job IDs allow only 1–80 ASCII letters, digits, dots, underscores and hyphens; other manifest item IDs cannot join this schema.',
    'Claims have no manifestId or attemptId; an exact job match cannot prove a particular dispatch attempt launched.',
    'Unmatched intent means unobserved in these sources, not proof of zero launches.',
  ];
  if (summary.coverage !== 'complete') unknownReasons.push(`Manifest coverage is ${summary.coverage}; omitted or invalid records may hide intent.`);
  if (runs.sources.claimed !== 'healthy') unknownReasons.push(`Claim source is ${runs.sources.claimed}; missing observations are unknown.`);
  if (summary.conflictingManifests) unknownReasons.push('Conflicting manifest IDs are excluded from matching.');
  return {
    schemaVersion: 1, summary, sources: { manifests, runs },
    coverage: { manifests: summary.coverage, runs: runs.sourceState, claimed: runs.sources.claimed },
    observedClaims, matchingEvidence: { basis: 'exact-item-job-id', matches,
      matchedJobIds: [...new Set(matches.map(match => match.itemId))].sort(),
      launchCount: null },
    unmatchedIntent, unmatchedClaims: observedClaims.filter(claim => !assignedIds.has(claim.job)),
    dryRunIntent: intent.filter(event => event.dryRun), unknownReasons,
  };
}

export async function cmdFleetDispatchProof(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: phm fleet dispatch-proof [--json] [--runs-dir <abs>]');
    console.log('Read-only: assigned intent versus observed claims. Dry-run intent stays separate; claims do not prove launches.');
    return 0;
  }
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--runs-dir' && args[i + 1] && isAbsolute(args[i + 1]!)) {
      runsDir = args[++i];
    } else {
      process.stderr.write('dispatch-proof: expected --json or --runs-dir <absolute path>\n');
      return 2;
    }
  }
  const proof = await readDispatchProof(runsDir);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(proof)}\n`);
  else {
    console.log(`Assigned intent: ${proof.summary.live.assigned} live; ${proof.summary.dryRun.assigned} dry-run.`);
    console.log(`Observed claims: ${proof.observedClaims.length}; exact matched job IDs: ${proof.matchingEvidence.matchedJobIds.length}; unobserved assignments: ${proof.unmatchedIntent.length}.`);
    console.log(`Coverage: manifests ${proof.coverage.manifests}; runs ${proof.coverage.runs}; claims ${proof.coverage.claimed}.`);
    for (const reason of proof.unknownReasons) console.log(reason);
  }
  return 0;
}
