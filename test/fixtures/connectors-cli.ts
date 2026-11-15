// Re-entry point for connector exec tests: `<node> --import tsx this connectors <verb> ...`.
import { cmdConnectors } from '../../src/cli/connectors.js';

void cmdConnectors(process.argv.slice(3)).then(code => { process.exitCode = code; });
