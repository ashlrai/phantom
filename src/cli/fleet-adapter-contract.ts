/**
 * `phm fleet adapter-contract [id] [--json]`: print the historical coding-CLI
 * command templates from PR #5952. Static data only: no process, filesystem,
 * environment, network or model access. Placeholders below are plainly fake.
 */
import {
  ADAPTER_CONTRACT_SOURCE,
  listAdapters,
  type CodingCliAdapter,
} from '../core/providers/coding-cli/adapter-contract.js';

export const FLEET_ADAPTER_CONTRACT_SCHEMA = 'fleet.adapter-contract.v1';
export const FLEET_ADAPTER_CONTRACT_NOTICE =
  'historical contract; availability and account eligibility unknown';

const FAKE_GOAL = 'FAKE-GOAL-PLACEHOLDER';
const FAKE_CWD = '/fake/cwd-placeholder';
const FAKE_MODEL = 'fake-model-placeholder';
const BIN_PLACEHOLDER = '<bin>';

const USAGE = `Usage: phm fleet adapter-contract [adapter-id] [--json]
Print the historical coding-CLI command templates recovered from PR #5952. Static output only;
nothing is run, probed or read, and availability and account eligibility are unknown.
Adapter ids: codex, claude, grok, devin, cursor, ollama.`;

export interface AdapterContractEntry {
  id: string;
  billing: string;
  capabilities: CodingCliAdapter['capabilities'];
  versionArgs: readonly string[];
  statusArgs: readonly string[] | null;
  /** Null when the historical adapter has no headless exec. */
  verifyArgsTemplate: readonly string[] | null;
  /** Empty for historical stubs. */
  execArgsTemplate: readonly string[];
  execArgsTemplateNoModel: readonly string[];
  stub: boolean;
}

export interface AdapterContractReport {
  schema: typeof FLEET_ADAPTER_CONTRACT_SCHEMA;
  source: typeof ADAPTER_CONTRACT_SOURCE;
  notice: string;
  availability: 'unknown';
  placeholders: { goal: string; cwd: string; model: string; bin: string };
  adapters: AdapterContractEntry[];
}

/** Pure: no catalog input exists here, so billing is reported as unreported and bins as templates. */
export function buildAdapterContractReport(): AdapterContractReport {
  const backends = Object.fromEntries(
    ['codex', 'claude', 'grok', 'devin', 'cursor', 'ollama'].map((id) => [id, { bin: null, billing: 'unreported' }]),
  );
  const adapters = listAdapters(backends).map((a): AdapterContractEntry => ({
    id: a.id,
    billing: a.billing,
    capabilities: a.capabilities,
    versionArgs: a.versionArgs,
    statusArgs: a.statusArgs,
    verifyArgsTemplate: a.verifyArgs ? a.verifyArgs(FAKE_MODEL) : null,
    execArgsTemplate: a.execArgs(FAKE_GOAL, FAKE_CWD, FAKE_MODEL),
    execArgsTemplateNoModel: a.execArgs(FAKE_GOAL, FAKE_CWD, null),
    stub: a.execArgs(FAKE_GOAL, FAKE_CWD, null).length === 0,
  }));
  return {
    schema: FLEET_ADAPTER_CONTRACT_SCHEMA,
    source: ADAPTER_CONTRACT_SOURCE,
    notice: FLEET_ADAPTER_CONTRACT_NOTICE,
    availability: 'unknown',
    placeholders: { goal: FAKE_GOAL, cwd: FAKE_CWD, model: FAKE_MODEL, bin: BIN_PLACEHOLDER },
    adapters,
  };
}

const show = (args: readonly string[] | null): string => (args === null ? 'null (none)' : args.length === 0 ? '[] (empty)' : JSON.stringify(args));

function renderHuman(report: AdapterContractReport, out: (line: string) => void): void {
  out(`Coding CLI adapter contract (PR #${report.source.pr} @ ${report.source.head.slice(0, 12)})`);
  out(`Notice: ${report.notice}`);
  for (const a of report.adapters) {
    out('');
    out(`${a.id}${a.stub ? ' [stub: no workspace exec]' : ''}`);
    out(`  billing (reported): ${a.billing}`);
    out(`  editInWorkspace=${a.capabilities.editInWorkspace} headless=${a.capabilities.headless}`);
    out(`  version: ${show(a.versionArgs)}`);
    out(`  status:  ${show(a.statusArgs)}`);
    out(`  verify:  ${show(a.verifyArgsTemplate)}`);
    out(`  exec:    ${show(a.execArgsTemplate)}`);
  }
}

/** Offline. Output goes through the injected writers; defaults are console.log / console.error. */
export async function cmdFleetAdapterContract(
  args: string[],
  out: (line: string) => void = (line) => console.log(line),
  err: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }
  let json = false;
  let selector: string | null = null;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) {
      err(`error: unknown flag ${JSON.stringify(arg)}\n${USAGE}`);
      return 2;
    } else if (selector === null) selector = arg;
    else {
      err(`error: unexpected extra argument ${JSON.stringify(arg)}\n${USAGE}`);
      return 2;
    }
  }
  const full = buildAdapterContractReport();
  let report = full;
  if (selector !== null) {
    const match = full.adapters.filter((a) => a.id === selector);
    if (match.length === 0) {
      err(`error: unknown adapter id ${JSON.stringify(selector)}; supported: ${full.adapters.map((a) => a.id).join(', ')}`);
      return 2;
    }
    report = { ...full, adapters: match };
  }
  if (json) out(JSON.stringify(report, null, 2));
  else renderHuman(report, out);
  return 0;
}
