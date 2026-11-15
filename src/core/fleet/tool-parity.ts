/** A projection of explicit launch evidence, not a test of live availability. */
export const TOOL_CAPABILITIES = ['mcp', 'webSearch', 'browser', 'computerUse', 'skills', 'gh'] as const;
export type ToolCapability = typeof TOOL_CAPABILITIES[number];
export type ToolParityValue = 'yes' | 'no' | 'unknown';

/** Only an explicit boolean is evidence. Omitted or unreadable fields are unknown. */
export interface LaneToolEvidence {
  lane: string;
  capabilities?: Partial<Record<ToolCapability, boolean | null>>;
}

export interface ToolParityReport {
  lanes: Array<{ lane: string; capabilities: Record<ToolCapability, ToolParityValue> }>;
  gaps: Array<{ capability: ToolCapability; lanes: string[] }>;
}

export function buildToolParity(evidence: readonly LaneToolEvidence[]): ToolParityReport {
  const lanes = evidence.map(({ lane, capabilities }) => ({
    lane,
    capabilities: Object.fromEntries(TOOL_CAPABILITIES.map((capability) => {
      const value = capabilities?.[capability];
      return [capability, value === true ? 'yes' : value === false ? 'no' : 'unknown'];
    })) as Record<ToolCapability, ToolParityValue>,
  }));
  const gaps = TOOL_CAPABILITIES.map((capability) => ({
    capability,
    lanes: lanes.filter((lane) => lane.capabilities[capability] === 'no').map((lane) => lane.lane),
  })).filter((gap) => gap.lanes.length > 0)
    .sort((a, b) => b.lanes.length - a.lanes.length || a.capability.localeCompare(b.capability));
  return { lanes, gaps };
}
