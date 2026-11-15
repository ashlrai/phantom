/** Engine seam for the routines CLI: one lazy re-export keeps the Tier-1
 * sandboxed-engine module out of routine tests' mock specifiers. */
export { runEngineSandboxed, runApiModelSandboxed } from '../core/run/sandboxed-engine.js';
