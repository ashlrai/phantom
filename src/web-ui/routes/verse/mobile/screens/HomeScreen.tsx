/**
 * routes/verse/mobile/screens/HomeScreen.tsx — Home's frame: the title, the
 * New-agent button, pull-to-refresh, and skeletons in the shape of the cards.
 *
 * FIRST PAINT (SPEC-310A's arrangement, as the workbench's Chat section does
 * it): this frame is the phone app's first-paint root, measured by
 * scripts/check-first-paint-budget.mjs against 250 KB — React alone is
 * ~220 KB of that. The glance (HomeGlance.tsx) is a preloaded chunk: its download starts when this module
 * evaluates, in parallel with the session probe, and it renders synchronously
 * once in. On a warm launch (service worker cache) that is the same frame.
 * Everything below the title is HomeGlance's four parts: fleet health, approvals, a message box and what shipped today.
 */
import { PRODUCT_NAME } from '../../../../app/product-brand.js';
import { Suspense } from 'react';
import { preloadedLazy } from '../../shell/preloaded.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { PlusGlyph } from '../mobile-icons.js';
import { Button, Screen, SkeletonList } from '../ui.js';

const loadBody = () => import('./HomeGlance.js');
const Body = preloadedLazy<object>(() => loadBody().then((m) => m.HomeGlance));

/** Drawn until the four parts arrive. */
export function HomeSkeleton() {
  return <SkeletonList rows={4} label="Loading Home" />;
}

export function HomeScreen() {
  const { permissions, navigate, refreshActivity } = useMobile();
  const canAct = canShowActions(permissions);
  const onRefresh = () => Promise.all([refreshActivity(), loadBody().then((m) => m.refreshHomeGlance())]);
  return (
    <Screen
      title={PRODUCT_NAME}
      large
      subtitle={permissions.act === 'unavailable' ? 'Read-only on this device' : undefined}
      onRefresh={onRefresh}
      trailing={canAct ? (
        <Button variant="plain" icon aria-label="New agent" onClick={() => navigate({ screen: 'new' })}>
          <PlusGlyph size={22} />
        </Button>
      ) : null}
    >
      <Suspense fallback={<HomeSkeleton />}>
        <Body.Slot />
      </Suspense>
    </Screen>
  );
}
