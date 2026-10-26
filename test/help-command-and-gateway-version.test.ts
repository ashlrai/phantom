/**
 * `phm help doctor` names a command, not a topic: it shows that command's
 * rows instead of failing as an unknown topic. The MCP gateway reports
 * Phantom's real version in serverInfo/clientInfo, not a 0.1.0 placeholder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cmdHelp } from '../src/cli/help.js';
import { gatewayVersion } from '../src/core/mcp-gateway.js';

afterEach(() => { vi.restoreAllMocks(); });

function captureLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  return lines;
}

describe('phm help <command>', () => {
  it('shows the rows for a command name instead of an unknown-topic error', async () => {
    const lines = captureLog();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdHelp(['doctor'])).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('One-glance health check');
    expect(text).toContain('phm help core');
    expect(err).not.toHaveBeenCalled();
  });

  it('topics still win over command names', async () => {
    const lines = captureLog();
    expect(await cmdHelp(['run'])).toBe(0);
    expect(lines.join('\n')).toContain('--estimate');
  });
});

describe('MCP gateway serverInfo', () => {
  it('reports the package version, not a placeholder', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
    expect(gatewayVersion()).toBe(process.env.ASHLR_VERSION?.trim() || pkg.version);
    expect(gatewayVersion()).not.toBe('0.1.0');
  });
});
