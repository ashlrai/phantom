/** `phm node capacity` and `phm node route` (RQ-NODE-AUTOSCALE-1). Thin: parse argv, delegate to core. */
import { nodeErrorEnvelope } from './node-fleet-usage.js';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { computeNodeCapacity, NODE_CAPACITY_SCHEMA, parseNodeCapacityDoc, type NodeCapacityDoc } from '../core/drive/nodes/capacity-model.js';
import { measureNode } from '../core/drive/nodes/node-measure.js';
import { planAutoscaleRoutes, type HarnessModelCost, type LaneOutcomes, type RouteJob, type RouteNode } from '../core/drive/nodes/autoscale-router.js';
import { readRouteLaneOutcomes, type RouteLaneOutcomes } from '../core/drive/nodes/route-outcomes.js';

export const NODE_CAPACITY_USAGE = `Usage: phm node capacity [--node <id>] [--out <file>] [--previous <file>] [--json]
       phm node route --capacity <file> [--capacity <file>...] --costs <file> --jobs <file> [--outcomes <file>] [--outcomes-ledger] [--runs-dir <dir>] [--nodes <file>] [--exhausted <provider[,provider]>] [--json]

capacity measures this node (CPU, memory, swap, swap growth, per-harness session footprint)
and prints agents runnable now per harness. --out writes the document atomically (mode 0600);
the previous document (default: --out) supplies swap growth and learned footprints.
route scores (node, provider, model) per job from capacity documents, a cost/latency file
and lane outcomes. --outcomes is a hand-maintained {provider: {attempts, merged}} file;
--outcomes-ledger derives the same tallies from <runs-dir>/metrics/jobs.jsonl
(default ASHLR_RUNS_DIR, then ~/.ashlr-runs) and --outcomes entries win per provider.
Both are local and read-only apart from --out: no network, no launches.`;

const MAX_INPUT = 1024 * 1024;

function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && i + 1 < args.length) out.push(args[++i]!);
  return out;
}

function validate(args: string[], valued: string[], bare: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i]!)) { if (i + 1 >= args.length || args[i + 1]!.startsWith('--')) return `${args[i]} needs a value`; i++; continue; }
    if (!bare.includes(args[i]!)) return `unknown argument ${args[i]}`;
  }
  return null;
}

async function readJsonFile(path: string): Promise<unknown> {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT) throw new Error(`${path} is not a regular file under 1 MiB`);
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}

/** Atomic replace in the target's own directory; never follows a symlink at the target. */
export async function writeCapacityDoc(path: string, doc: NodeCapacityDoc): Promise<void> {
  const target = resolve(path);
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isFile()) throw new Error(`${path} exists and is not a regular file`);
  const temp = join(dirname(target), `.node-capacity-${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`); } finally { await handle.close(); }
    await rename(temp, target);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

function fail(command: string, json: boolean, message: string, code = 2, kind: { code: string; fix: string } = { code: 'usage', fix: 'Run: phm node --help for the command list.' }): number {
  if (json) console.log(JSON.stringify(nodeErrorEnvelope(command, { code: kind.code, message, fix: kind.fix })));
  else console.error(message);
  return code;
}

