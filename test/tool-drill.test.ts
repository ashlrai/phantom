import { describe, expect, it } from 'vitest';
import { generateToolDrills, gradeToolDrill } from '../src/core/tune/tool-drill.js';

describe('fixture-only tool drills', () => {
  const fixture = { id: 'one', prompt: 'List fixture items', expected: 'tool list --json' };
  it('prefers CLI and falls back to MCP without executing either', () => {
    const drills = generateToolDrills([
      { id: 'a', cli: 'dangerous command', mcp: 'remote', fixtures: [fixture] },
      { id: 'b', mcp: 'remote', fixtures: [fixture] },
    ]);
    expect(drills.map(d => d.interface)).toEqual(['cli', 'mcp']);
    expect(gradeToolDrill(drills[0]!, ' tool list --json\n')).toBe(true);
    expect(gradeToolDrill(drills[0]!, 'tool delete')).toBe(false);
    expect(JSON.stringify(drills)).not.toContain('dangerous command');
  });
  it('rejects ambiguous and incomplete fixtures', () => {
    expect(() => generateToolDrills([{ id: 'a', cli: 'x', fixtures: [fixture, fixture] }])).toThrow();
    expect(() => generateToolDrills([{ id: 'a', fixtures: [fixture] }])).toThrow();
    expect(() => generateToolDrills([{ id: 'a', cli: 'x', fixtures: [{ ...fixture, expected: '' }] }])).toThrow();
  });
});
