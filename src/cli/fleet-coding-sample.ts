/**
 * `phm fleet coding-sample --evidence <file>`: print one seeded offline posterior draw as JSON.
 * Offline and read-only. The only input is the one explicit evidence file the caller names.
 * There is no home, config, session or environment discovery, no network, no process
 * launches and no disk writes. The sample is a modelled score. It is not observed
 * performance and grants no execution authority or eligibility.
 */
import { readFileSync, statSync } from 'node:fs';

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
    if (stat.size > CODING_SAMPLE_MAX_EVIDENCE_BYTES) {
      err(`error: evidence file exceeds ${CODING_SAMPLE_MAX_EVIDENCE_BYTES} bytes`);
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
    out(JSON.stringify(reportPosteriorSample(parsePosteriorSampleEvidence(raw)), null, 2));
    return 0;
  } catch (cause) {
    if (cause instanceof PosteriorSamplingError) {
      err(`error: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}
