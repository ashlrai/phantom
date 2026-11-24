import { BROWSER_ACTIONS, runBrowser, type BrowserAction, type BrowserDeps } from '../core/browser-control.js';

const usage = `Usage: phm browser [tabs] [--json]
       phm browser doctor [--json]
       phm browser open <url> [--json]
       phm browser shot [<path.png>] [--json]
       phm browser close [--json]
  Safari is Phantom's own agent browser. tabs lists the open agent tabs and the latest
  screenshot. open loads an http or https address in a new Safari tab. shot saves a
  picture of the front Safari window (and keeps a copy for the desktop Browser card).
  close closes every Safari window; it does not quit Safari.
  doctor says in plain words whether Safari remote automation is on and the one step
  to turn it on. Phantom never changes system settings, and anything it cannot read
  says unknown. Safari only: --browser chrome, a Chrome address or a Chrome profile
  path is refused. Phantom never reads cookies or saved passwords.
  open, shot and close are logged to the feed. KILL and comms pause block open and close.
  Exit: 0 done, 1 refused or failed, 2 usage.`;

export async function cmdBrowser(args: string[], deps: BrowserDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  let browser: string | undefined;
  const at = rest.indexOf('--browser');
  if (at !== -1) { browser = rest[at + 1]; rest.splice(at, 2); }
  const [action = 'tabs', value] = rest;
  const takes = action === 'open' ? [2, 2] : action === 'shot' ? [1, 2] : [0, 1];
  if (!BROWSER_ACTIONS.some(a => a === action) || rest.length < takes[0]! || rest.length > takes[1]! || rest.some(a => a.startsWith('-')) || (at !== -1 && !browser)) {
    process.stderr.write(`${usage}\n`); return 2;
  }
  const result = await runBrowser({ action: action as BrowserAction, browser,
    ...(action === 'open' ? { url: value } : {}), ...(action === 'shot' && value ? { path: value } : {}) }, deps);
  out(json ? JSON.stringify(result.report) : result.text);
  return result.exit;
}
