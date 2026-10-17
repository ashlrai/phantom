/**
 * loop-leases.ts — `ashlr loop leases`: operator recovery for simple-conductor
 * tasks stuck in `reconciliation-required`.
 *
 * A task's dispatch lease that expired (or was written under a skewed clock)
 * without a settlement blocks that task forever: the conductor refuses to
 * redispatch it because the original dispatch may still be running. This
 * command lists those tasks and clears one only when the lease's owner is
 * PROVABLY not running (owner pid gone, owner pid reused by a later process,
 * or the claim predates the current boot). A possibly-live owner is refused
 * with the reason; there is no override. Every clear attempt is audited.
 */

import { makeColors } from './ui.js';

export const LOOP_LEASES_USAGE =
  'Usage: ashlr loop leases [--json]\n' +
  '       ashlr loop leases clear <task-id> [--dry-run] [--json]\n' +
  '\n' +
  '  List simple-conductor tasks whose dispatch lease needs reconciliation, or\n' +
  '  clear one back to a claimable state. Clearing requires proof that the\n' +
  '  lease owner is not running (dead pid, reused pid, or a claim from before\n' +
  '  the last boot); a possibly-live owner is refused. Attempts and known\n' +
  '  proposal ids are kept, so the conductor reconciles before redispatch.\n' +
  '\n' +
  '  Flags:\n' +
  '    --dry-run   Prove and report without changing the task store\n' +
  '    --json      Machine-readable output';

export async function cmdLoopLeases(args: string[]): Promise<number> {
  const col = makeColors(process.stdout.isTTY === true);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(LOOP_LEASES_USAGE);
    return 0;
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const unknownFlag = args.find((arg) => arg.startsWith('-') && arg !== '--json' && arg !== '--dry-run');
  if (unknownFlag) {
    console.error(col.red('error: ') + `unknown flag ${unknownFlag}\n\n${LOOP_LEASES_USAGE}`);
    return 2;
  }

  const store = await import('../core/simple-conductor-task-store.js');

  if (positional.length === 0) {
    if (dryRun) {
      console.error(col.red('error: ') + '--dry-run applies only to `leases clear`.');
      return 2;
    }
    const listed = store.listReconciliationRequiredSimpleConductorTasks();
    if (!listed.ok) {
      if (json) console.log(JSON.stringify({ ok: false, error: listed.reason }));
      else console.error(col.red('error: ') + listed.reason);
      return 1;
    }
    const rows = listed.tasks.map((entry) => ({
      id: entry.task.id,
      repo: entry.task.repo,
      leaseState: entry.leaseState,
      claimedAt: entry.lease.claimedAt,
      expiresAt: entry.lease.expiresAt,
      ownerPid: entry.lease.ownerPid ?? null,
      attempts: entry.task.attempts ?? 0,
    }));
    if (json) {
      console.log(JSON.stringify({ ok: true, tasks: rows }));
      return 0;
    }
    if (rows.length === 0) {
      console.log(col.dim('  no tasks need lease reconciliation.'));
      return 0;
    }
    for (const row of rows) {
      console.log(
        `  ${row.id}  ${col.dim(row.repo)}\n` +
        col.dim(`    lease ${row.leaseState} · claimed ${row.claimedAt} · owner pid ${row.ownerPid ?? 'unrecorded'} · attempts ${row.attempts}`),
      );
    }
    console.log(col.dim('\n  Clear one with `ashlr loop leases clear <task-id>` (add --dry-run to preview).'));
    return 0;
  }

  if (positional[0] !== 'clear' || positional.length !== 2) {
    console.error(col.red('error: ') + `expected \`clear <task-id>\`\n\n${LOOP_LEASES_USAGE}`);
    return 2;
  }
  const taskId = positional[1]!;
  const result = store.clearReconciliationRequiredSimpleConductorTask(taskId, { dryRun });

  if (!dryRun) {
    const { audit } = await import('../core/sandbox/audit.js');
    audit({
      action: 'simple-conductor:lease-clear',
      repo: result.ok ? result.task.repo : null,
      sandboxId: null,
      summary: result.ok
        ? `cleared reconciliation-required lease on task ${taskId} (${result.proof}, lease ${result.leaseState})`
        : `refused to clear lease on task ${taskId}: ${result.reason}: ${result.detail}`,
      result: result.ok ? 'ok' : result.reason === 'unavailable' ? 'error' : 'refused',
    });
  }

  if (json) {
    console.log(JSON.stringify(result.ok
      ? { ok: true, dryRun, changed: result.changed, taskId, proof: result.proof, leaseState: result.leaseState }
      : { ok: false, dryRun, taskId, reason: result.reason, detail: result.detail }));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    console.error(col.red('  refused: ') + `${result.reason}: ${result.detail}`);
    return 1;
  }
  console.log(dryRun
    ? col.dim(`  dry-run: would clear the ${result.leaseState} lease on ${taskId} (${result.proof}); nothing written.`)
    : col.green('  ok ') + `cleared the ${result.leaseState} lease on ${taskId} (${result.proof}); the task is claimable again.`);
  return 0;
}
