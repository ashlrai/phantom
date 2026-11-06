import { inspectOneAskReward } from '../core/fleet/one-ask-reward.js';
import { loadProposal } from '../core/inbox/store.js';
import { authenticatedRealizedMergeOf } from '../core/inbox/realized-merge.js';

const HELP = `Usage: phm reflect attempt-reward --proposal <id> --tokens <positive-integer> [--weight <positive-number>] --json
Observation-only snapshot from the trusted proposal store and authenticated realized merge provenance.
Tokens (complete input plus output) and weight are caller supplied; weight defaults to 1.
Publication alone yields zero; other unproven states remain unknown.
Merged outcomes use the existing 72-hour observation window and revert evidence.
No routing, score policy changes, credit release, provider calls or outward actions.
No proposal JSON, merge receipts or git arguments are accepted.`;

export function cmdReflectAttemptReward(args: string[]): number {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  const usage = (): number => {
    process.stderr.write('error: invalid attempt-reward arguments; run `phm reflect attempt-reward --help`.\n');
    return 2;
  };
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--proposal', '--tokens', '--weight'].includes(flag) || values.has(flag)) return usage();
    const value = args[++i];
    if (!value || value.startsWith('--')) return usage();
    values.set(flag, value);
  }
  const id = values.get('--proposal');
  const rawTokens = values.get('--tokens');
  const rawWeight = values.get('--weight') ?? '1';
  const tokens = Number(rawTokens), weight = Number(rawWeight);
  if (!json || !id || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id) || id === '.' || id === '..' ||
    !rawTokens || !/^[1-9]\d*$/.test(rawTokens) || !Number.isSafeInteger(tokens) ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawWeight) ||
    !Number.isFinite(weight) || weight <= 0 || !Number.isFinite(weight / tokens) || weight / tokens === 0) return usage();
  try {
    const proposal = loadProposal(id);
    if (!proposal) {
      process.stderr.write('error: proposal unavailable.\n');
      return 1;
    }
    const nowMs = Date.now();
    // Never let an unsupported lifecycle state acquire a publish-only score.
    const published = !authenticatedRealizedMergeOf(proposal) &&
      proposal.status === 'awaiting-host-merge' && proposal.remoteHandoff?.state === 'awaiting-host-merge';
    const result = inspectOneAskReward({
      outcome: published ? { kind: 'published' } : { kind: 'merged', proposal },
      tokens, weight, nowMs,
    });
    process.stdout.write(JSON.stringify({ proposalId: id, observedAt: new Date(nowMs).toISOString(),
      observationOnly: true, inputs: { tokens, weight, tokensSource: 'caller-supplied',
        weightSource: values.has('--weight') ? 'caller-supplied' : 'default' }, result }) + '\n');
    return 0;
  } catch {
    process.stderr.write('error: unable to observe attempt reward.\n');
    return 1;
  }
}
