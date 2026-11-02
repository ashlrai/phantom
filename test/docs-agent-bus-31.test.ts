/**
 * Regression test: docs/AGENT-BUS.md exists and contains the key
 * contract details that an agent or contributor needs.
 */
import { strictEqual } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __DIR__ = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__DIR__, '..');
const DOC_PATH  = join(ROOT, 'docs', 'AGENT-BUS.md');
const README_PATH = join(ROOT, 'docs', 'README.md');

function readDoc(): string {
  strictEqual(existsSync(DOC_PATH), true, 'docs/AGENT-BUS.md must exist');
  return readFileSync(DOC_PATH, 'utf8');
}

function readReadme(): string {
  strictEqual(existsSync(README_PATH), true, 'docs/README.md must exist');
  return readFileSync(README_PATH, 'utf8');
}

function run(): void {
  const doc = readDoc();
  const readme = readReadme();

  // Route paths
  strictEqual(doc.includes('/api/verse/agent-bus'), true,
    'must contain the agent-bus route path');
  strictEqual(doc.includes('/api/verse/agent-bus/status'), true,
    'must contain the /status route path');

  // Six envelope field names
  const fields = ['id', 'from', 'to', 'priority', 'ttl', 'body'];
  for (const field of fields) {
    strictEqual(doc.includes(field), true,
      `must mention envelope field: ${field}`);
  }

  // Three cap numbers (1024, 1 MiB, 100)
  strictEqual(doc.includes('1024'), true, 'must mention 1024 message cap');
  strictEqual(doc.includes('MiB'), true, 'must mention 1 MiB byte cap');
  strictEqual(doc.includes('100'), true, 'must mention 100 per-read cap');

  // README links to AGENT-BUS.md
  strictEqual(readme.includes('AGENT-BUS.md'), true,
    'docs/README.md must link AGENT-BUS.md');
}

run();
