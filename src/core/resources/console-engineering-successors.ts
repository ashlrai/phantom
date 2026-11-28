/** Private console adapter: proposals share the existing ledger and cannot choose seed authority. */
import { canonical } from '../universe/artifacts.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { readResourceJson } from './pool-runtime.js';
import { bindOwnDataMethod, captureStrictOwnDataOptions, engineeringDigest, isEngineeringHash } from './engineering-shared.js';
import { createResourceEngineeringSuccessorCoordinator, validateResourceEngineeringSuccessorCoordinatorConfig } from './engineering-successor-coordinator.js';
import type { ResourceEngineeringSuccessorCoordinatorOptions, ResourceEngineeringSuccessorEvidence } from './engineering-successor-coordinator-types.js';
import type { ResourceConsoleEngineeringPreparationOwner } from './console-engineering-preparation.js';
import type { ResourceConsoleEngineeringSupervisor } from './console-engineering-supervisor.js';
import type { ResourcePoolSupervisor } from './pool-supervisor.js';

export function createResourceConsoleEngineeringSuccessors(options: {
  root: string; configFile: string; config: ResourceEngineeringSuccessorCoordinatorOptions['config'];
  projectId: string; preparation: ResourceConsoleEngineeringPreparationOwner;
  acceptance: string;
  supervision: ResourceConsoleEngineeringSupervisor; supervisor: ResourcePoolSupervisor;
  pool: ResourceEngineeringSuccessorCoordinatorOptions['pool']; bindings: ResourceEngineeringSuccessorCoordinatorOptions['bindings'];
  readAdmissionEvidence: ResourceEngineeringSuccessorCoordinatorOptions['readAdmissionEvidence'];
  isClosing(): boolean; signal?: AbortSignal;
  onLifecycle?: ResourceEngineeringSuccessorCoordinatorOptions['onLifecycle'];
}) {
  const required = ['root', 'configFile', 'config', 'projectId', 'acceptance', 'preparation', 'supervision', 'supervisor',
    'pool', 'bindings', 'readAdmissionEvidence', 'isClosing'];
  const captured = captureStrictOwnDataOptions(options, required, ['signal', 'onLifecycle'], () => {
    throw new Error('Invalid successor console options');
  });
  const method = <T extends object, K extends keyof T>(host: T, key: K): T[K] =>
    bindOwnDataMethod(host, key, () => { throw new Error('Invalid successor console host'); });
  const config = validateResourceEngineeringSuccessorCoordinatorConfig(captured.config);
  const { root, configFile, projectId, acceptance, signal, readAdmissionEvidence, isClosing, onLifecycle } = captured;
  if (typeof acceptance !== 'string' || !acceptance.trim() || Buffer.byteLength(acceptance) > 1024 ||
      typeof isClosing !== 'function' || typeof readAdmissionEvidence !== 'function' ||
      onLifecycle !== undefined && typeof onLifecycle !== 'function') throw new Error('Invalid successor console policy');
  const preparation = { successorSource: method(captured.preparation, 'successorSource'), prepareSuccessor: method(captured.preparation, 'prepareSuccessor') };
  const supervision = { snapshot: method(captured.supervision, 'snapshot'), admit: method(captured.supervision, 'admit'),
    isExecutionStopped: method(captured.supervision, 'isExecutionStopped') };
  const supervisor = { projectFileBinding: method(captured.supervisor, 'projectFileBinding'),
    projectExecutionBinding: method(captured.supervisor, 'projectExecutionBinding') };
  const binding = supervisor.projectFileBinding(projectId);
  const configDigest = engineeringDigest(config);
  function stopped(): boolean {
    try {
      if (isClosing() || signal?.aborted || supervision.isExecutionStopped() || readKillSwitch().state !== 'inactive' ||
          engineeringDigest(readResourceJson(configFile, 16 * 1024)) !== configDigest) return true;
      return canonical(supervisor.projectExecutionBinding(projectId)) !== canonical(binding);
    } catch { return true; }
  }
  function source(enrollmentId: string, expectedEnrollmentDigest: string) {
    if (!isEngineeringHash(expectedEnrollmentDigest)) return null;
    const actual = preparation.successorSource(enrollmentId, expectedEnrollmentDigest);
    if (!actual || actual.projectId !== projectId) return null;
    const evidence: ResourceEngineeringSuccessorEvidence = { enrollmentId, enrollmentDigest: expectedEnrollmentDigest,
      projectId, deliveryDigest: actual.source.expectedDeliveryDigest, commit: actual.commit, objective: actual.objective,
      context: canonical({ acceptance, source: JSON.parse(actual.context) }) };
    if (Buffer.byteLength(evidence.context) > 8192) throw new Error('Successor context exceeds bounds');
    return { actual, evidence };
  }
  return createResourceEngineeringSuccessorCoordinator({ root, config, pool: captured.pool,
    bindings: captured.bindings, cwd: binding.workspace, supervision, readAdmissionEvidence,
    signal, onLifecycle, host: {
      isExecutionStopped: stopped,
      // The coordinator supplies the exact completed row from this guard's
      // freshly validated queue. The manager still verifies its registration,
      // current completed owner state and delivery; no cross-call cache is used.
      source: (id, expectedEnrollmentDigest) => stopped() ? null : source(id, expectedEnrollmentDigest)?.evidence ?? null,
      async prepare(input) {
        if (stopped()) throw new Error('Successor execution is stopped');
        const entry = supervision.snapshot().entries.find(row => row.enrollmentId === input.source.enrollmentId && row.state === 'completed');
        const current = entry ? source(entry.enrollmentId, entry.enrollmentDigest) : null;
        if (!current || canonical(current.evidence) !== canonical(input.source)) throw new Error('Successor source changed');
        const prepared = await preparation.prepareSuccessor({ id: input.id, name: input.name, objective: input.objective,
          profileId: input.profileId, source: current.actual.source });
        if (stopped()) throw new Error('Successor prepared while execution stopped; admission withheld');
        return prepared.enrollment;
      },
    } });
}
