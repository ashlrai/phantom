/**
 * Phantom telemetry (docs/architecture/metrics.md). Local-first, append-only
 * JSONL at $ASHLR_HOME/metrics/events.jsonl; sharing is opt-in. Secret-shaped
 * values are refused, never recorded.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ashlrHome } from '../cloud/store.js';
import { assertNoSecrets } from '../teams/store.js';

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/** Dimensions every event is attributed to. */
export interface Attribution { sessionId: string; agent: string; model?: string; resource?: string; strategy?: string; process?: string; taskType?: string; repo?: string; owner?: 'personal' | 'company' | `client:${string}` }

export type TelemetryEvent =
  | ({ kind: 'session.started' } & Base)
  | ({ kind: 'session.ended'; outcome: 'success' | 'failure' | 'abandoned'; wallMs: number } & Base)
  | ({ kind: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number; wallMs?: number } & Base)
  | ({ kind: 'tool.called'; tool: string; ok: boolean; ms?: number } & Base)
  | ({ kind: 'pr.opened' | 'pr.merged' | 'pr.reverted'; pr: PrRef } & Base)
  | ({ kind: 'pr.rated'; pr: PrRef; rater: 'human' | 'llm-judge'; rating: number /* 1..5 */; rubric?: string } & Base);

interface Base extends Attribution { v: typeof TELEMETRY_SCHEMA_VERSION; id: string; ts: string }
export interface PrRef { repo: string; number: number; additions?: number; deletions?: number; files?: number; areas?: string[]; userFacing?: boolean; risk?: 'low' | 'medium' | 'high'; ciPassedFirstTry?: boolean; reviewFindings?: number; followUpFixes?: number; coverageDelta?: number; deployedToProduction?: boolean }

export function metricsFile(): string { return join(ashlrHome(), 'metrics', 'events.jsonl'); }

export type TelemetryInput = Omit<TelemetryEvent, 'v' | 'id' | 'ts'> & { ts?: string };
export function recordEvent(input: TelemetryInput): TelemetryEvent {
  assertNoSecrets(input);
  if (!input.sessionId || !input.agent) throw new Error('sessionId and agent are required.');
  const ev = { v: TELEMETRY_SCHEMA_VERSION, id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, ts: input.ts ?? new Date().toISOString(), ...input } as TelemetryEvent;
  mkdirSync(join(ashlrHome(), 'metrics'), { recursive: true });
  appendFileSync(metricsFile(), JSON.stringify(ev) + '\n', { mode: 0o600 });
  return ev;
}

export function readTelemetry(): TelemetryEvent[] {
  if (!existsSync(metricsFile())) return [];
  return readFileSync(metricsFile(), 'utf8').split('\n').flatMap((l) => { try { const e = JSON.parse(l); return e?.v === 1 ? [e as TelemetryEvent] : []; } catch { return []; } });
}
