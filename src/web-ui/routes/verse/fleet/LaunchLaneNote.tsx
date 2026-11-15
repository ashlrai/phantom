export function LaunchLaneNote({ requestedLane, launchedLane, laneReason }: {
  requestedLane?: string | null; launchedLane?: string | null; laneReason?: string | null;
}) {
  if (!requestedLane && !launchedLane) return null;
  if (!requestedLane || !launchedLane || requestedLane === launchedLane) return <p>Lane: {launchedLane ?? requestedLane}</p>;
  return <p>Asked: {requestedLane}, Ran on: {launchedLane} — {laneReason || 'reason not recorded'}</p>;
}
