/** CLI routing and refusal contracts; transaction tests own real durable recovery. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ check: vi.fn(), apply: vi.fn(), resume: vi.fn(), read: vi.fn(),
  Failure: class extends Error { constructor(readonly code: string) { super('PRIVATE_FAILURE_SENTINEL'); } } }));
vi.mock('../src/core/resources/pool-runtime.js', () => ({ readResourceJson: backend.read }));
vi.mock('../src/core/resources/pool-commissioning.js', () => ({ checkResourcePoolCommissioning: backend.check,
  applyResourcePoolCommissioning: backend.apply, resumeResourcePoolCommissioning: backend.resume,
  ResourcePoolCommissioningCheckError: backend.Failure }));
import { cmdResourcePoolCommissioningCheck } from '../src/cli/resource-pool-commissioning-check.js';
const requestPath = '/private/fixture/request.json';
const hash = 'a'.repeat(64);
const request = { root: '/private/fixture/accounts/ledger', workspace: '/private/fixture/workspace', accountsRoot: '/private/fixture/accounts',
  acknowledgment: 'new-roster-enrollment-without-continuity', enrollments: [{ capacityKey: 'personal', seatId: 'personal-new' }] };
const plan = { status: 'planned', planDigest: hash, configurationDisposition: 'historical', preservedReceiptCount: 3,
  preservedJobCount: 2, heldQueuedIds: ['waiting'], invalidatedWorkerIds: ['general', 'spark'],
  applicationImplemented: true, applicationReady: false, executionAuthorized: false, providerContacted: false, stateChanged: false,
  identityContinuityVerified: false, independentAccountIdentityVerified: false,
  applicationHolds: ['account-identity-continuity-unverified', 'fresh-target-collector-evidence-required', 'current-account-quota-and-billing-qualification-required'] };
let output: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks(); output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  backend.read.mockReturnValue(request); backend.check.mockReturnValue(plan);
  backend.apply.mockReturnValue({ ...plan, status: 'applied', disposition: 'created', stateChanged: true });
  backend.resume.mockReturnValue({ ...plan, status: 'applied', disposition: 'resumed', stateChanged: true });
});
afterEach(() => vi.restoreAllMocks());
const args = (action: string, json = true) => [action, '--request', requestPath,
  ...(action === 'check' ? [] : ['--expected-plan-digest', hash]), ...(json ? ['--json'] : [])];
describe('pool commissioning transaction CLI', () => {
  it('keeps check read-only and preserves typed holds in JSON', async () => {
    expect(await cmdResourcePoolCommissioningCheck(args('check'))).toBe(0);
    expect(backend.read).toHaveBeenCalledWith(requestPath, 64 * 1024);
    expect(backend.check).toHaveBeenCalledExactlyOnceWith(request);
    expect(backend.apply).not.toHaveBeenCalled(); expect(backend.resume).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(plan);
  });
  it('routes explicit apply with the approved digest and never retries', async () => {
    expect(await cmdResourcePoolCommissioningCheck(args('apply'))).toBe(0);
    expect(backend.apply).toHaveBeenCalledExactlyOnceWith({ ...request, expectedPlanDigest: hash });
    expect(backend.check).not.toHaveBeenCalled(); expect(backend.resume).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ disposition: 'created', stateChanged: true, executionAuthorized: false });
  });
  it('routes resume only to the source-owned existing-journal guard', async () => {
    expect(await cmdResourcePoolCommissioningCheck(args('resume'))).toBe(0);
    expect(backend.resume).toHaveBeenCalledExactlyOnceWith({ ...request, expectedPlanDigest: hash });
    expect(backend.apply).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
  });
  it('never converts a refused resume into a new apply or check', async () => {
    backend.resume.mockImplementation(() => { throw new backend.Failure('state-unavailable'); });
    expect(await cmdResourcePoolCommissioningCheck(args('resume'))).toBe(1);
    expect(backend.resume).toHaveBeenCalledOnce(); expect(backend.apply).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ code: 'state-unavailable' });
    expect(output.mock.calls[0]![0]).not.toContain('PRIVATE_');
  });
  it.each([null, [], { ...request, expectedPlanDigest: hash }])('rejects malformed requests and embedded mutation controls before apply %#', async value => {
    backend.read.mockReturnValue(value);
    expect(await cmdResourcePoolCommissioningCheck(args('apply'))).toBe(2);
    expect(backend.apply).not.toHaveBeenCalled(); expect(backend.resume).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
  });
  it('preserves the finished-replay disposition without claiming a new write', async () => {
    backend.resume.mockReturnValue({ ...plan, status: 'applied', disposition: 'replayed', stateChanged: false });
    expect(await cmdResourcePoolCommissioningCheck(args('resume'))).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ disposition: 'replayed', stateChanged: false, executionAuthorized: false });
    expect(backend.apply).not.toHaveBeenCalled();
  });
  it.each(['--help', '-h'].flatMap(flag => [[flag], ...['check', 'apply', 'resume'].map(action => [action, flag])])
    .map(input => ({ input })))('renders standalone help without reading or contacting a backend %#', async ({ input }) => {
    expect(await cmdResourcePoolCommissioningCheck(input)).toBe(0);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
    expect(backend.apply).not.toHaveBeenCalled(); expect(backend.resume).not.toHaveBeenCalled();
  });
  it.each([
    [], ['run'], ['apply', '--request', requestPath], ['resume', '--request', requestPath],
    ['check', '--request', requestPath, '--expected-plan-digest', hash],
    ...['bad', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)].map(digest => ['apply', '--request', requestPath, '--expected-plan-digest', digest]),
    ...['/', 'relative', '/private/../fixture', '/private/\u0001', 'x'.repeat(4097)].map(path => ['check', '--request', path]),
    ['check', '--request', requestPath, '--json', '--json'], ['check', '--request', requestPath, '--request', requestPath],
    ['apply', '--request', requestPath, '--expected-plan-digest', hash, '--expected-plan-digest', hash],
    ['check', '--request', requestPath, '--execute'], ['check', '--help', '--request', requestPath],
  ].map(input => ({ input })))('refuses malformed arguments before any file reads %#', async ({ input }) => {
    expect(await cmdResourcePoolCommissioningCheck(input)).toBe(2);
    expect(backend.read).not.toHaveBeenCalled(); expect(backend.check).not.toHaveBeenCalled();
    expect(backend.apply).not.toHaveBeenCalled(); expect(backend.resume).not.toHaveBeenCalled();
  });
  it.each(['read', 'check', 'apply', 'resume'] as const)('redacts %s failures without retrying an uncertain mutation', async stage => {
    backend[stage].mockImplementation(() => { throw new Error('PRIVATE_FAILURE_SENTINEL'); });
    expect(await cmdResourcePoolCommissioningCheck(args(stage === 'read' ? 'check' : stage))).toBe(1);
    expect(backend[stage]).toHaveBeenCalledOnce(); expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]![0]).not.toContain('PRIVATE_');
  });
  it('distinguishes completed offline migration from dispatch qualification', async () => {
    expect(await cmdResourcePoolCommissioningCheck(args('apply', false))).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('applied · created'); expect(text).toContain('dispatch remains held');
    expect(text).toContain('Queued tasks remain held: waiting'); expect(text).toContain('Account continuity and independent account identity remain unverified');
    expect(text).not.toContain('Read-only:');
  });
  it('routes the existing resources/pool command surface to the same guarded backend', async () => {
    const { cmdResources } = await import('../src/cli/resources.js');
    expect(await cmdResources(['pool', 'commission', ...args('resume')])).toBe(0);
    expect(backend.resume).toHaveBeenCalledOnce(); expect(backend.apply).not.toHaveBeenCalled();
  });
});
