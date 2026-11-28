import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  asIntegrationRecord, isIntegrationRecord, parseJsonRecord, unwrapJsonArray,
} from '../src/core/integrations/dep-parser.js';
import { escapeAppleScript } from '../src/core/integrations/desktop-notify.js';
import { ASHLR_HUB_MCP_SERVER } from '../src/core/integrations/editors.js';
import { GATEWAY_MCP_SERVER } from '../src/core/integrations/gateway-entry.js';
import {
  buildPulseExporterConfig, isGlobalKillSwitchOn, resolveFleetPulsePat,
} from '../src/core/integrations/pulse-exporter.js';

const ENV_KEYS = ['HOME', 'PULSE_FLEET_PAT', 'ASHLR_PULSE_READ_PAT', 'ASHLR_PULSE_PAT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const tempDirs: string[] = [];

function snapshotEnv(): void {
  for (const key of ENV_KEYS) if (!(key in savedEnv)) savedEnv[key] = process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) continue;
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
    delete savedEnv[key];
  }
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('integrations shared helpers', () => {
  it('narrows plain records, parses JSON records, and unwraps array wrappers', () => {
    const obj = { ok: true };
    expect(isIntegrationRecord(obj)).toBe(true);
    expect(asIntegrationRecord(obj)).toBe(obj);
    for (const bad of [null, undefined, 'x', 1, true, []]) {
      expect(isIntegrationRecord(bad)).toBe(false);
      expect(asIntegrationRecord(bad)).toBeNull();
    }
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonRecord('[1,2]')).toBeNull();
    expect(parseJsonRecord('not-json')).toBeNull();
    expect(unwrapJsonArray([1, 2], ['items'])).toEqual([1, 2]);
    expect(unwrapJsonArray({ data: ['a'] }, ['commands', 'data'])).toEqual(['a']);
    expect(unwrapJsonArray({ other: ['a'] }, ['commands', 'data'])).toBeNull();
    expect(unwrapJsonArray('nope', ['data'])).toBeNull();
  });

  it('escapes backslashes, quotes, and CR/LF for AppleScript literals', () => {
    expect(escapeAppleScript('say "hi"\\path\r\nnext\rline\nend')).toBe('say \\"hi\\"\\\\path  next line end');
  });

  it('shares the canonical gateway server key between editors and gateway-entry', () => {
    expect(ASHLR_HUB_MCP_SERVER).toBe(GATEWAY_MCP_SERVER);
  });

  it('builds Pulse exporter config and resolves fleet PAT precedence', () => {
    expect(buildPulseExporterConfig({ user: { id: 'u1', name: 'Alice' } }, 'https://pulse.example')).toEqual({
      pulse: { enabled: true, endpoint: 'https://pulse.example' },
      user: { id: 'u1', name: 'Alice' },
    });
    expect(buildPulseExporterConfig({}, undefined)).toEqual({ pulse: { enabled: true, endpoint: undefined } });

    snapshotEnv();
    for (const k of ['PULSE_FLEET_PAT', 'ASHLR_PULSE_READ_PAT', 'ASHLR_PULSE_PAT'] as const) delete process.env[k];
    expect(resolveFleetPulsePat()).toBeNull();
    process.env['ASHLR_PULSE_PAT'] = 'pat-ingest';
    expect(resolveFleetPulsePat()).toBe('pat-ingest');
    process.env['ASHLR_PULSE_READ_PAT'] = 'pat-read';
    expect(resolveFleetPulsePat()).toBe('pat-read');
    process.env['PULSE_FLEET_PAT'] = 'pat-fleet';
    expect(resolveFleetPulsePat()).toBe('pat-fleet');
  });

  it('reads global KILL switch status from ~/.ashlr/KILL', () => {
    snapshotEnv();
    const home = mkdtempSync(join(tmpdir(), 'ashlr-int-helpers-'));
    tempDirs.push(home);
    process.env['HOME'] = home;
    expect(isGlobalKillSwitchOn()).toBe(false);
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'KILL'), 'stop\n', 'utf8');
    expect(isGlobalKillSwitchOn()).toBe(true);
  });
});
