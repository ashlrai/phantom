/** Executable fleet entry: keep convention subcommands out of authority imports. */
import { cmdFleet as dispatchFleet } from './fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from './fleet-subcommand-registry.js';

export function cmdFleet(args: string[]): Promise<number> {
  if (args[0] === 'lanes') {
    return import('./fleet-lanes.js').then(({ cmdFleetLanes }) => cmdFleetLanes(args.slice(1)));
  }
  return dispatchFleet(args, FLEET_SUBCOMMAND_LOADERS);
}

export * from './fleet.js';
