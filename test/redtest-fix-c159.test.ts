/**
 * RQ-PHX-REDTESTFIXC159: regression pin for the #5050 bridge fix.
 *
 * #5050 made src/core/comms/leader-mailbox.ts (already a Tier-1 authority
 * closure member) runtime-import the new src/core/comms/local-mailbox-receipts.ts,
 * which joined the closure — but the snapshot in
 * test/fixtures/authority/tier1-closure.json was not regenerated, so
 * test/authority-tier1-closure-310b.test.ts failed while typecheck stayed green.
 *
 * This pins both halves of the corrected state through the real code path:
 *   1. leader-mailbox.ts keeps a runtime (not type-only) import of the receipts
 *      module, parsed with the TypeScript compiler — no string matching.
 *   2. The regenerated snapshot actually names the new member.
 *   3. A live createLeaderMailbox().accept() for an iMessage owner message
 *      writes the durable receipt the dedupe path exists to produce.
 *
 * Hermetic: writes only under mkdtemp; reads repo files read-only.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLeaderMailbox, type LeaderMailboxMessage } from '../src/core/comms/leader-mailbox.js';
import { localMailboxReceiptId } from '../src/core/comms/local-mailbox-receipts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAILBOX = 'src/core/comms/leader-mailbox.ts';
const RECEIPTS = 'src/core/comms/local-mailbox-receipts.ts';

/** True when `file` has a runtime import of `specifier` (mirrors the closure test's rules). */
function importsAtRuntime(file: string, specifier: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === specifier) {
      const clause = node.importClause;
      const allTypeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined && clause !== null && !clause.name &&
          clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!allTypeOnly) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

let runsDir: string;
const msg = (): LeaderMailboxMessage => ({
  channel: 'imessage',
  senderId: 'synthetic-sender-c159',
  text: 'synthetic c159 request',
  idempotencyKey: 'key-c159',
  receivedAt: Date.UTC(2026, 0, 5, 6, 7, 8),
});

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'redtest-c159-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('RQ-PHX-REDTESTFIXC159 (#5050 closure fix)', () => {
  it('leader-mailbox runtime-imports the receipts module', () => {
    expect(importsAtRuntime(join(ROOT, MAILBOX), './local-mailbox-receipts.js')).toBe(true);
  });

  it('the regenerated Tier-1 snapshot names the receipts module', () => {
    const snapshot = JSON.parse(
      readFileSync(join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json'), 'utf8'),
    ) as { closure: string[] };
    expect(snapshot.closure).toContain(RECEIPTS);
    expect(snapshot.closure).toContain(MAILBOX);
  });

  it('a live imessage accept writes the durable dedupe receipt', async () => {
    const message = msg();
    const receipt = await createLeaderMailbox({ runsDir }).accept(message);
    expect(receipt.status).toBe('accepted');
    const dir = join(runsDir, 'leader', '.mailbox-receipts');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    expect(files).toEqual([`${localMailboxReceiptId(message)}.json`]);
  });
});
