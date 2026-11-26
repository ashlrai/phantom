/**
 * `phm fleet coding-sample --evidence <file>`: print one seeded offline posterior draw as JSON.
 * Offline and read-only. The only input is the one explicit evidence file the caller names.
 * There is no home, config, session or environment discovery, no network, no process
 * launches and no disk writes. The sample is a modelled score. It is not observed
 * performance and grants no execution authority or eligibility.
 */
import { runCodingEvidenceCli } from '../core/providers/coding-cli/evidence-cli.js';
import {
  parsePosteriorSampleEvidence,
  PosteriorSamplingError,
  reportPosteriorSample,
} from '../core/providers/coding-cli/posterior-sampling.js';

/** Evidence is one arm and four numbers. Anything larger is refused before it is read. */
export const CODING_SAMPLE_MAX_EVIDENCE_BYTES = 64 * 1024;

const USAGE = `Usage: phm fleet coding-sample --evidence <file>
Read one explicit JSON evidence file (one posterior arm, a seed and explicit latency/token
formula parameters) and print one seeded offline Thompson draw as JSON. The result is a
modelled score, not observed performance, and grants no execution authority or eligibility.
Nothing is written, routed or dispatched.`;

/** Offline. Output goes through the injected writers; defaults are console.log / console.error. */
export async function cmdFleetCodingSample(
  args: string[],
  out?: (line: string) => void,
  err?: (line: string) => void,
): Promise<number> {
  return runCodingEvidenceCli({
    args,
    usage: USAGE,
    maxBytes: CODING_SAMPLE_MAX_EVIDENCE_BYTES,
    errorClass: PosteriorSamplingError,
    evaluate: (raw) => reportPosteriorSample(parsePosteriorSampleEvidence(raw)),
    out,
    err,
  });
}
