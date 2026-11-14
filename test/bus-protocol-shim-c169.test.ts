/**
 * RQ-PHX-REDTESTFIXC169 — regression coverage for the #5126 CI failure.
 *
 * PR #5126 added `import { protocolIssue } from './bus-protocol.js'` to
 * bus-envelope.ts. bus-envelope.ts sits inside the Tier-1 authority import
 * closure, so the new edge pulled src/core/fleet/bus-protocol.ts into it and
 * failed test/authority-tier1-closure-310b.test.ts ("the runtime import
 * closure has not grown"). The fix keeps the protocol API reachable from
 * bus-protocol.ts as a pure re-export while the implementation lives in
 * bus-envelope.ts, already a closure member. These tests pin that boundary:
 * no closure member may import bus-protocol.js, and the shim keeps exporting
 * the full protocol surface.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CLOSURE_MEMBERS = ['src/core/fleet/bus-envelope.ts', 'src/core/fleet/bus-inbox.ts', 'src/core/fleet/bus-work-claims.ts'];

describe('bus-protocol re-export boundary (Tier-1 closure flat)', () => {
  it('no Tier-1 closure member imports ./bus-protocol.js', () => {
    const offenders: string[] = [];
    for (const rel of CLOSURE_MEMBERS) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (/from\s+['"]\.\/bus-protocol\.js['"]|import\s*\(\s*['"]\.\/bus-protocol\.js['"]/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders, 'closure members importing bus-protocol.js grow the Tier-1 closure').toEqual([]);
  });

  it('bus-protocol.ts itself never gains an implementation edge into the closure', () => {
    // The shim may only re-export; a local import would hide implementation
    // growth behind the stable import path. Comments are stripped so prose
    // mentioning imports cannot trip the scan.
    const shim = readFileSync(join(ROOT, 'src/core/fleet/bus-protocol.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const imports = shim.match(/import\s+(?!type\s)[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
    expect(imports).toEqual([]);
  });

  it('exports the complete protocol API through bus-protocol.js', async () => {
    const shim = await import('../src/core/fleet/bus-protocol.js');
    for (const name of [
      'BUS_PAYLOAD_REF_MAX',
      'BUS_PROTOCOL_KEY',
      'BUS_PROTOCOL_KINDS',
      'BUS_PROTOCOL_VERSION',
      'BUS_TOPIC_NAMESPACES',
      'isClaimableWork',
      'isTopicName',
      'isTopicPattern',
      'protocolIssue',
      'protocolOf',
      'topicMatches',
    ] as const) {
      expect(shim[name as keyof typeof shim], `bus-protocol.js must export ${name}`).toBeDefined();
    }
    expect(shim.BUS_PROTOCOL_VERSION).toBe(1);
    expect(shim.BUS_PROTOCOL_KINDS).toContain('task');
  });

  it('shim calls reach the implementation (protocolIssue / isClaimableWork)', async () => {
    const { protocolIssue, isClaimableWork } = await import('../src/core/fleet/bus-protocol.js');
    expect(protocolIssue({ to: 'fleet.deploy', body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } } })).toBeUndefined();
    expect(protocolIssue({ to: 'fleet.deploy', body: { protocol: 'nope' } })).toBe('Protocol must be an object.');
    expect(isClaimableWork({ kind: 'work' })).toBe(true);
    expect(isClaimableWork({ protocol: { version: 1, kind: 'task' } })).toBe(true);
    expect(isClaimableWork({ kind: 'note' })).toBe(false);
  });
});
