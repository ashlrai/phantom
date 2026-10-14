/**
 * Producer → consumer contract: real `locus` CLI output → Phantom's Locus parsers and gates.
 *
 * Fixtures under test/fixtures/locus-contract/<version>/ are captured from the exact Locus
 * release Phantom pins in companion-inventory.ts (see manifest.json for the source commit),
 * by scripts/capture-locus-contract-fixtures.mjs in a throwaway LOCUS_HOME with sample
 * bindings and no credentials. The published schemas are copied from that same commit.
 * Hand-written fixtures in locus.probe.test.ts describe what Phantom expects; these describe
 * what Locus actually emits.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPANION_RELEASES } from '../src/core/companion-inventory.js';
import {
  AGENT_REPORT_STABLE_KEYS,
  MCP_COMMAND,
  REQUIRED_SERVERS,
  evaluateFleetGate,
  missingAgentReportKeys,
  parseAgentReportJson,
  parseSessionVerificationPack,
  parseStatusOneline,
  parseWatchHeartbeat,
} from '../src/core/integrations/locus.js';

const locusRelease = COMPANION_RELEASES.find(release => release.id === 'locus')!;
const dir = join(__dirname, 'fixtures', 'locus-contract', locusRelease.version);
const read = (...parts: string[]) => readFileSync(join(dir, ...parts), 'utf8');

interface Manifest {
  producer: string;
  version: string;
  sourceCommit: string;
  scenarios: Record<string, { capabilityExported: boolean; exits: Record<string, number> }>;
}
const manifest = JSON.parse(read('manifest.json')) as Manifest;
const scenarios = Object.keys(manifest.scenarios);

interface JsonSchema {
  required?: string[];
  properties?: Record<string, { type?: string | string[]; enum?: unknown[]; required?: string[] }>;
}
const agentReportSchema = JSON.parse(read('agent-report.schema.json')) as JsonSchema;
const doctorSchema = JSON.parse(read('doctor.schema.json')) as JsonSchema;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Required keys, scalar types and enums of the published top-level schema. */
function schemaViolations(schema: JsonSchema, value: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of schema.required ?? []) if (!(key in value)) out.push(`missing ${key}`);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in value)) continue;
    const actual = typeOf(value[key]);
    const allowed = prop.type === undefined ? [] : [prop.type].flat();
    if (allowed.length > 0 && !allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      out.push(`${key}: ${actual} not in ${allowed.join('|')}`);
    }
    if (prop.enum && !prop.enum.includes(value[key])) out.push(`${key}: ${JSON.stringify(value[key])} not in enum`);
    if (prop.required && actual === 'object') {
      for (const nested of prop.required) {
        if (!(nested in (value[key] as Record<string, unknown>))) out.push(`missing ${key}.${nested}`);
      }
    }
  }
  return out;
}

describe('locus producer contract fixtures', () => {
  it('match the Locus release Phantom pins', () => {
    expect(manifest.producer).toBe('locus');
    expect(manifest.version).toBe(locusRelease.version);
    expect(manifest.sourceCommit).toBe(locusRelease.sourceCommit);
    expect(read('version.txt').trim()).toBe(`locus ${locusRelease.version}`);
    expect(read('help.txt')).toMatch(/^Usage:\s+locus(?:\s|$)/imu);
    expect(scenarios).toEqual(['fresh-home', 'pinned-capability-not-exported', 'pinned-capability-exported']);
  });

  it('Phantom stable agent-report keys are exactly the published required keys', () => {
    expect([...AGENT_REPORT_STABLE_KEYS].sort()).toEqual([...(agentReportSchema.required ?? [])].sort());
  });
});

