/**
 * The current shell reaps Verse and its PTYs on exit. Do not map restart to
 * quit/open until runtime ownership and durable reattachment are implemented.
 */
const APP_RESTART_HELD = {
  schema: 'phantom-app-restart/v1',
  state: 'held',
  restarted: false,
  reason: 'runtime-ownership-migration-required',
  blockers: [
    'verse-sidecar-owned-by-ui',
    'interactive-sessions-and-ptys-owned-by-sidecar',
    'computer-use-workers-owned-by-ui',
    'durable-ui-checkpoint-and-reattach-not-implemented',
  ],
} as const;

const USAGE = `usage: phm app restart --json

Reports a held restart (exit 1) while the native UI owns live runtime state.
Does not quit, signal processes, replace bundles, or resume authority.
See docs/APP-RESTART.md for the ownership audit and remaining implementation.
`;

export async function cmdApp(args: string[]): Promise<number> {
  if (args.length === 0 || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  if (args.length !== 2 || args[0] !== 'restart' || args[1] !== '--json') {
    console.error(USAGE);
    return 2;
  }
  console.log(JSON.stringify(APP_RESTART_HELD));
  return 1;
}
