/**
 * `phm fleet coding-regret --evidence <file>`: print per-job regret as JSON.
 * Offline and read-only. The only input is the one explicit evidence file
 * the caller names. There is no home, config, session or environment discovery,
 * no network, no process launches and no disk writes. Alternatives are modelled scores,
 * not proof of current eligibility or quota.
 */
import { runCodingEvidenceCli } from '../core/providers/coding-cli/evidence-cli.js';
import {
  computeRegret,
  parseRegretEvidence,
  RegretEvidenceError,
} from '../core/providers/coding-cli/regret-report.js';

/** Evidence files are small JSON; anything larger is refused before it is read. */
const CODING_REGRET_MAX_EVIDENCE_BYTES = 1024 * 1024;

const USAGE = `Usage: phm fleet coding-regret --evidence <file>
Read one explicit JSON evidence file (recorded outcomes, arm state and scoring config)
and print per-job regret as JSON. Only observed arms are compared; unobserved arms are
unknown and never create an advantage. Alternatives are modelled posterior scores, not
proof of current eligibility or available quota. Nothing is written, routed or dispatched.`;

/** Offline. Output goes through the injected writers; defaults are console.log / console.error. */
export async function cmdFleetCodingRegret(
  args: string[],
  out?: (line: string) => void,
  err?: (line: string) => void,
): Promise<number> {
  return runCodingEvidenceCli({
    args,
    usage: USAGE,
    maxBytes: CODING_REGRET_MAX_EVIDENCE_BYTES,
    errorClass: RegretEvidenceError,
    evaluate: (raw) => computeRegret(parseRegretEvidence(raw)),
    out,
    err,
  });
}
