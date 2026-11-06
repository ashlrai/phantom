/**
 * One-time ask for Safari's own "Import From Google Chrome". This module only
 * asks (one NEEDS-MASON line) and records state; it never reads browser
 * profile stores or credentials and never launches the import.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SafariImportStatus = 'asked' | 'done';
export interface SafariImportState { v: 1; status: SafariImportStatus; askedAt?: string; doneAt?: string }
export type SafariImportPlan = 'ask' | 'waiting' | 'done';

export const SAFARI_IMPORT_LINE =
  'Safari for Phantom: open Safari > File > Import From > Google Chrome once (passwords, bookmarks, history), then run: ashlr fleet safari-import --done';

export class SafariImportStateError extends Error {
  readonly code = 'safari-import-state-malformed';
  constructor(readonly path: string) {
    super(`Safari import state at ${path} is malformed; fix or remove it by hand.`);
    this.name = 'SafariImportStateError';
  }
}

const stateFile = (runsDir: string): string => join(runsDir, 'state', 'safari-import.json');
const iso = (value: unknown): boolean => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function parseState(value: unknown): SafariImportState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some(k => !['v', 'status', 'askedAt', 'doneAt'].includes(k))) return null;
  if (o.v !== 1 || (o.status !== 'asked' && o.status !== 'done')) return null;
  if (o.askedAt !== undefined && !iso(o.askedAt)) return null;
  if (o.doneAt !== undefined && !iso(o.doneAt)) return null;
  return o as unknown as SafariImportState;
}

/** Missing file is null; present but unparseable throws and is never overwritten. */
export function readSafariImportState(runsDir: string): SafariImportState | null {
  const path = stateFile(runsDir);
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SafariImportStateError(path);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new SafariImportStateError(path); }
  const state = parseState(parsed);
  if (!state) throw new SafariImportStateError(path);
  return state;
}

export function planSafariImport(state: SafariImportState | null): SafariImportPlan {
  return state === null ? 'ask' : state.status === 'done' ? 'done' : 'waiting';
}

function writeState(runsDir: string, state: SafariImportState): void {
  const path = stateFile(runsDir);
  mkdirSync(join(runsDir, 'state'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

export interface SafariImportApplyInput { runsDir: string; now: () => Date; appendNeedsLine: (line: string) => void }

export function applySafariImport(input: SafariImportApplyInput): SafariImportPlan {
  const plan = planSafariImport(readSafariImportState(input.runsDir));
  if (plan !== 'ask') return plan;
  input.appendNeedsLine(SAFARI_IMPORT_LINE);
  writeState(input.runsDir, { v: 1, status: 'asked', askedAt: input.now().toISOString() });
  return plan;
}

export function markSafariImportDone(input: { runsDir: string; now: () => Date }): SafariImportState {
  const prior = readSafariImportState(input.runsDir);
  const state: SafariImportState = { v: 1, status: 'done', ...(prior?.askedAt ? { askedAt: prior.askedAt } : {}), doneAt: input.now().toISOString() };
  writeState(input.runsDir, state);
  return state;
}
