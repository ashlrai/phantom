import { describe, expect, it } from 'vitest';
import { buildToolParity } from '../src/core/fleet/tool-parity.js';

describe('lane tool parity projection', () => {
  it('keeps missing evidence unknown and ranks only explicit gaps across three lanes', () => {
    const report = buildToolParity([
      { lane: 'first', capabilities: { mcp: true, browser: false, gh: false } },
      { lane: 'second', capabilities: { mcp: false, browser: false, skills: null } },
      { lane: 'third' },
    ]);
    expect(report.lanes[0]?.capabilities.mcp).toBe('yes');
    expect(report.lanes[1]?.capabilities.skills).toBe('unknown');
    expect(Object.values(report.lanes[2]!.capabilities)).toEqual(Array(6).fill('unknown'));
    expect(report.gaps).toEqual([
      { capability: 'browser', lanes: ['first', 'second'] },
      { capability: 'gh', lanes: ['first'] },
      { capability: 'mcp', lanes: ['second'] },
    ]);
  });
});
