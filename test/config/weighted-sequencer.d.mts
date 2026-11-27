/** Authoring-only declaration for weighted-sequencer.mjs; the .mjs stays the runtime module. */
import { BaseSequencer, type TestSpecification } from 'vitest/node';

export declare const CALIBRATION_INPUTS: readonly string[];

export interface CalibrationInventoryModule {
  file: string;
  project: string;
  sha256: string;
}

export interface CalibrationInventory {
  schema: 'phantom-partition-inventory/v1';
  source: { revision: string; tree: string };
  collectionSource: { revision: string; tree: string };
  collectionState: 'observed';
  runtime: {
    platform: string;
    nodeVersion: string;
    vitestVersion: string;
    configSha256: string;
  };
  modules: CalibrationInventoryModule[];
}

export declare function calibrationInventory(
  root: string,
  specs: TestSpecification[],
): Promise<CalibrationInventory>;

export declare class WeightedCalibrationSequencer extends BaseSequencer {}
