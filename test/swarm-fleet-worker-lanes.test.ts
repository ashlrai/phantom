import { describe, expect, it } from 'vitest';
import { inspectSwarmFleetLane } from '../src/core/swarm/fleet-worker-lanes.js';

const now = () => Date.parse('2026-11-26T12:00:00.000Z');
const reset = '2026-11-26T15:00:00.000Z';

describe('swarm fleet worker adapter refusals', () => {
  it('retains an explicit Antigravity quota-denial reset but never dispatches', async () => {
    await expect(inspectSwarmFleetLane('agy-neon', { now,
      readAgyDenial: async () => ({ status: 429, message: `Individual quota reached. Resets at ${reset}` }),
    })).resolves.toMatchObject({ evidence: 'exhausted', readiness: 'held', resetAt: reset, dispatch: 'bridge-not-commissioned' });
    await expect(inspectSwarmFleetLane('agy-neon', { now,
      readAgyDenial: async () => ({ status: 429, message: 'Individual quota reached' }), readAgy: async () => null,
    })).resolves.toMatchObject({
      evidence: 'exhausted', resetAt: null, reason: 'agy_quota_exhausted', dispatch: 'bridge-not-commissioned',
    });
  });

  it('does not mistake fresh GLM usage for dispatch authorization or carry stale usage', async () => {
    const reading = { used: 5, limit: 100, unit: 'percent' as const, resetsAt: reset, source: 'zai-lane-resources' };
    await expect(inspectSwarmFleetLane('glm-lite', { now,
      readZai: async () => ({ ...reading, asOf: new Date(now()).toISOString() }),
    })).resolves.toMatchObject({ evidence: 'observed', readiness: 'held', dispatch: 'bridge-not-commissioned' });
    await expect(inspectSwarmFleetLane('glm-lite', { now,
      readZai: async () => ({ ...reading, asOf: new Date(0).toISOString() }),
    })).resolves.toMatchObject({ evidence: 'unknown', readiness: 'unknown' });
  });

  it('leaves a logged-out Devin or unverified price unknown and has no dispatch path', async () => {
    const devinAdmission = { section: { enabled: true, fleet: true }, grant: { ok: true, reason: 'fixture' },
      budgetAllowsDevin: true, budgetMode: 'burn' };
    for (const state of ['logged-out', 'ready'] as const) {
      await expect(inspectSwarmFleetLane('devin-flash', { now, devinAdmission,
        probeDevin: async () => ({ state, cliPath: '/inert/devin', reason: state === 'ready' ? null : 'Not logged in', checkedAt: now() }),
      })).resolves.toMatchObject({ evidence: 'unknown', readiness: 'unknown', dispatch: 'bridge-not-commissioned' });
    }
    await expect(inspectSwarmFleetLane('unrecognized')).resolves.toBeNull();
  });
});
