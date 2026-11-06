/**
 * test/docs-self-update-31.test.ts — asserts that docs/SELF-UPDATE.md
 * exists, is under 90 lines, and mentions every field and concept
 * specified in the Oct 31 priority.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DOC_PATH = join(__dirname, '..', 'docs', 'SELF-UPDATE.md');

const ALL_FIELDS = [
  'sourceState', 'installedVersion', 'repoRoot', 'headSha', 'processHeadSha',
  'headAt', 'originSha', 'branch', 'behind', 'ahead', 'dirty',
  'lastFetchAt', 'processStartedAt', 'uptimeSeconds', 'pid', 'canFastForward',
];
const OUTCOMES = ['updated', 'already-current', 'refused', 'failed'];
const RESTART_MODES = ['sidecar-supervised', 'manual'];
const NOTIFICATION_IDS = ['update-ready', 'update-held', 'update-failed', 'update-restart-needed', 'update-applied'];
const APPLY_STEPS = ['status', 'fetch', 'ahead', 'update'];
const UI_LOCATIONS = [
  'Settings', 'About', 'gear badge', 'NotificationBell',
  'update-ready', 'update-held', 'update-failed', 'update-restart-needed', 'update-applied',
];
const REFUSAL_CONDITIONS = ['dirty tree', 'diverged', 'not a git checkout'];

function docContent(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function docLines(): string[] {
  return docContent().split('\n').filter((l) => l.trim());
}

describe('docs/SELF-UPDATE.md', () => {
  it('exists', () => {
    assert.ok(readFileSync(DOC_PATH, 'utf8').length > 0, 'SELF-UPDATE.md should exist and be non-empty');
  });

  it('is under 90 lines', () => {
    const lines = docLines();
    assert.ok(lines.length < 90, `doc has ${lines.length} lines, must be under 90`);
  });

  for (const field of ALL_FIELDS) {
    it(`mentions field: ${field}`, () => {
      const content = docContent();
      assert.ok(content.includes(field), `doc should mention ${field}`);
    });
  }

  for (const outcome of OUTCOMES) {
    it(`mentions outcome: ${outcome}`, () => {
      const content = docContent();
      assert.ok(content.includes(outcome), `doc should mention outcome "${outcome}"`);
    });
  }

  for (const mode of RESTART_MODES) {
    it(`mentions restart mode: ${mode}`, () => {
      const content = docContent();
      assert.ok(content.includes(mode), `doc should mention restart mode "${mode}"`);
    });
  }

  it('mentions every notification ID', () => {
    const content = docContent();
    for (const id of NOTIFICATION_IDS) {
      assert.ok(content.includes(id), `doc should mention notification ID "${id}"`);
    }
  });

  it('mentions apply step names', () => {
    const content = docContent();
    for (const step of APPLY_STEPS) {
      assert.ok(content.includes(step), `doc should mention apply step "${step}"`);
    }
  });

  it('mentions the four refusal conditions', () => {
    const content = docContent();
    for (const cond of REFUSAL_CONDITIONS) {
      assert.ok(content.includes(cond), `doc should mention refusal condition "${cond}"`);
    }
  });

  it('mentions all UI locations', () => {
    const content = docContent();
    for (const loc of UI_LOCATIONS) {
      assert.ok(content.includes(loc), `doc should mention "${loc}"`);
    }
  });

  it('links docs/README.md index entries', () => {
    const content = docContent();
    // Verify the page links to index entries (SELF-HOSTING.md and QUICKSTART.md are in README)
    assert.ok(content.includes('SELF-HOSTING.md'), 'doc should link SELF-HOSTING.md');
    assert.ok(content.includes('QUICKSTART.md'), 'doc should link QUICKSTART.md');
  });
});