export async function cmdNodeCapacity(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const problem = validate(args, ['--node', '--out', '--previous'], ['--json']);
  if (problem) return fail('capacity', json, `${problem}\n${NODE_CAPACITY_USAGE}`);
  const node = flagValues(args, '--node')[0];
  if (node !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/.test(node)) return fail('capacity', json, 'invalid --node id');
  const out = flagValues(args, '--out')[0];
  const previousPath = flagValues(args, '--previous')[0] ?? out;
  let previous: NodeCapacityDoc | null = null;
  if (previousPath) previous = parseNodeCapacityDoc(await readJsonFile(previousPath).catch(() => null));
  const snapshot = await measureNode(node ? { node } : {});
  const doc = computeNodeCapacity(snapshot, previous);
  if (out) {
    try { await writeCapacityDoc(out, doc); } catch { return fail('capacity', json, `could not write ${out}; check the directory exists and is writable`, 1, { code: 'unavailable', fix: 'Check the --out directory exists, is writable and is not a symlink.' }); }
  }
  if (json) { console.log(JSON.stringify(doc)); return 0; }
  const gib = (n: number | null) => n === null ? 'unknown' : `${(n / 1024 ** 3).toFixed(1)} GiB`;
  console.log(`node ${doc.node} at ${doc.measured_at} (process source: ${doc.basis.process_source})`);
  console.log(`cpu: ${doc.cpu.cores} cores, busy ${doc.cpu.busy_percent ?? 'unknown'}%, load ${doc.cpu.load_1m ?? '?'}, headroom ${doc.cpu.headroom_cores ?? 'unknown'} cores`);
  console.log(`memory: free ${doc.mem_free.free_percent ?? 'unknown'}%, pressure level ${doc.mem_free.pressure_level ?? 'unknown'}, headroom ${gib(doc.mem_free.headroom_bytes)}`);
  console.log(`swap: used ${gib(doc.swap.used_bytes)}, swapouts/min ${doc.swap.swapouts_per_min ?? 'unknown'}`);
  for (const [harness, n] of Object.entries(doc.agents_runnable_now)) {
    const fp = doc.per_harness_footprint[harness];
    console.log(`  ${harness}: runnable ${n ?? 'unknown'} (${doc.basis.limiting[harness]})${fp ? `, ${fp.sessions} live, ${gib(fp.mem_bytes_max)} per session [${fp.source}]` : ''}`);
  }
  for (const note of doc.basis.notes) console.log(`note: ${note}`);
  return 0;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');

export async function cmdNodeRoute(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const problem = validate(args, ['--capacity', '--costs', '--jobs', '--outcomes', '--runs-dir', '--nodes', '--exhausted'], ['--json', '--outcomes-ledger']);
  if (problem) return fail('route', json, `${problem}\n${NODE_CAPACITY_USAGE}`);
  const runsDir = flagValues(args, '--runs-dir')[0];
  if (runsDir !== undefined && !args.includes('--outcomes-ledger')) {
    return fail('route', json, '--runs-dir only applies with --outcomes-ledger\n' + NODE_CAPACITY_USAGE);
  }
  const capacity = flagValues(args, '--capacity'), costsPath = flagValues(args, '--costs')[0], jobsPath = flagValues(args, '--jobs')[0];
  if (!capacity.length || !costsPath || !jobsPath) return fail('route', json, `--capacity, --costs and --jobs are required\n${NODE_CAPACITY_USAGE}`);
  try {
    const docs = await Promise.all(capacity.map(async p => {
      const doc = parseNodeCapacityDoc(await readJsonFile(p));
      if (!doc) throw new Error(`${p} is not a ${NODE_CAPACITY_SCHEMA} document`);
      return doc;
    }));
    const costs = await readJsonFile(costsPath), jobs = await readJsonFile(jobsPath);
    if (!Array.isArray(costs) || !costs.every(c => record(c) && typeof c.provider === 'string' && typeof c.model === 'string' &&
        typeof c.harness === 'string' && typeof c.tokensPerJob === 'number' && typeof c.minutesPerJob === 'number')) {
      throw new Error('--costs must be an array of {provider, model, harness, tokensPerJob, minutesPerJob, local?}');
    }
    if (!Array.isArray(jobs) || !jobs.every(j => record(j) && typeof j.id === 'string' &&
        (j.providers === undefined || strings(j.providers)) && (j.models === undefined || strings(j.models)))) {
      throw new Error('--jobs must be an array of {id, providers?, models?, tokenWeight?}');
    }
    const outcomesRaw = flagValues(args, '--outcomes')[0] ? await readJsonFile(flagValues(args, '--outcomes')[0]!) : {};
    if (!record(outcomesRaw)) throw new Error('--outcomes must be an object of {provider: {attempts, merged}}');
    let ledger: RouteLaneOutcomes | null = null;
    if (args.includes('--outcomes-ledger')) {
      ledger = await readRouteLaneOutcomes(runsDir === undefined ? {} : { runsDir });
      if (ledger.state === 'unreadable' || ledger.state === 'not-file') {
        return fail('route', json, `jobs ledger ${ledger.path} state=${ledger.state}; --outcomes-ledger needs a readable metrics/jobs.jsonl`, 2,
          { code: 'invalid-input', fix: 'Point --runs-dir at the directory holding metrics/jobs.jsonl, or drop --outcomes-ledger.' });
      }
    }
    // Ledger tallies are the base; explicit --outcomes entries win per provider.
    const outcomes = { ...(ledger?.outcomes ?? {}), ...(outcomesRaw as Record<string, LaneOutcomes>) };
    const meta = flagValues(args, '--nodes')[0] ? await readJsonFile(flagValues(args, '--nodes')[0]!) : {};
    if (!record(meta)) throw new Error('--nodes must be an object of {node: {providers?, localModels?, overheadMinutes?}}');
    const nodes: RouteNode[] = docs.map(doc => {
      const m = record(meta[doc.node]) ? meta[doc.node] as Record<string, unknown> : {};
      return { doc, ...(strings(m.providers) ? { providers: m.providers } : {}), ...(strings(m.localModels) ? { localModels: m.localModels } : {}),
        ...(typeof m.overheadMinutes === 'number' ? { overheadMinutes: m.overheadMinutes } : {}) };
    });
    const exhausted = flagValues(args, '--exhausted').flatMap(v => v.split(',')).filter(Boolean);
    const plan = planAutoscaleRoutes({ nodes, costs: costs as HarnessModelCost[], jobs: jobs as RouteJob[],
      outcomes, exhausted, nowMs: Date.now() });
    if (json) {
      console.log(JSON.stringify({ schema: 'phantom.node-route.v1', plan,
        ...(ledger ? { outcomes_ledger: { state: ledger.state, truncated: ledger.truncated, path: ledger.path,
          providers: Object.keys(ledger.outcomes).length } } : {}) }));
    } else {
      if (ledger) console.log(`lane outcomes: ${ledger.path} state=${ledger.state} providers=${Object.keys(ledger.outcomes).length} truncated=${ledger.truncated}`);
      for (const p of plan) {
        console.log(p.nodeId ? `${p.jobId} -> ${p.nodeId} ${p.provider}/${p.model} score ${p.score} (merge ${p.mergeRate}, ${p.mergesPerMTok}/Mtok, ${p.mergesPerHour}/h)`
          : `${p.jobId}: unplaced ${JSON.stringify(p.rejected)}`);
      }
    }
    return 0;
  } catch (error) {
    return fail('route', json, error instanceof Error ? error.message : 'route failed', 2,
      { code: 'invalid-input', fix: 'Check each input file is the JSON shape phm node --help documents for --capacity, --costs, --jobs, --outcomes and --nodes.' });
  }
}
