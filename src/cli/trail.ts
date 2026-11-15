import {
  TrailError, beatTrail, claimTrail, listTrailClaims, releaseTrail,
  resumeTrail, saveTrailCheckpoint, showTrailClaim, sweepTrail,
  TRAIL_DEFAULT_LEASE_MS, type TrailClaimView,
} from '../core/stigmergy.js';

const USAGE = `Usage: phm trail <verb> [options]
  claim <claim-key> --owner <label> [--job <id>] [--lease-ms <n>] [--note <text>] [--worktree <dir>]
  beat <claim-key> --token <hex> [--note <text>] [--lease-ms <n>]
  release <claim-key> --token <hex> [--outcome released|completed]
  save <claim-key> --token <hex> --checkpoint <file> [--worktree <dir>]
  list | show <claim-key> | resume <claim-key> | sweep [--checkpoint-days <n>]
Claim keys use the Agent Bus v2 grammar: repo:<o/n>, path:<o/n>:<glob>, queue:<id>, pr:<o/n>#<n>.
Default lease ${TRAIL_DEFAULT_LEASE_MS} ms. Coordination only: no execution authority.`;

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  args.splice(index, 2);
  return value;
}

function printClaim(prefix: string, claim: TrailClaimView): void {
  const parts = [claim.claimKey, claim.owner, claim.status,
    `lease ${Math.round(claim.leaseRemainingMs / 1000)}s`, `beat ${Math.round(claim.heartbeatAgeMs / 1000)}s ago`];
  if (claim.jobId) parts.push(`job ${claim.jobId}`);
  if (claim.note) parts.push(`note ${JSON.stringify(claim.note)}`);
  if (claim.worktree) parts.push(`worktree ${claim.worktree}`);
  if (claim.checkpoint) parts.push(`checkpoint ${claim.checkpoint}`);
  console.log(`${prefix}${parts.join('  ')}`);
}

function emit(json: boolean, value: unknown, human: () => void): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else human();
}

function refusal(reason: string): number {
  process.stderr.write(`trail: refused (${reason})\n`);
  return 4;
}

export async function cmdTrail(args: string[]): Promise<number> {
  if (args.length === 0 || (args.length === 1 && args[0] === 'help') || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  const verb = rest[0];
  try {
    switch (verb) {
      case 'claim': {
        const owner = takeFlag(rest, '--owner');
        const jobId = takeFlag(rest, '--job');
        const leaseMs = takeFlag(rest, '--lease-ms');
        const note = takeFlag(rest, '--note');
        const worktree = takeFlag(rest, '--worktree');
        const key = rest[1];
        if (!key || rest.length !== 2 || owner === undefined) { process.stderr.write(`${USAGE}\n`); return 2; }
        const result = claimTrail({
          claimKey: key, owner, ...(jobId !== undefined && { jobId }),
          ...(leaseMs !== undefined && { leaseMs: Number(leaseMs) }),
          ...(note !== undefined && { note }), ...(worktree !== undefined && { worktree }),
        });
        if (result.status === 'conflict') {
          emit(json, result, () => printClaim('conflict: held by ', result.holder));
          return 3;
        }
        emit(json, result, () => {
          printClaim('claimed ', result.claim);
          console.log(`token ${result.token}`);
        });
        return 0;
      }
      case 'beat': {
        const token = takeFlag(rest, '--token');
        const note = takeFlag(rest, '--note');
        const leaseMs = takeFlag(rest, '--lease-ms');
        const key = rest[1];
        if (!key || rest.length !== 2 || token === undefined) { process.stderr.write(`${USAGE}\n`); return 2; }
        const result = beatTrail({
          claimKey: key, token,
          ...(note !== undefined && { note }),
          ...(leaseMs !== undefined && { leaseMs: Number(leaseMs) }),
        });
        if (result.status === 'refused') return refusal(result.reason);
        emit(json, result, () => printClaim('beat ', result.claim));
        return 0;
      }
      case 'release': {
        const token = takeFlag(rest, '--token');
        const outcome = takeFlag(rest, '--outcome');
        const key = rest[1];
        if (!key || rest.length !== 2 || token === undefined) { process.stderr.write(`${USAGE}\n`); return 2; }
        const result = releaseTrail({
          claimKey: key, token,
          ...(outcome !== undefined && { outcome: outcome as 'released' | 'completed' }),
        });
        if (result.status === 'refused') return refusal(result.reason);
        emit(json, result, () => console.log(`${result.outcome} ${result.claimKey}`));
        return 0;
      }
      case 'save': {
        const token = takeFlag(rest, '--token');
        const source = takeFlag(rest, '--checkpoint');
        const worktree = takeFlag(rest, '--worktree');
        const key = rest[1];
        if (!key || rest.length !== 2 || token === undefined || source === undefined) {
          process.stderr.write(`${USAGE}\n`); return 2;
        }
        const result = await saveTrailCheckpoint({
          claimKey: key, token, source,
          ...(worktree !== undefined && { worktree }),
        });
        if (result.status === 'refused') return refusal(result.reason);
        emit(json, result, () => console.log(`saved ${result.claimKey}  checkpoint ${result.checkpoint}`));
        return 0;
      }
      case 'list': {
        if (rest.length !== 1) { process.stderr.write(`${USAGE}\n`); return 2; }
        const result = listTrailClaims();
        emit(json, result, () => {
          if (result.claims.length === 0) console.log('no trail claims');
          for (const claim of result.claims) printClaim('', claim);
          if (result.unreadable > 0) console.log(`unreadable markers: ${result.unreadable}`);
        });
        return 0;
      }
      case 'show': {
        const key = rest[1];
        if (!key || rest.length !== 2) { process.stderr.write(`${USAGE}\n`); return 2; }
        const claim = showTrailClaim({ claimKey: key });
        if (!claim) return refusal('unknown-claim');
        emit(json, { status: 'ok', claim }, () => printClaim('', claim));
        return 0;
      }
      case 'resume': {
        const key = rest[1];
        if (!key || rest.length !== 2) { process.stderr.write(`${USAGE}\n`); return 2; }
        const result = await resumeTrail({ claimKey: key });
        if (result.status === 'refused') return refusal(result.reason);
        emit(json, result, () => {
          printClaim('', result.claim);
          if (result.checkpoint) {
            console.log(`goal: ${result.checkpoint.goal}`);
            for (const step of result.checkpoint.next) console.log(`next: ${step}`);
          } else {
            console.log('no saved checkpoint');
          }
        });
        return 0;
      }
      case 'sweep': {
        const days = takeFlag(rest, '--checkpoint-days');
        if (rest.length !== 1) { process.stderr.write(`${USAGE}\n`); return 2; }
        const result = sweepTrail(days === undefined ? {} : { checkpointMaxAgeMs: Number(days) * 86_400_000 });
        emit(json, result, () => console.log(
          `removed ${result.removedClaims} claims, ${result.removedCheckpoints} checkpoints; ${result.keptClaims} live`));
        return 0;
      }
      default:
        process.stderr.write(`${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof TrailError) {
      process.stderr.write(`trail: ${error.message}\n`);
      return error.code === 'invalid' ? 2 : 1;
    }
    process.stderr.write('trail: operation failed.\n');
    return 1;
  }
}
