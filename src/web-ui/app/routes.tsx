/**
 * app/routes.tsx — the route table. Driven by NAV_GROUPS
 * (app/nav-config.ts) so every nav leaf resolves to *something* real:
 * FleetDashboardView for the one implemented leaf, PlaceholderView for
 * everything else. Two illustrative param routes (/work/runs/:id,
 * /work/swarms/:id) exist to prove deep-linking with a resource id works
 * end-to-end even before those views are built — that's the pattern a view
 * agent follows: add the real component, delete the placeholder route.
 *
 * ROUTING STRATEGY — hash-based (react-router-dom's HashRouter), on
 * purpose: src/core/web/static.ts (which this foundation must not modify)
 * only special-cases the literal "/" to resolve to index.html; every other
 * path is resolved as a literal file and 404s if it doesn't exist. A
 * pushState router would 404 on refresh or on a pasted deep link for any
 * route but "/". Hash routing sidesteps this entirely — the hash never
 * reaches the server — while still giving real hierarchical, bookmarkable,
 * shareable URLs (`#/work/runs/r_123`), which is what the foundation brief
 * actually asked for ("real client-side routing with deep links, not just
 * hash-to-view"). See DESIGN.md "Routing" for the full rationale and what
 * changes here once the legacy app is retired and server.ts gains a real
 * SPA catch-all.
 */
import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from '../components/layout/Shell.js';
import { PlaceholderView } from '../routes/PlaceholderView.js';
import { NAV_GROUPS, ALL_NAV_LEAVES } from './nav-config.js';

const DecisionInbox = lazy(() => import('../routes/verse/inbox/DecisionInbox.js').then((module) => ({ default: module.DecisionInbox })));
const FleetDashboardView = lazy(() => import('../routes/fleet-dashboard/FleetDashboardView.js').then((module) => ({ default: module.FleetDashboardView })));
const ShowView = lazy(() => import('../routes/show/ShowView.js').then((module) => ({ default: module.ShowView })));
const JournalView = lazy(() => import('../routes/journal/JournalView.js').then((module) => ({ default: module.JournalView })));
const PulseView = lazy(() => import('../routes/intelligence/pulse/PulseView.js').then((module) => ({ default: module.PulseView })));
const GenomeView = lazy(() => import('../routes/intelligence/genome/GenomeView.js').then((module) => ({ default: module.GenomeView })));
const ProductionView = lazy(() => import('../routes/intelligence/production/ProductionView.js').then((module) => ({ default: module.ProductionView })));
const PortfolioView = lazy(() => import('../routes/portfolio/PortfolioView.js').then((module) => ({ default: module.PortfolioView })));
const WorklogView = lazy(() => import('../routes/work/worklog/WorklogView.js').then((module) => ({ default: module.WorklogView })));
const RunsView = lazy(() => import('../routes/work/runs/RunsView.js').then((module) => ({ default: module.RunsView })));
const RunDetailView = lazy(() => import('../routes/work/runs/RunDetailView.js').then((module) => ({ default: module.RunDetailView })));
const SessionsView = lazy(() => import('../routes/work/sessions/SessionsView.js').then((module) => ({ default: module.SessionsView })));
const SwarmsView = lazy(() => import('../routes/work/swarms/SwarmsView.js').then((module) => ({ default: module.SwarmsView })));
const SwarmDetailView = lazy(() => import('../routes/work/swarms/SwarmDetailView.js').then((module) => ({ default: module.SwarmDetailView })));
const DaemonView = lazy(() => import('../routes/control/daemon/DaemonView.js').then((module) => ({ default: module.DaemonView })));
const FleetView = lazy(() => import('../routes/control/fleet/FleetView.js').then((module) => ({ default: module.FleetView })));
const SecurityView = lazy(() => import('../routes/control/security/SecurityView.js').then((module) => ({ default: module.SecurityView })));
const GoalsView = lazy(() => import('../routes/goals/GoalsView.js').then((module) => ({ default: module.GoalsView })));
const InboxView = lazy(() => import('../routes/inbox/InboxView.js').then((module) => ({ default: module.InboxView })));
const ApprovalsView = lazy(() => import('../routes/approvals/ApprovalsView.js').then((module) => ({ default: module.ApprovalsView })));
const AgentOsView = lazy(() => import('../routes/agent-os/AgentOsView.js').then((module) => ({ default: module.AgentOsView })));
const ConnectView = lazy(() => import('../routes/connect/ConnectView.js').then((module) => ({ default: module.ConnectView })));
const UniverseView = lazy(() => import('../routes/universe/UniverseView.js').then((module) => ({ default: module.UniverseView })));
const ConnectorsSettings = lazy(() => import('../routes/settings/connectors/ConnectorsView.js').then((module) => ({ default: module.ConnectorsSettings })));

const SecretsView = lazy(() => import('../routes/settings/secrets/SecretsView.js').then(module => ({ default: module.SecretsView })));

const TeamInviteAccept = lazy(() => import('../routes/TeamInviteAccept.js').then((module) => ({ default: module.TeamInviteAccept })));

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/teams/:team/accept" element={<TeamInviteAccept />} />
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/overview" replace />} />
        {ALL_NAV_LEAVES.map((leaf) =>
          leaf.implemented ? null : (
            <Route
              key={leaf.path}
              path={leaf.path}
              element={<PlaceholderView title={leaf.label} description={leaf.description} />}
            />
          ),
        )}
        <Route path="/connect" element={<ConnectView />} />
        <Route path="/settings/secrets" element={<SecretsView />} />
        <Route path="/settings/connectors" element={<ConnectorsSettings />} />
        <Route path="/overview" element={<FleetDashboardView />} />
        <Route path="/approvals" element={<ApprovalsView />} />
        <Route path="/agent-os" element={<AgentOsView />} />
        <Route path="/universe" element={<UniverseView />} />
        <Route path="/show" element={<ShowView />} />
        <Route path="/journal" element={<JournalView />} />
        <Route path="/intelligence/pulse" element={<PulseView />} />
        <Route path="/intelligence/genome" element={<GenomeView />} />
        <Route path="/intelligence/production" element={<ProductionView />} />
        <Route path="/portfolio" element={<PortfolioView />} />
        <Route path="/work/log" element={<WorklogView />} />
        <Route path="/work/runs" element={<RunsView />} />
        <Route path="/work/runs/:id" element={<RunDetailView />} />
        <Route path="/work/sessions" element={<SessionsView />} />
        <Route path="/work/swarms" element={<SwarmsView />} />
        <Route path="/work/swarms/:id" element={<SwarmDetailView />} />
        <Route path="/control/daemon" element={<DaemonView />} />
        <Route path="/control/fleet" element={<FleetView />} />
        <Route path="/control/security" element={<SecurityView />} />
        <Route path="/goals" element={<GoalsView />} />
        <Route path="/verse/inbox" element={<DecisionInbox />} />
        <Route path="/inbox" element={<InboxView />} />
        <Route path="/inbox/:id" element={<InboxView />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}

// Referenced by tests / DESIGN.md to assert every group's leaves round-trip
// through this route table without a manual re-listing.
export { NAV_GROUPS };
