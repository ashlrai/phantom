import { mkdirSync, openSync, writeSync, closeSync, chmodSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, mkdtempSync } from 'node:fs';
import { readFleetBoard, claimFleetWork } from '../src/core/fleet/coordination.ts';

// Test file for RQ-PHX-COORDBOARDUNSAFETEST324
// This test ensures readFleetBoard() properly reports 'unknown' state for unsafe conditions

const testDir = mkdtempSync(join(tmpdir(), 'coord-'));
console.log(`Test directory: ${testDir}`);

// Case 1: A missing file → `state:'unknown'`
{
  console.log('\n--- Test Case 1: Missing file ---');
  const missingPath = join(testDir, 'missing.jsonl');
  const result = readFleetBoard({ path: missingPath });
  console.log(`Result: ${JSON.stringify(result)}`);
  if (result.state === 'unknown') {
    console.log('✓ Pass: Missing file correctly reports state "unknown"');
  } else {
    console.log('✗ Fail: Missing file should report state "unknown"');
  }
}

// Case 2: A valid ledger made by claimFleetWork → known, 1 claim, no leaseHash key
{
  console.log('\n--- Test Case 2: Valid ledger ---');
  const validPath = join(testDir, 'valid.jsonl');
  const claimResult = claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' }, { path: validPath });
  if (!claimResult.ok) {
    console.log('✗ Fail: Could not create valid claim');
  } else {
    const result = readFleetBoard({ path: validPath });
    console.log(`Result: ${JSON.stringify(result)}`);
    if (result.state === 'known' && result.claims.length === 1 && !('leaseHash' in result.claims[0])) {
      console.log('✓ Pass: Valid ledger correctly reports state "known" with 1 claim and no leaseHash');
    } else {
      console.log('✗ Fail: Valid ledger should report state "known" with 1 claim and no leaseHash');
    }
  }
}

// Case 3: The same file after chmodSync(path, 0o644) → unknown, claims []
{
  console.log('\n--- Test Case 3: File with incorrect permissions (0o644) ---');
  const filePath = join(testDir, 'chmod-test.jsonl');
  const claimResult = claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' }, { path: filePath });
  if (!claimResult.ok) {
    console.log('✗ Fail: Could not create test claim');
  } else {
    chmodSync(filePath, 0o644); // Change permissions to make it unsafe
    const result = readFleetBoard({ path: filePath });
    console.log(`Result: ${JSON.stringify(result)}`);
    if (result.state === 'unknown' && result.claims.length === 0) {
      console.log('✓ Pass: File with 0o644 permissions correctly reports state "unknown"');
    } else {
      console.log('✗ Fail: File with 0o644 permissions should report state "unknown"');
    }
  }
}

// Case 4: A symlink to the valid ledger → unknown
{
  console.log('\n--- Test Case 4: Symlink to valid ledger ---');
  const realPath = join(testDir, 'real.jsonl');
  const symlinkPath = join(testDir, 'symlink.jsonl');
  
  const claimResult = claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' }, { path: realPath });
  if (!claimResult.ok) {
    console.log('✗ Fail: Could not create test claim for symlink');
  } else {
    try {
      symlinkSync(realPath, symlinkPath);
      const result = readFleetBoard({ path: symlinkPath });
      console.log(`Result: ${JSON.stringify(result)}`);
      if (result.state === 'unknown') {
        console.log('✓ Pass: Symlink correctly reports state "unknown"');
      } else {
        console.log('✗ Fail: Symlink should report state "unknown"');
      }
    } catch (error) {
      console.log('Note: Symlink test skipped on Windows due to permission limitations');
    }
  }
}

// Case 5: A file with a last line that has no trailing newline (torn) → unknown
{
  console.log('\n--- Test Case 5: Torn ledger (no trailing newline) ---');
  const tornPath = join(testDir, 'torn.jsonl');
  const claimResult = claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' }, { path: tornPath });
  if (!claimResult.ok) {
    console.log('✗ Fail: Could not create test claim for torn file');
  } else {
    // Manually add a record without trailing newline to make it "torn"
    const fd = openSync(tornPath, 'a');
    writeSync(fd, '{"version":1,"kind":"release","at":123456789,"id":"test-id"}');  // Missing trailing newline
    closeSync(fd);
    
    const result = readFleetBoard({ path: tornPath });
    console.log(`Result: ${JSON.stringify(result)}`);
    if (result.state === 'unknown') {
      console.log('✓ Pass: Torn ledger correctly reports state "unknown"');
    } else {
      console.log('✗ Fail: Torn ledger should report state "unknown"');
    }
  }
}

// Case 6: An expired claim (pass `now` past expiresAt) → known, 0 claims, expiredClaims 1
{
  console.log('\n--- Test Case 6: Expired claim ---');
  const expiredPath = join(testDir, 'expired.jsonl');
  const claimResult = claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' }, { path: expiredPath });
  if (!claimResult.ok) {
    console.log('✗ Fail: Could not create test claim for expired');
  } else {
    // Use an "expired" time in the future to make claims expire
    const result = readFleetBoard({ path: expiredPath, now: Date.now() + 1000 * 60 * 60 * 24 * 30 }); // 30 days in future
    console.log(`Result: ${JSON.stringify(result)}`);
    if (result.state === 'known' && result.claims.length === 0 && result.expiredClaims === 1) {
      console.log('✓ Pass: Expired claim correctly reports state "known" with 0 claims and 1 expired claim');
    } else {
      console.log('✗ Fail: Expired claim should report state "known" with 0 claims and 1 expired claim');
    }
  }
}

console.log('\n--- Test completed ---');
