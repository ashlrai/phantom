import { resourceCheckOptions, resourceCheckPath, ResourceCheckUsageError } from './resource-check-options.js';
const USAGE = `usage: ashlr resources pool commission check --request ABS [--json]
       ashlr resources pool commission apply --request ABS --expected-plan-digest SHA256 [--json]
       ashlr resources pool commission resume --request ABS --expected-plan-digest SHA256 [--json]

Read-only preparation for explicit new roster enrollment without legacy account
continuity. The private request pins root, workspace, accountsRoot, enrollments
(capacityKey/seatId), and acknowledgment: new-roster-enrollment-without-continuity.
root must be accountsRoot/ledger; operator files use their fixed standard names.
All aliases of each selected capacity are proposed together. Policy, receipts,
held queued work, allocation, pauses and exclusions remain unchanged.

Check is read-only. Apply publishes the reviewed offline locator migration;
resume requires its existing complete journal and the SAME request and digest.
A planned/applied report is NOT provider account proof, billing entitlement or
execution authority. New quota and billing qualification remain required; old
queued tasks and retained context stay behind their origin boundary. No provider,
native auth, collector, service, credential or spending changes are performed.
Unknown ownership/markers/history are held, never cleared. Do not delete custody.
Exit codes: 0 planned/applied/help, 1 held/unavailable, 2 invalid arguments.
`;
export async function cmdResourcePoolCommissioningCheck(args: string[]): Promise<number> {
  let failureCode: ((error: unknown) => string | undefined) | undefined;
  try {
    const action = args[0];
    const actions = ['check', 'apply', 'resume'];
    if ((args.length === 1 && ['--help', '-h'].includes(action!)) ||
      (args.length === 2 && actions.includes(action!) && ['--help', '-h'].includes(args[1]!))) {
      console.log(USAGE); return 0;
    }
    if (!actions.includes(action!)) throw new ResourceCheckUsageError('Expected commission check, apply or resume');
    const parsed = resourceCheckOptions(['check', ...args.slice(1)],
      action === 'check' ? ['--request'] : ['--request', '--expected-plan-digest']);
    const requestPath = resourceCheckPath(parsed.values, '--request');
    const expectedPlanDigest = parsed.values.get('--expected-plan-digest');
    if (action !== 'check' && (!expectedPlanDigest || !/^[a-f0-9]{64}$/.test(expectedPlanDigest))) {
      throw new ResourceCheckUsageError('Apply and resume require an exact --expected-plan-digest');
    }
    const [{ readResourceJson }, backend] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/pool-commissioning.js'),
    ]);
    failureCode = error => error instanceof backend.ResourcePoolCommissioningCheckError ? error.code : undefined;
    const request = readResourceJson(requestPath, 64 * 1024);
    // Mutation controls belong to flags, never embedded request fields. Preserve
    // all remaining keys for the core's strict request validation.
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.hasOwn(request, 'expectedPlanDigest')) {
      throw new ResourceCheckUsageError('Invalid commissioning request object');
    }
    const mutation = { ...request, expectedPlanDigest } as Parameters<typeof backend.applyResourcePoolCommissioning>[0];
    const report = action === 'check' ? backend.checkResourcePoolCommissioning(request)
      : action === 'apply' ? backend.applyResourcePoolCommissioning(mutation) : backend.resumeResourcePoolCommissioning(mutation);
    console.log(parsed.json ? JSON.stringify(report) : [
      report.status === 'planned' ? 'Pool commissioning preparation · planned · dispatch remains held'
        : `Pool commissioning migration · applied · ${report.disposition} · dispatch remains held`,
      `Plan digest: ${report.planDigest}`,
      `Operator configuration: ${report.configurationDisposition}`,
      `Preserved receipts: ${report.preservedReceiptCount} · jobs: ${report.preservedJobCount}`,
      `Workers needing new quota evidence: ${report.invalidatedWorkerIds.join(', ')}`,
      ...(report.heldQueuedIds.length ? [`Queued tasks remain held: ${report.heldQueuedIds.join(', ')}`] : []),
      'Account continuity and independent account identity remain unverified.',
      `Dispatch qualification holds: ${report.applicationHolds.join(', ')}`,
      action === 'check' ? 'Read-only: no ownership, state or provider changes; no execution authority.'
        : 'Offline migration only: no provider contact, spending authorization or execution authority.',
    ].join('\n'));
    return 0;
  } catch (e) {
    const code = failureCode?.(e);
    const message = e instanceof ResourceCheckUsageError ? e.message : code ? `Pool commissioning held: ${code}` : 'Pool commissioning unavailable; preserve existing evidence';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message, ...(code ? { code } : {}) })); else console.error(message);
    return e instanceof ResourceCheckUsageError ? 2 : 1;
  }
}
