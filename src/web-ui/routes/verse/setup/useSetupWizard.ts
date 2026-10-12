import { useSyncExternalStore } from 'react';
import { getSetupWizardState, subscribeSetupWizard } from './setup-wizard-store.js';

export function useSetupWizard() {
  return useSyncExternalStore(subscribeSetupWizard, getSetupWizardState, getSetupWizardState);
}
