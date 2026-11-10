/** Fixture-only tool drills. This module never invokes tools or models. */
import { digest } from './dataset.js';

export interface DrillFixture {
  id: string;
  prompt: string;
  expected: string;
}
export interface DrillTool {
  id: string;
  cli?: string;
  mcp?: string;
  fixtures: DrillFixture[];
}
export interface ToolDrill {
  id: string;
  tool: string;
  interface: 'cli' | 'mcp';
  prompt: string;
  expected: string;
}

/** Only explicitly supplied fixtures are used; no profile command is executed. */
export function generateToolDrills(tools: DrillTool[]): ToolDrill[] {
  if (tools.length > 1000) throw new Error('Tool limit exceeded');
  const ids = new Set<string>();
  const drills: ToolDrill[] = [];
  const valid = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= 10_000;
  for (const tool of tools) {
    if (!valid(tool.id) || (!valid(tool.cli) && !valid(tool.mcp)) || !Array.isArray(tool.fixtures) || tool.fixtures.length > 1000) throw new Error('Invalid tool fixture');
    for (const fixture of tool.fixtures) {
      if (!fixture || !valid(fixture.id) || !valid(fixture.prompt) || !valid(fixture.expected)) throw new Error('Invalid drill fixture');
      const id = digest(JSON.stringify([tool.id, fixture.id]));
      if (ids.has(id)) throw new Error('Duplicate drill fixture');
      ids.add(id);
      drills.push({ id, tool: tool.id, interface: valid(tool.cli) ? 'cli' : 'mcp', prompt: fixture.prompt, expected: fixture.expected });
    }
  }
  return drills;
}

/** Exact matching is intentionally conservative; no model output is executed. */
export function gradeToolDrill(drill: ToolDrill, answer: string): boolean {
  return typeof answer === 'string' && answer.trim() === drill.expected.trim();
}
