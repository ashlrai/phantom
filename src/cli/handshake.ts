/**
 * `phm --ashlr-handshake [--json]`: the Ashlr companion handshake v1
 * (same contract as `stack`, `locus` and `ashlr-plugin --ashlr-handshake`).
 * Fast and local: no network, no vault or keychain, no secret values. Prints
 * one JSON object and exits 0.
 *
 * `local-inference-probe` means `phm doctor` and `phm status --json` probe the
 * configured local inference server (loopback GET <baseUrl>/models only).
 */
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_PATH } from '../core/config.js';
import { parseLocalInferenceConfig } from '../core/run/local-inference.js';

export const PHM_HANDSHAKE_CAPABILITIES = [
  'doctor',
  'status-json',
  'phantom-preflight',
  'custody-ledger',
  'run-receipts',
  'local-inference-probe',
] as const;

type CheckStatus = 'ok' | 'missing' | 'absent';

function localInferenceCheck(configPath: string): CheckStatus {
  try {
    if (!existsSync(configPath)) return 'absent';
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const r = parseLocalInferenceConfig(raw?.['localInference']);
    if (!r.ok) return 'missing';
    return r.config ? 'ok' : 'absent';
  } catch {
    return 'absent';
  }
}

export function buildPhmHandshake(version: string, opts: { configPath?: string } = {}): Record<string, unknown> {
  const configPath = opts.configPath ?? CONFIG_PATH;
  const li = localInferenceCheck(configPath);
  const checks = [{ id: 'local-inference-config', status: li }];
  return {
    kind: 'ashlr.handshake',
    schema_version: 1,
    name: 'phantom',
    command: 'phm',
    version,
    protocols: { 'ashlr.handshake': 1, 'phantom.agent.preflight': 1, 'receipt.v1': 1 },
    capabilities: [...PHM_HANDSHAKE_CAPABILITIES],
    health: { status: li === 'missing' ? 'degraded' : 'ok', checks },
    edits: ['~/.ashlr/'],
    receipts: ['receipt.v1'],
  };
}
