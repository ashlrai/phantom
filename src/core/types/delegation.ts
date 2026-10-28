/** Shared delegation contracts. Public entry point: ../types.ts. */
import type { WorkSource } from './backlog.js';
import type { EngineId, EngineTier } from './engines.js';
import type { RunBudget } from './run.js';

export type DelegationOrigin = 'run' | 'swarm' | 'daemon' | 'best-of-n' | 'manager' | string;

export type DelegationMemoryMode = 'inherit' | 'none' | 'bounded' | 'repo-only' | 'full';

export type DelegationResultKind =
  | 'text'
  | 'diff'
  | 'proposal'
  | 'verified-proposal'
  | 'analysis-only'
  | 'diagnostic';

export interface DelegationAllowedFiles {
  /** Repo-relative globs or path prefixes the delegate should focus on. */
  include?: string[];
  /** Repo-relative globs or path prefixes the delegate should avoid. */
  exclude?: string[];
  /** Advisory in this slice; hard write enforcement is a later gate. */
  enforceWrites?: boolean;
}

export interface DelegationContextBudget {
  maxPromptChars?: number;
  repoMapTokens?: number;
  localizationTokens?: number;
  memoryChars?: number;
  resultChars?: number;
}

export interface DelegationResultContract {
  kind: DelegationResultKind;
  requireDiff?: boolean;
  requireProposal?: boolean;
  requireVerification?: boolean;
  maxChangedFiles?: number;
  maxChangedLines?: number;
}

export interface DelegationBackendSnapshot {
  engine?: EngineId;
  model?: string | null;
  tier?: EngineTier | string | null;
  assignedBy?: string;
  reason?: string;
}

/**
 * Optional advisory contract handed to a delegated run/agent. Raw prompts,
 * diffs, stdout/stderr, env, and file contents must not be stored here.
 */
export interface DelegationScope {
  schemaVersion?: 1;
  origin?: DelegationOrigin;
  sourceRepo?: string;
  executionRoot?: string;
  workItemId?: string;
  workSource?: WorkSource;
  runId?: string;
  swarmId?: string;
  taskId?: string;
  objective?: string;
  allowedFiles?: DelegationAllowedFiles;
  budget?: Partial<RunBudget>;
  contextBudget?: DelegationContextBudget;
  memoryMode?: DelegationMemoryMode;
  resultContract?: DelegationResultContract;
  backend?: DelegationBackendSnapshot;
}

/** Bounded, scrubbed form safe to persist on runs/proposals. */
export interface DelegationScopeSummary {
  schemaVersion: 1;
  origin?: DelegationOrigin;
  sourceRepo?: string;
  executionRoot?: string;
  workItemId?: string;
  workSource?: WorkSource;
  runId?: string;
  swarmId?: string;
  taskId?: string;
  objective?: string;
  allowedFiles?: {
    includeCount: number;
    excludeCount: number;
    includeSamples?: string[];
    excludeSamples?: string[];
    enforceWrites?: boolean;
  };
  budget?: Partial<RunBudget>;
  contextBudget?: DelegationContextBudget;
  memoryMode: DelegationMemoryMode;
  resultContract?: DelegationResultContract;
  backend?: DelegationBackendSnapshot;
}
