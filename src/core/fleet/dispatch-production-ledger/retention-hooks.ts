/** Shared retention test hooks and stable file assurance. */

import {
  type StableFileBatchAssuranceResult,
  assureStableRegularFiles,
} from '../../util/stable-file-read.js';

interface DispatchProductionLedgerRetentionHooksForTest {
  afterAttemptReceiptIntentAssured?: (path: string) => void;
  afterAttemptRetentionMarker?: () => void;
  afterFailureAttemptAppend?: () => void;
  afterTreatmentCompactedMarkers?: () => void;
  afterDispatchReadPass?: (path: string) => void;
  assureStableRegularFiles?: (
    paths: string[],
    anchorPath: string,
  ) => StableFileBatchAssuranceResult;
}

export let dispatchProductionLedgerRetentionHooksForTest:
  DispatchProductionLedgerRetentionHooksForTest | undefined;

export function _setDispatchProductionLedgerRetentionHooksForTest(
  hooks: DispatchProductionLedgerRetentionHooksForTest | undefined,
): void {
  dispatchProductionLedgerRetentionHooksForTest = hooks;
}

export function assureRetentionFiles(
  paths: string[],
  anchorPath: string,
): StableFileBatchAssuranceResult {
  return (dispatchProductionLedgerRetentionHooksForTest?.assureStableRegularFiles ??
    assureStableRegularFiles)(paths, anchorPath);
}
