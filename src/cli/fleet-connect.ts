/** List fleet connections, their state, who uses them and the next setup step. */
import { buildConnectList, CONNECT_KINDS, formatConnectList, isConnectKind, type ConnectKind, type ConnectReaders } from '../core/fleet/connect-list.js';

const usage = `Usage: phm fleet connect list [--json] [--kind <kind>]
Everything the fleet can plug into, one row each: name, kind, state (on, off,
broken, unknown), last used, who uses it and the next step when it is not on.
Read-only. It reads the same sources as phm channels, phm connectors, phm plugins,
phm skills and phm tools, and never reads or prints a credential: a row that
needs one says "needs sign-in". JSON schema phantom.connect.v1. Exit 0 success/help, 2 bad usage.
Kinds: ${CONNECT_KINDS.join('|')}.`;
export const CONNECT_USAGE = usage;

export async function cmdFleetConnect(args: string[], readers?: Partial<ConnectReaders>): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(CONNECT_USAGE); return 0; }
  let json = false;
  let kind: ConnectKind | undefined;
  for (let i = args[0] === 'list' ? 1 : 0; i < args.length; i++) {
    const a = args[i]!;
    const value = args[i + 1];
    if (a === '--json') json = true;
    else if (a === '--kind' && kind === undefined && isConnectKind(value)) { kind = value; i++; }
    else { console.error(CONNECT_USAGE); return 2; }
  }
  const list = await buildConnectList({ kind, readers });
  console.log(json ? JSON.stringify(list, null, 2) : formatConnectList(list));
  return 0;
}
