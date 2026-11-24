/** `phm tools [--json] [--lane L]`, `phm tools parity [--json] [--lane L]` and `phm tools requires`: thin argv layer over core/fleet/tool-parity.ts. */
export const TOOLS_USAGE = `Usage: phm tools [--json] [--lane <lane>]
       phm tools parity [--json] [--lane <lane>]
       phm tools requires --needs <need,...> [--text]
phm tools: which lane has which tool (MCP servers, CLIs, skills, plugins, GitHub,
web search, browser, computer use), a parity score per lane and the top 3 gaps
with a fix. Read-only: it never installs, enables or changes a tool.
Needs: github-read, github-write, web-search, browser, computer-use, shell, package-install, mcp:|cli:|skill:|plugin:<name>.
phm tools parity: one row per lane, one column per tool family (MCP servers, CLI on PATH,
skills, plugins, web search, browser, computer use, gh), each present, missing or unknown
with its source, and one fix line per missing cell.
requires prints JSON by default. Unknown means no source declares it; it never counts as missing.
requires exits 0 when some lane is not declared to lack a need, 1 when every lane is, 2 on bad usage.
--lane exits 2 for a lane no source names.`;

export async function cmdTools(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(TOOLS_USAGE); return 0; }
  if (!args.length || args[0]!.startsWith('--')) return toolsView(args, 'matrix');
  const [verb, ...rest] = args;
  // --text was the old way to ask for the table; it is now the default.
  if (verb === 'parity') return toolsView(rest.filter(a => a !== '--text'), 'parity');
  const text = rest.includes('--text');
  const flags = rest.filter(a => a !== '--text' && a !== '--json');
  if (verb !== 'requires' || flags.length !== 2 || flags[0] !== '--needs' || flags[1]!.startsWith('--')) { console.error(TOOLS_USAGE); return 2; }

  const core = await import('../core/fleet/tool-parity.js');
  const parsed = core.parseToolNeeds(flags[1]!);
  if ('error' in parsed) { console.error(text ? parsed.error : JSON.stringify({ error: parsed.error })); return 2; }
  const result = core.toolRequires(await core.loadToolParity(), parsed.needs);
  console.log(text ? core.formatToolRequires(result) : JSON.stringify(result, null, 2));
  return result.can.length || result.unproven.length ? 0 : 1;
}

/** `phm tools` (tools by lane, with scores) and `phm tools parity` (lanes by tool family) share flags and exit codes. */
async function toolsView(args: string[], view: 'matrix' | 'parity'): Promise<number> {
  let json = false;
  let lane: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--lane' && args[i + 1] && !args[i + 1]!.startsWith('--') && lane === undefined) lane = args[++i];
    else { console.error(TOOLS_USAGE); return 2; }
  }
  const core = await import('../core/fleet/tool-parity.js');
  const report = await core.loadToolParity();
  const parity = view === 'parity' ? core.buildLaneParity(report, lane) : null;
  const matrix = view === 'matrix' ? core.buildToolMatrix(report, lane) : null;
  if (!parity && !matrix) {
    const lanes = view === 'parity' ? core.buildLaneParity(report)!.lanes.map(l => l.lane) : report.lanes.map(l => l.lane);
    const error = `No lane "${lane!.slice(0, 40)}". Known lanes: ${lanes.join(', ') || 'none'}.`;
    console.error(json ? JSON.stringify({ error }) : error);
    return 2;
  }
  if (json) console.log(JSON.stringify(parity ?? matrix, null, 2));
  else console.log(parity ? core.formatLaneParity(parity) : core.formatToolMatrix(matrix!, lane));
  return 0;
}
