/** `phm tools parity|requires`: thin argv layer over core/fleet/tool-parity.ts. */
export const TOOLS_USAGE = `Usage: phm tools parity [--text]
       phm tools requires --needs <need,...> [--text]
Needs: github-read, github-write, web-search, browser, shell, package-install, mcp:<server>.
JSON by default. Unknown means no source declares it; it never counts as missing.
requires exits 0 when some lane is not declared to lack a need, 1 when every lane is, 2 on bad usage.`;

export async function cmdTools(args: string[]): Promise<number> {
  if (!args.length || args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(TOOLS_USAGE); return 0; }
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
