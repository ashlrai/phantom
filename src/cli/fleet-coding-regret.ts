/**
 * `phm fleet coding-regret --evidence <file>`: print per-job regret as JSON.
 * Offline and read-only. The only input is the one explicit evidence file
 * the caller names. There is no home, config, session or environment discovery,
 * no network, no process launches and no disk writes. Alternatives are modelled scores,
 * not proof of current eligibility or quota.
 */
import { readFileSync, statSync } from 'node:fs';

import {
  computeRegret,
  parseRegretEvidence,
  RegretEvidenceError,
} from '../core/providers/coding-cli/regret-report.js';

/** Evidence files are small JSON; anything larger is refused before it is read. */
export const CODING_REGRET_MAX_EVIDENCE_BYTES = 1024 * 1024;

const USAGE = `Usage: phm fleet coding-regret --evidence <file>
Read one explicit JSON evidence file (recorded outcomes, arm state and scoring config)
and print per-job regret as JSON. Only observed arms are compared; unobserved arms are
unknown and never create an advantage. Alternatives are modelled posterior scores, not
proof of current eligibility or available quota. Nothing is written, routed or dispatched.`;

/** Offline. Output goes through the injected writers; defaults are console.log / console.error. */
export async function cmdFleetCodingRegret(
  args: string[],
  out: (line: string) => void = (line) => console.log(line),
  err: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }
  let evidencePath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--evidence') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err(`error: --evidence requires a file path\n${USAGE}`);
        return 2;
      }
      if (evidencePath !== null) {
        err(`error: --evidence given more than once\n${USAGE}`);
        return 2;
      }
      evidencePath = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      err(`error: unknown flag ${JSON.stringify(arg)}\n${USAGE}`);
      return 2;
    } else {
      err(`error: unexpected argument ${JSON.stringify(arg)}\n${USAGE}`);
      return 2;
    }
  }
  if (evidencePath === null) {
    err(`error: --evidence <file> is required\n${USAGE}`);
    return 2;
  }

  let raw: unknown;
  try {
    const stat = statSync(evidencePath);
    if (!stat.isFile()) {
      err('error: evidence path is not a regular file');
      return 1;
    }
    if (stat.size > CODING_REGRET_MAX_EVIDENCE_BYTES) {
      err(`error: evidence file exceeds ${CODING_REGRET_MAX_EVIDENCE_BYTES} bytes`);
      return 1;
    }
    raw = JSON.parse(readFileSync(evidencePath, 'utf8')) as unknown;
  } catch (cause) {
    // Report the failure class only. Parser messages can echo file content, so they are not printed.
    const code = (cause as NodeJS.ErrnoException).code;
    err(code ? `error: could not read evidence file (${code})` : 'error: evidence file is not valid JSON');
    return 1;
  }

  try {
    out(JSON.stringify(computeRegret(parseRegretEvidence(raw)), null, 2));
    return 0;
  } catch (cause) {
    if (cause instanceof RegretEvidenceError) {
      err(`error: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}
