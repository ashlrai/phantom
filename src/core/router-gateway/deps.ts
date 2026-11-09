/** Production wiring for the router gateway. Seat discovery, capacity, budget
 * and grant reads are the Leader's own (one discovery path); only the
 * transports differ: native calls run as the worker role, local Ollama calls
 * return free text instead of JSON. */
import type { AshlrConfig } from '../types.js';
import type { RouterGatewayConfig } from './config.js';
import type { RouterGatewayDeps, RouterGatewayTransports } from './complete.js';

export function routerGatewayTransports(cfg: AshlrConfig): RouterGatewayTransports {
  return {
    local: (baseUrl, model, opts) => async (system, user, signal) => {
      const { ollamaLeaderTransport } = await import('../vision/leader-seat.js');
      signal?.throwIfAborted();
      return ollamaLeaderTransport(baseUrl, model, cfg, opts.timeoutMs, {
        maxOutputTokens: opts.maxOutputTokens, contextTokens: opts.contextTokens, json: false,
      })(system, user);
    },
    llama: (binding, opts) => async (system, user, signal) => {
      const { llamaLeaderTransport } = await import('../vision/local-leader-transport.js');
      return llamaLeaderTransport(Object.freeze({ ...binding }), cfg, opts)(system, user, signal);
    },
    native: (seatId, engine, model, admitted, opts) => async (system, user, signal) => {
      const [{ nativeRoleCompletion }, { readCapacitySnapshot }] = await Promise.all([
        import('../run/role-completion.js'),
        import('../routing/budget-store.js'),
      ]);
      const accountHint = readCapacitySnapshot()?.seats.find((row) => row.seatId === seatId)?.accountHint ?? undefined;
      // The allowance must stay the same account for the whole call.
      const sameAccount = (): boolean => admitted() && (engine === 'devin' || accountHint !== undefined
        && readCapacitySnapshot()?.seats.find((row) => row.seatId === seatId)?.accountHint === accountHint);
      return nativeRoleCompletion({
        cfg, role: 'worker', seatId, engine, model, accountHint, admitted: sameAccount, timeoutMs: opts.timeoutMs,
        ...(signal ? { signal } : {}),
      })(system, user);
    },
  };
}

export async function loadRouterGatewayDeps(cfg: AshlrConfig, gateway: RouterGatewayConfig): Promise<RouterGatewayDeps> {
  const [{ loadDefaultLeaderSeatDeps }, budgetStore, { killSwitchOn }] = await Promise.all([
    import('../vision/leader-seat.js'),
    import('../routing/budget-store.js'),
    import('../sandbox/policy.js'),
  ]);
  const base = await loadDefaultLeaderSeatDeps(cfg);
  return {
    cfg,
    gateway,
    now: base.now,
    candidates: base.candidates,
    capacitySnapshot: base.capacitySnapshot,
    budgetPolicy: base.budgetPolicy,
    standingPolicy: base.standingPolicy,
    clampBudget: base.clampBudget,
    route: base.route,
    capacityFromSeat: base.capacityFromSeat,
    recordDecision: (request, decision) => budgetStore.recordShadowDecision({ source: 'gateway', request, decision, actual: null }),
    killSwitchOn,
    transports: routerGatewayTransports(cfg),
  };
}
