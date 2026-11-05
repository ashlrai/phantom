/**
 * fleet_email_diagnosis — "why are local email replies not flowing?" answered
 * through the isolated fleet MCP server, so a Comms agent can diagnose the
 * email leg without a shell or mail access. The saved email-drop config and
 * reply outbox are read at the server-owned runs dir (never a
 * caller-supplied directory, root or cwd) and the diagnosis delegates to the
 * same diagnoseEmailDrop `phm comms diagnose` uses — never a second
 * classifier. The result carries its fixed-code config, polling, sendReplies,
 * outbox and replies states, observed counts and checks plus the
 * local-evidence-only coverage marker — never paths, addresses, subjects,
 * bodies or exception text. A collector failure is fixed unavailable
 * evidence, never an invented healthy diagnosis. The tool never sends,
 * drafts, retries or writes comms config: sendReplies and confirmedByMason
 * stay exactly as saved.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { diagnoseEmailDrop, type EmailDiagnosis } from '../core/comms/email-diagnosis.js';

export type FleetEmailDiagnosisSourceState = 'ok' | 'unavailable';

export interface FleetEmailDiagnosisReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** 'ok' once the shared collector ran; 'unavailable' when it could not. */
  sourceState: FleetEmailDiagnosisSourceState;
  /** Scope marker survives even an unavailable read: local evidence only. */
  coverage: 'local-evidence-only-not-gmail-triage-or-proof-of-delivery';
  /** The shared fixed-code diagnosis; null when the collector could not run. */
  diagnosis: EmailDiagnosis | null;
}

export interface FleetEmailDiagnosisDeps {
  /** Email-drop runs root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  /** Diagnosis collector; default diagnoseEmailDrop (test seam). */
  diagnose?: (runsDir: string) => Promise<EmailDiagnosis>;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. This tool
 * takes no arguments — a caller-supplied dir, root, cwd, path or send option
 * is an argument error, rejected before any filesystem read.
 */
export function parseFleetEmailDiagnosisArgs(args: Record<string, unknown>): Record<string, never> | null {
  return Object.keys(args).length === 0 ? {} : null;
}

/**
 * Delegates to diagnoseEmailDrop at the server-owned runs dir and returns
 * its diagnosis verbatim: every state and reason inside is already a fixed
 * code, so nothing private can leave through it. A throwing collector — a
 * broken dependency, not a classifiable state — degrades to
 * sourceState 'unavailable' with a null diagnosis rather than healthy empty
 * counts or raw error text. Only read paths are touched: no send, draft,
 * retry or comms-config write of any kind.
 */
export async function readFleetEmailDiagnosis(
  deps: FleetEmailDiagnosisDeps = {},
): Promise<FleetEmailDiagnosisReport> {
  const base = {
    schemaVersion: 1 as const,
    snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    generatedAt: new Date().toISOString(),
    coverage: 'local-evidence-only-not-gmail-triage-or-proof-of-delivery' as const,
  };
  try {
    const diagnosis = await (deps.diagnose ?? diagnoseEmailDrop)(deps.runsDir ?? join(homedir(), '.ashlr-runs'));
    return { ...base, sourceState: 'ok', diagnosis };
  } catch {
    return { ...base, sourceState: 'unavailable', diagnosis: null };
  }
}
