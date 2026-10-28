import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as ledger from '../src/core/fleet/dispatch-production-ledger.js';
import * as constantsModule from '../src/core/fleet/dispatch-production-ledger/constants.js';
import * as storageModule from '../src/core/fleet/dispatch-production-ledger/storage.js';
import * as treatmentReceiptsModule from '../src/core/fleet/dispatch-production-ledger/treatment-receipts.js';
import * as eventsModule from '../src/core/fleet/dispatch-production-ledger/events.js';
import * as writeModule from '../src/core/fleet/dispatch-production-ledger/write.js';
import * as retentionHooksModule from '../src/core/fleet/dispatch-production-ledger/retention-hooks.js';
import * as attemptRetentionModule from '../src/core/fleet/dispatch-production-ledger/attempt-retention.js';
import * as attemptProofsModule from '../src/core/fleet/dispatch-production-ledger/attempt-proofs.js';
import * as attemptResolutionModule from '../src/core/fleet/dispatch-production-ledger/attempt-resolution.js';
import * as readModule from '../src/core/fleet/dispatch-production-ledger/read.js';
import * as yieldModule from '../src/core/fleet/dispatch-production-ledger/yield.js';

describe('dispatch production ledger compatibility barrel', () => {
  afterEach(() => ledger._setDispatchProductionLedgerRetentionHooksForTest(undefined));

  it('keeps implementation modules bounded and independent of their compatibility barrel', () => {
    const directory = new URL('../src/core/fleet/dispatch-production-ledger/', import.meta.url);
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      expect(source.trimEnd().split('\n').length, file).toBeLessThan(2000);
      expect(source, file).not.toMatch(/from\s+['"]\.\.\/dispatch-production-ledger\.js['"]/);
    }
  });

  it('preserves exactly the existing runtime exports and their implementation identities', () => {
    const expected = {
      DISPATCH_PRODUCTION_INVALID_REASON_CODES: constantsModule.DISPATCH_PRODUCTION_INVALID_REASON_CODES,
      dispatchProductionDir: storageModule.dispatchProductionDir,
      hasExactDispatchProductionTreatmentOutcomeReceipt: treatmentReceiptsModule.hasExactDispatchProductionTreatmentOutcomeReceipt,
      withDispatchProductionGenerationAuthority: storageModule.withDispatchProductionGenerationAuthority,
      dispatchProductionRunStatusForOutcome: eventsModule.dispatchProductionRunStatusForOutcome,
      canonicalDispatchRepoIdentity: eventsModule.canonicalDispatchRepoIdentity,
      sanitizeDispatchProductionEvent: eventsModule.sanitizeDispatchProductionEvent,
      materializeDispatchProductionAttemptEnvelope: eventsModule.materializeDispatchProductionAttemptEnvelope,
      recordDispatchProduction: writeModule.recordDispatchProduction,
      _setDispatchProductionLedgerRetentionHooksForTest: retentionHooksModule._setDispatchProductionLedgerRetentionHooksForTest,
      readDispatchProductionAttemptProtocolQuality: attemptRetentionModule.readDispatchProductionAttemptProtocolQuality,
      readDispatchProductionParents: storageModule.readDispatchProductionParents,
      currentAuthoritativeDispatchProductionLearningLabel: attemptProofsModule.currentAuthoritativeDispatchProductionLearningLabel,
      resolveDispatchProductionFailureAttemptReceipt: attemptResolutionModule.resolveDispatchProductionFailureAttemptReceipt,
      readDispatchProductionFailureAttemptReceipts: attemptResolutionModule.readDispatchProductionFailureAttemptReceipts,
      resolveDispatchProductionAttemptProofs: attemptResolutionModule.resolveDispatchProductionAttemptProofs,
      resolveDispatchProductionAttemptWitnesses: attemptResolutionModule.resolveDispatchProductionAttemptWitnesses,
      resolveDispatchProductionAttemptReceiptWitnesses: attemptResolutionModule.resolveDispatchProductionAttemptReceiptWitnesses,
      readDispatchProductionAttemptReceiptAvailability: attemptResolutionModule.readDispatchProductionAttemptReceiptAvailability,
      readDispatchProductionEventsDetailed: readModule.readDispatchProductionEventsDetailed,
      readDispatchProductionEvents: readModule.readDispatchProductionEvents,
      isCancelledDispatchProductionEvent: yieldModule.isCancelledDispatchProductionEvent,
      canonicalDispatchProductionAttempts: yieldModule.canonicalDispatchProductionAttempts,
      summarizeDispatchProductionYield: yieldModule.summarizeDispatchProductionYield,
      readDispatchProductionYieldDetailed: yieldModule.readDispatchProductionYieldDetailed,
      readDispatchProductionYield: yieldModule.readDispatchProductionYield,
    };
    expect(Object.keys(ledger).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, implementation] of Object.entries(expected)) {
      expect(ledger[name as keyof typeof ledger], name).toBe(implementation);
    }
  });

  it('shares retention hook state between the legacy entry point and receipt modules', () => {
    const hooks = { afterAttemptRetentionMarker: () => undefined };
    ledger._setDispatchProductionLedgerRetentionHooksForTest(hooks);
    expect(retentionHooksModule.dispatchProductionLedgerRetentionHooksForTest).toBe(hooks);
    retentionHooksModule._setDispatchProductionLedgerRetentionHooksForTest(undefined);
    expect(retentionHooksModule.dispatchProductionLedgerRetentionHooksForTest).toBeUndefined();
  });
});
