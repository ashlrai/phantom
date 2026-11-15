import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSE_FLEET_WORK_BOARD_PATH, VERSE_FLEET_WORK_RESULT_PATH } from '../src/core/verse/fleet-work-board-api.js';
import { VERSE_FLEET_ORDER_STATE_PATH } from '../src/core/verse/fleet-order-state-api.js';

const doc = readFileSync(new URL('../docs/CLOUD-AGENT-ROUTES.md', import.meta.url), 'utf8');
const fleetServer = readFileSync(new URL('../src/mcp/fleet-server.ts', import.meta.url), 'utf8');
const registry = readFileSync(new URL('../src/cli/fleet-subcommand-registry.ts', import.meta.url), 'utf8');
const toolNames = [...fleetServer.matchAll(/\bname:\s*'(fleet_[a-z0-9_]+)'/g)].map(match => match[1]!);

describe('cloud agent routes documentation (373)', () => {
  it('names only exported work-board HTTP paths and covers all three', () => {
    const paths = [...doc.matchAll(/\/api\/verse\/[a-zA-Z0-9_./-]+/g)].map(match => match[0]);
    const supported = [VERSE_FLEET_WORK_BOARD_PATH, VERSE_FLEET_WORK_RESULT_PATH, VERSE_FLEET_ORDER_STATE_PATH];
    expect(new Set(paths)).toEqual(new Set(supported));
  });

  it('names only registered fleet MCP tools', () => {
    const documented = [...doc.matchAll(/\bfleet_[a-z0-9_]+\b/g)].map(match => match[0]);
    expect(documented.length).toBeGreaterThanOrEqual(8);
    for (const tool of documented) expect(toolNames, `Missing documented MCP tool: ${tool}`).toContain(tool);
  });

  it('names only registered CLI verbs and existing coordination subcommands', () => {
    const verbs = [...registry.matchAll(/^\s*'([a-z0-9-]+)':\s*\(\) => import\(/gm)].map(match => match[1]!);
    const documented = [...doc.matchAll(/\bashlr fleet ([a-z0-9-]+)/g)].map(match => match[1]!);
    expect(documented.length).toBeGreaterThanOrEqual(7);
    for (const verb of documented) expect(verbs, `Missing documented CLI verb: ${verb}`).toContain(verb);
    const coordination = readFileSync(new URL('../src/cli/fleet-coordination.ts', import.meta.url), 'utf8');
    const usage = coordination.match(/const USAGE = '([^']+)'/)?.[1] ?? '';
    for (const match of doc.matchAll(/\bashlr fleet coordination ([a-z-]+)/g)) {
      expect(usage.split(/[<>|]/), `Missing coordination subcommand: ${match[1]}`).toContain(match[1]);
    }
  });

  it('requires the no-claim-route statement to be revisited if MCP adds a claim tool', () => {
    expect(doc).toContain('There is no HTTP or MCP claim route.');
    expect(toolNames.filter(name => name.includes('claim')), 'Update CLOUD-AGENT-ROUTES.md: a claim tool now exists').toEqual([]);
  });

  it('contains no email, IPv4 address or URL credentials', () => {
    expect(doc).not.toMatch(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(doc).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(doc).not.toMatch(/:\/\/[^\s/:@]+:[^\s/@]+@/);
  });
});
