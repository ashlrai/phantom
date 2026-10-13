/** Mounts the setup wizard's chunk only while it is open (first paint stays lean). */
import { lazy, Suspense } from 'react';
import { useSetupWizard } from './useSetupWizard.js';

const SetupWizard = lazy(() => import('./SetupWizard.js'));

export function SetupWizardGate() {
  const { open } = useSetupWizard();
  return open ? (
    <Suspense fallback={null}>
      <SetupWizard />
    </Suspense>
  ) : null;
}
