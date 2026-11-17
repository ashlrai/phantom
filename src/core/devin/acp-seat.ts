import { runAcpSeatTurn, type AcpSeatOptions, type AcpSeatDeps } from '../agents/acp-client.js';
import { nextDevinModelStep } from './acp-bridge.js';
import { DEVIN_MODELS_MAX_AGE_MS, resolveDevinModel, type DevinModelCatalog } from './models.js';

export function devinAcpSeatArgs(model: string): string[] {
  return ['acp', '--model', model];
}

export function devinQualifiedFreeModel(catalog: DevinModelCatalog, model: string, nowMs = Date.now()): boolean {
  const resolved = resolveDevinModel(model, catalog);
  const age = nowMs - Date.parse(catalog.fetchedAt ?? '');
  return catalog.source === 'cli' && age >= 0 && age <= DEVIN_MODELS_MAX_AGE_MS
    && resolved?.id === model && resolved.pricing.free === true && !model.endsWith('-lightning');
}

export function runDevinAcpSeat(
  opts: Omit<AcpSeatOptions, 'command' | 'args' | 'qualifyModel' | 'planModelStep'> & { cliPath: string; catalog: DevinModelCatalog },
  deps: AcpSeatDeps = {},
) {
  return runAcpSeatTurn({ ...opts, command: opts.cliPath, args: devinAcpSeatArgs(opts.model),
    planModelStep: nextDevinModelStep,
    qualifyModel: (model) => devinQualifiedFreeModel(opts.catalog, model) }, deps);
}
