import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';
const USAGE = `usage: ashlr resources pool commission check --request ABS [--json]

Read-only preparation for explicit new roster enrollment without legacy account
continuity. The private request pins root, workspace, accountsRoot, enrollments
(capacityKey/seatId), and acknowledgment: new-roster-enrollment-without-continuity.
root must be accountsRoot/ledger; operator files use their fixed standard names.
All aliases of each selected capacity are proposed together. Policy, receipts,
held queued work, allocation, pauses and exclusions remain unchanged.

A planned report is NOT application readiness, provider account proof, billing
entitlement or execution authority. Writable apply/resume is unavailable pending
reviewed transition custody, context-sharing acknowledgment, collector epoch
fences and crash-safe publication. No lock, state, service, provider, quota or
credential changes. Unknown ownership/markers/history are held, never cleared.
Exit codes: 0 planned/help, 1 held/unavailable, 2 invalid arguments.
`;
export async function cmdResourcePoolCommissioningCheck(args: string[]): Promise<number> {
  try {
    const parsed = resourceCheckOptions(args, ['--request']);
    if (parsed.help) { console.log(USAGE); return 0; }
    const requestPath = resourceCheckPath(parsed.values, '--request');
    const [{ readResourceJson }, backend] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/pool-commissioning-check.js'),
    ]);
    const report = backend.checkResourcePoolCommissioning(readResourceJson(requestPath, 64 * 1024));
    console.log(parsed.json ? JSON.stringify(report) : [
      'Pool commissioning preparation · planned · application held',
      `Plan digest: ${report.planDigest}`,
      `Operator configuration: ${report.configurationDisposition}`,
      `Preserved receipts: ${report.preservedReceiptCount} · jobs: ${report.preservedJobCount}`,
      `Workers needing new quota evidence: ${report.invalidatedWorkerIds.join(', ')}`,
      'Account continuity and independent account identity remain unverified.',
      `Application holds: ${report.applicationHolds.join(', ')}`,
      'Read-only: no ownership, state or provider changes; no execution authority.',
    ].join('\n'));
    return 0;
  } catch (e) {
    const { ResourcePoolCommissioningCheckError } = await import('../core/resources/pool-commissioning-check.js');
    const code = e instanceof ResourcePoolCommissioningCheckError ? e.code : undefined;
    const message = e instanceof ResourceCheckUsageError ? e.message : code ? `Pool commissioning check held: ${code}` : 'Pool commissioning check unavailable; preserve existing evidence';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message, ...(code ? { code } : {}) })); else console.error(message);
    return e instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
