/** Validate saved real-browser badge rectangles; this never operates a browser. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
assert(path, 'Pass one synthetic rendered layout JSON receipt');
const evidence = JSON.parse(readFileSync(path, 'utf8'));
const { width, height } = evidence.viewport ?? {};
assert(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0, 'Finite positive viewport required');
assert(Array.isArray(evidence.badges) && evidence.badges.length > 0 && evidence.badges.length <= 200, 'Bounded nonempty badge inventory required');
assert(Array.isArray(evidence.status) && evidence.status.length === 1, 'One visible status required');
const findings = [];
for (const box of [...evidence.badges, ...evidence.status]) {
  const name = box.label ?? 'status';
  if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite) || box.left >= box.right || box.top >= box.bottom) {
    findings.push(`${name}: malformed rectangle`);
    continue;
  }
  if (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height) findings.push(`${name}: clipped by viewport`);
}
function overlaps(a, b) {
  return Math.max(a.left, b.left) < Math.min(a.right, b.right) && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
}
for (let i = 0; i < evidence.badges.length; i++) {
  const badge = evidence.badges[i];
  for (const other of evidence.badges.slice(i + 1)) {
    if (overlaps(badge, other)) findings.push(`${badge.label}/${other.label}: overlapping labels`);
  }
  if (overlaps(badge, evidence.status[0])) findings.push(`${badge.label}: obscured by status`);
}
console.log(JSON.stringify({ receipt: path, badges: evidence.badges.length, findings, ok: findings.length === 0 }, null, 2));
assert.equal(findings.length, 0, 'All rendered labels and status must remain visible and distinct');
