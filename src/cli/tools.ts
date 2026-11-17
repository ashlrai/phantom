/** `phm tools [--json] [--lane L]` and `phm tools parity|requires`: thin argv layer over core/fleet/tool-parity.ts. */
export const TOOLS_USAGE = `Usage: phm tools [--json] [--lane <lane>]
       phm tools parity [--text]
       phm tools requires --needs <need,...> [--text]
phm tools: which lane has which tool (MCP servers, CLIs, skills, plugins, GitHub,
web search, browser, computer use), a parity score per lane and the top 3 gaps
with a fix. Read-only: it never installs, enables or changes a tool.
Needs: github-read, github-write, web-search, browser, computer-use, shell, package-install, mcp:|cli:|skill:|plugin:<name>.
parity and requires print JSON by default. Unknown means no source declares it; it never counts as missing.
requires exits 0 when some lane is not declared to lack a need, 1 when every lane is, 2 on bad usage.
phm tools --lane exits 2 for a lane no source names.`;

export async function cmdTools(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(TOOLS_USAGE); return 0; }
  if (!args.length || args[0]!.startsWith('--')) return toolsMatrix(args);
  const [verb, ...rest] = args;
  const text = rest.includes('--text');
  const flags = rest.filter(a => a !== '--text' && a !== '--json');
  let needsText: string | undefined;
  if (verb === 'requires') {
    if (flags.length !== 2 || flags[0] !== '--needs' || flags[1]!.startsWith('--')) { console.error(TOOLS_USAGE); return 2; }
    needsText = flags[1];
  } else if (verb !== 'parity' || flags.length) { console.error(TOOLS_USAGE); return 2; }

  const core = await import('../core/fleet/tool-parity.js');
  const parsed = needsText === undefined ? null : core.parseToolNeeds(needsText);
  if (parsed && 'error' in parsed) { console.error(text ? parsed.error : JSON.stringify({ error: parsed.error })); return 2; }
  const report = await core.loadToolParity();
  if (!parsed) { console.log(text ? core.formatToolParity(report) : JSON.stringify(report, null, 2)); return 0; }
  const result = core.toolRequires(report, parsed.needs);
  console.log(text ? core.formatToolRequires(result) : JSON.stringify(result, null, 2));
  return result.can.length || result.unproven.length ? 0 : 1;
}

async function toolsMatrix(args: string[]): Promise<number> {
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
  const matrix = core.buildToolMatrix(report, lane);
  if (!matrix) {
    const known = report.lanes.map(l => l.lane).join(', ') || 'none';
    const error = `No lane "${lane!.slice(0, 40)}". Known lanes: ${known}.`;
    console.error(json ? JSON.stringify({ error }) : error);
    return 2;
  }
  console.log(json ? JSON.stringify(matrix, null, 2) : core.formatToolMatrix(matrix, lane));
  return 0;
}
