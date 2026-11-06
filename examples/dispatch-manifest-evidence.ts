/**
 * Read dispatch intent from an explicitly selected, private manifest directory:
 * npx tsx examples/dispatch-manifest-evidence.ts --manifest-events-dir /absolute/store/dispatch-manifests
 * Optional: --max-rows N bounds the scan; inspect sourceQuality for truncation.
 */
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDispatchManifestEventsDetailed } from '../src/core/fleet/dispatch-manifest.js';
import { summarizeDispatchManifestEvidence } from '../src/core/fleet/dispatch-manifest-summary.js';

const usage = 'Usage: tsx examples/dispatch-manifest-evidence.ts --manifest-events-dir /absolute/store/dispatch-manifests [--max-rows N]';

export function main(args: string[]) {
  let directory: string | undefined;
  let maxRows: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[++i];
    if (arg === '--manifest-events-dir' && directory === undefined && value && isAbsolute(value)) {
      directory = resolve(value);
    } else if (arg === '--max-rows' && maxRows === undefined && value && /^[1-9]\d*$/.test(value)) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed > 1_000_000) throw new Error(usage);
      maxRows = parsed;
    } else {
      throw new Error(usage);
    }
  }
  if (!directory || basename(directory) !== 'dispatch-manifests') throw new Error(usage);

  // The existing reader selects its store through ASHLR_HOME. Restore it even
  // if reading fails; this synchronous example must not leak its selection.
  const previousHome = process.env.ASHLR_HOME;
  try {
    process.env.ASHLR_HOME = dirname(directory);
    const summary = summarizeDispatchManifestEvidence(readDispatchManifestEventsDetailed({ inspectionOnly: true, maxRows }));
    const result = {
      intentOnly: true as const,
      guidance: 'Consult fleet workers and job evidence to establish actual launches; manifest assignments record intent only.',
      summary,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (previousHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = previousHome;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
