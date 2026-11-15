/** Executable fleet entry: keep convention subcommands out of authority imports. */
import { cmdFleet as dispatchFleet } from './fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from './fleet-subcommand-registry.js';

export function cmdFleet(args: string[]): Promise<number> {
  return dispatchFleet(args, FLEET_SUBCOMMAND_LOADERS);
}

export * from './fleet.js';