describe.each(scenarios)('locus %s output', scenario => {
  const meta = manifest.scenarios[scenario]!;
  const rawReport = read(scenario, 'agent-report.json');
  const json = JSON.parse(rawReport) as Record<string, unknown>;

  it('agent report satisfies the published schemas and parses with no missing keys', () => {
    expect(schemaViolations(agentReportSchema, json)).toEqual([]);
    expect(schemaViolations(doctorSchema, json.doctor as Record<string, unknown>)).toEqual([]);
    expect(missingAgentReportKeys(json)).toEqual([]);
    const report = parseAgentReportJson(rawReport);
    expect(report.version).toBe(locusRelease.version);
    expect(report.required_servers).toEqual([...REQUIRED_SERVERS]);
    expect(report.mcp_command).toBe(MCP_COMMAND);
    // The CLI exit code is the report's own exit_code (ready=0, protected=1, unsafe=2).
    expect(report.exit_code).toBe(meta.exits['agent-report.json']);
  });

  it('agent report keeps credential state value-free', () => {
    expect(rawReport).not.toMatch(/"(?:token|secret|value|control_capability)"\s*:/u);
  });

  it('none of these sandbox states lets the fleet gate dispatch', () => {
    const gate = evaluateFleetGate(parseAgentReportJson(rawReport));
    expect(gate.allowDispatch).toBe(false);
    expect(gate.gateOk).toBe(false);
    expect(gate.blockers).toContain('ready=false');
    // The hub contract half of the gate is satisfied by real output.
    expect(gate.blockers.filter(b => b.includes('required_servers') || b.includes('mcp_command'))).toEqual([]);
  });

  it('status --oneline, watch tick and verify pack parse into consistent pin state', () => {
    const oneline = parseStatusOneline(read(scenario, 'status-oneline.txt'));
    const watch = parseWatchHeartbeat(read(scenario, 'watch-once.json'));
    const pack = parseSessionVerificationPack(read(scenario, 'verify-session.json'));
    expect(watch.source).toBe('watch');
    expect(['SAFE', 'WARN', 'UNSAFE']).toContain(watch.doctor_verdict);
    expect(watch.pinned).toBe(oneline.kind !== 'unpinned');
    expect(pack.kind).toBe('session');
    expect(pack.version).toBe(locusRelease.version);
    expect(pack.session_ok).toBe(watch.session_ok);
    expect(pack.safe_next?.action).toBe(watch.safe_next);
    expect(typeof pack.safe_next?.ready).toBe('boolean');
  });
});

describe('locus pin states Phantom must tell apart', () => {
  const report = (scenario: string) => parseAgentReportJson(read(scenario, 'agent-report.json'));

  it('fresh home is unpinned everywhere', () => {
    expect(report('fresh-home').status_oneline).toBe('unpinned');
    expect(parseStatusOneline(read('fresh-home', 'status-oneline.txt')).kind).toBe('unpinned');
    expect(parseWatchHeartbeat(read('fresh-home', 'watch-once.json')).safe_next).toBe('init');
  });

  it('a pin without the exported control capability reads invalid in the agent report', () => {
    // `locus status --oneline` still prints alias:tenant here; the agent report, which the
    // fleet gate uses, marks the pin invalid because the authority anchor is unverified.
    expect(report('pinned-capability-not-exported').status_oneline).toBe('invalid');
    expect(parseStatusOneline(read('pinned-capability-not-exported', 'status-oneline.txt')).healthy).toBe(true);
    const gate = evaluateFleetGate(report('pinned-capability-not-exported'));
    expect(gate.blockers).toContain('pin unhealthy: invalid (invalid)');
  });

  it('a pin with the exported capability is healthy but still not ready without Phantom or MCP setup', () => {
    const r = report('pinned-capability-exported');
    expect(parseStatusOneline(r.status_oneline)).toMatchObject({ kind: 'pinned', alias: 'personal', tenant: 'personal', healthy: true });
    expect(r.pin?.seal_ok).toBe(true);
    expect(r.status).toBe('protected');
    expect(parseWatchHeartbeat(read('pinned-capability-exported', 'watch-once.json'))).toMatchObject({
      whoami: 'personal', pinned: true, safe_next: 'ready', session_ok: false,
    });
  });
});
