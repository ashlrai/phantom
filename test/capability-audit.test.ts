import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_AUDIT_SCHEMA,
  CAPABILITY_SURFACES,
  buildCapabilityAudit,
  formatCapabilityAudit,
} from '../src/core/fleet/capability-audit.js';
import { cmdFleetCapabilityAudit } from '../src/cli/fleet-capability-audit.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

describe('capability audit catalog', () => {
  it('keeps unique ids and a stable schema', () => {
    const ids = CAPABILITY_SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const report = buildCapabilityAudit(new Date('2026-11-09T04:00:00.000Z'));
    expect(report.schema).toBe(CAPABILITY_AUDIT_SCHEMA);
    expect(report.generatedAt).toBe('2026-11-09T04:00:00.000Z');
    expect(report.counts.surfaces).toBe(CAPABILITY_SURFACES.length);
    expect(report.counts.implementableNow).toBe(report.implementableNow.length);
  });

  it('ranks gaps by leverage descending and marks only GATES-safe gap/partial as implementable', () => {
    const report = buildCapabilityAudit(new Date('2026-11-09T04:00:00.000Z'));
    const leverages = report.gaps.map((g) => g.leverage);
    expect(leverages).toEqual([...leverages].sort((a, b) => b - a));
    expect(report.gaps[0]?.id).toBe('apps-open-focus');
    for (const gap of report.implementableNow) {
      expect(gap.gatesSafe).toBe(true);
      expect(['gap', 'partial']).toContain(gap.status);
      expect(gap.implementNow).toBe(true);
    }
    expect(report.implementableNow.some((g) => g.id === 'tool-mesh-run')).toBe(false);
    expect(report.gaps.some((g) => g.id === 'tool-mesh-run' && !g.implementNow)).toBe(true);
  });

  it('formats a human summary with NOW tags for implementable gaps', () => {
    const text = formatCapabilityAudit(buildCapabilityAudit(new Date('2026-11-09T04:00:00.000Z')));
    expect(text).toContain('Capability audit (capability-audit.v1)');
    expect(text).toContain('L10 [NOW] apps-open-focus');
    expect(text).toContain('tool-mesh-run');
  });
});

describe('phm fleet capability-audit', () => {
  it('is registered and exports the convention handler', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['capability-audit']!();
    expect(mod.cmdFleetCapabilityAudit).toBe(cmdFleetCapabilityAudit);
  });

  it('prints JSON and human forms; rejects unknown flags', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const out = { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) };
    expect(await cmdFleetCapabilityAudit(['--help'], { output: out })).toBe(0);
    expect(logs[0]).toContain('phm fleet capability-audit');
    logs.length = 0;
    expect(await cmdFleetCapabilityAudit(['--json'], {
      output: out,
      now: () => new Date('2026-11-09T04:00:00.000Z'),
    })).toBe(0);
    const report = JSON.parse(logs[0]!);
    expect(report.schema).toBe(CAPABILITY_AUDIT_SCHEMA);
    expect(report.gaps[0].id).toBe('apps-open-focus');
    logs.length = 0;
    expect(await cmdFleetCapabilityAudit([], { output: out, now: () => new Date('2026-11-09T04:00:00.000Z') })).toBe(0);
    expect(logs[0]).toContain('Ranked gaps:');
    expect(await cmdFleetCapabilityAudit(['--nope'], { output: out })).toBe(2);
    expect(errors[0]).toContain('unknown option');
  });
});
