/**
 * fleet_waste_risk — the `ashlr fleet waste-risk` advisory projected for MCP:
 * per lane the projected unused included capacity at reset, the waste_risk
 * level and recommended_target, plus the count of high-risk lanes. A
 * projection only: it authorizes no target, hold or dispatch change, and a
 * failed or missing read is reported as unavailable, never as healthy lanes.
 */
import { readWasteRiskInputs } from '../core/resources/waste-risk-read.js';
import { projectWasteRisk, type WasteRiskProjection } from '../core/resources/waste-risk.js';

const SCHEMA = 'fleet.waste-risk.mcp.v1' as const;
const RANK = { high: 0, medium: 1, low: 2, unknown: 3 } as const;

export interface FleetWasteRiskV1 {
  schema: typeof SCHEMA;
  generatedAt: string;
  lanes: WasteRiskProjection[];
  high: number;
  available: boolean;
}

/** Zero-argument tool: only an empty object is valid input. */
export function parseFleetWasteRiskArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

const generatedAtOf = (now?: () => number): string => {
  try { return new Date((now ?? Date.now)()).toISOString(); }
  catch { return new Date(0).toISOString(); }
};

export async function readFleetWasteRiskTool(
  deps: { read?: typeof readWasteRiskInputs; now?: () => number } = {},
): Promise<FleetWasteRiskV1> {
  const generatedAt = generatedAtOf(deps.now);
  try {
    const inputs = await (deps.read ?? readWasteRiskInputs)(undefined, generatedAt);
    const lanes = inputs.map(projectWasteRisk)
      .sort((a, b) => RANK[a.waste_risk] - RANK[b.waste_risk] || a.lane.localeCompare(b.lane));
    return { schema: SCHEMA, generatedAt, lanes, high: lanes.filter(l => l.waste_risk === 'high').length, available: true };
  } catch {
    return { schema: SCHEMA, generatedAt, lanes: [], high: 0, available: false };
  }
}
