/**
 * Shared offline CLI runner for coding-CLI commands that read one explicit
 * `--evidence <file>` JSON payload and emit one JSON report.
 *
 * Read-only: reads only the explicit regular file within `maxBytes`, never
 * echoes raw file content on parse errors, and writes nothing to disk.
 */
import { readFileSync, statSync } from 'node:fs';

export interface CodingEvidenceCliOptions<TError extends Error> {
  args: string[];
  usage: string;
  maxBytes: number;
  errorClass: new (...args: never[]) => TError;
  evaluate: (raw: unknown) => unknown;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Parse `--evidence <file>`, read bounded JSON, evaluate, and print formatted JSON. */
export function runCodingEvidenceCli<TError extends Error>(options: CodingEvidenceCliOptions<TError>): number {
  const {
    args,
    usage,
    maxBytes,
    errorClass,
    evaluate,
    out = (line: string) => console.log(line),
    err = (line: string) => console.error(line),
  } = options;

  if (args.includes('--help') || args.includes('-h')) {
    out(usage);
    return 0;
  }

  let evidencePath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--evidence') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err(`error: --evidence requires a file path\n${usage}`);
        return 2;
      }
      if (evidencePath !== null) {
        err(`error: --evidence given more than once\n${usage}`);
        return 2;
      }
      evidencePath = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      err(`error: unknown flag ${JSON.stringify(arg)}\n${usage}`);
      return 2;
    } else {
      err(`error: unexpected argument ${JSON.stringify(arg)}\n${usage}`);
      return 2;
    }
  }
  if (evidencePath === null) {
    err(`error: --evidence <file> is required\n${usage}`);
    return 2;
  }

  let raw: unknown;
  try {
    const stat = statSync(evidencePath);
    if (!stat.isFile()) {
      err('error: evidence path is not a regular file');
      return 1;
    }
    if (stat.size > maxBytes) {
      err(`error: evidence file exceeds ${maxBytes} bytes`);
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
    out(JSON.stringify(evaluate(raw), null, 2));
    return 0;
  } catch (cause) {
    if (cause instanceof errorClass) {
      err(`error: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}
