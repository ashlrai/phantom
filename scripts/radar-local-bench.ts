import process from 'node:process';
import console from 'node:console';
import { runLocalBench } from '../src/core/radar/local-bench.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: npx tsx scripts/radar-local-bench.ts [options]

Loopback-only local-model bench: scores candidate small models on the
triage, routing and CI-failure bucketing fixtures against the incumbent
local tier, and writes an ashlr.radar-local-bench.v1 results file whose
devCycleDashboard block records estimated dollars saved per 100 jobs.

Options:
  --base-url URL     Model endpoint (MUST be loopback; default http://127.0.0.1:11434)
  --models A,B       Candidate tags (default lfm3:1.7b,d1:2b)
  --incumbent TAG    Baseline arm (default qwen3.8:27b-ctx64k)
  --fixtures DIR     Fixture directory (default test/fixtures/radar-local-bench)
  --out FILE         Results path (default benchmarks/radar-local-bench-<ts>.json)
  --timeout-ms N     Per-call timeout (default 30000, max 600000)

Non-loopback endpoints are refused before any request or file write.`);
  process.exitCode = 0;
} else {
  process.exitCode = await runLocalBench(argv);
}
