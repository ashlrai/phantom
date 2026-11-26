/** `phm desktop self <verb>` — Phantom sees and drives its own window (core/verse/self-surface-agent.ts). */
export const DESKTOP_SELF_USAGE = `usage: phm desktop self snapshot|screenshot|navigate|act|check [--json]
  snapshot                         route, landmarks, controls and stable ids of the current screen
  screenshot [--include-image]     PNG of the webview, written 0600; bytes only with --include-image
  navigate --section <id> [--anchor <id>]
  act --test-id <id> [--action click|focus]
  check [--update-baseline]        open each main screen; flag console errors, slow loads, layout drift
navigate, act and check post a bus intent first and stop under KILL or comms pause.
See docs/DESKTOP-OPERATOR.md#self-surface.`;

export async function cmdDesktopSelf(args: string[], out: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const [verb, ...rest] = args;
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h' || rest.includes('--help') || rest.includes('-h')) { out(DESKTOP_SELF_USAGE); return verb ? 0 : 2; }
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--json' || flag === '--include-image' || flag === '--update-baseline') { flags[flag] = true; continue; }
    if (['--section', '--anchor', '--test-id', '--action'].includes(flag) && rest[i + 1] && !rest[i + 1]!.startsWith('--')) { flags[flag] = rest[++i]!; continue; }
    console.error(DESKTOP_SELF_USAGE); return 2;
  }
  const agent = await import('../core/verse/self-surface-agent.js');
  let result: unknown;
  switch (verb) {
    case 'snapshot': result = await agent.sendSelfRequest({ verb }); break;
    case 'screenshot': result = await agent.sendSelfRequest({ verb, ...(flags['--include-image'] ? { includeImage: true } : {}) }); break;
    case 'navigate':
      if (typeof flags['--section'] !== 'string') { console.error(DESKTOP_SELF_USAGE); return 2; }
      result = await agent.sendSelfRequest({ verb, section: flags['--section'], ...(typeof flags['--anchor'] === 'string' ? { anchor: flags['--anchor'] } : {}) });
      break;
    case 'act':
      if (typeof flags['--test-id'] !== 'string') { console.error(DESKTOP_SELF_USAGE); return 2; }
      result = await agent.sendSelfRequest({ verb, testId: flags['--test-id'], action: typeof flags['--action'] === 'string' ? flags['--action'] : 'click' });
      break;
    case 'check': result = await agent.runSelfCheck({ updateBaseline: flags['--update-baseline'] === true }); break;
    default: console.error(DESKTOP_SELF_USAGE); return 2;
  }
  const ok = (result as { ok?: boolean }).ok === true;
  if (flags['--json']) out(JSON.stringify(result));
  else if ('screens' in (result as object)) {
    for (const screen of (result as { screens: Array<{ section: string; ok: boolean; flags: string[]; loadMs: number | null }> }).screens) {
      out(`${screen.ok ? 'ok  ' : 'FLAG'} ${screen.section}${screen.loadMs === null ? '' : ` ${screen.loadMs} ms`}${screen.flags.length ? `: ${screen.flags.join('; ')}` : ''}`);
    }
  } else out(ok ? JSON.stringify((result as { data: unknown }).data, null, 2) : `self-surface: ${(result as { error: string }).error}`);
  return ok ? 0 : 1;
}
